// @effect-diagnostics nodeBuiltinImport:off - tsc-rs is external to the CLI
// bundle and must load through createRequire inside a Node SEA; artifact
// hashes use node:crypto (same posture as PackStore.ts / NodePtyAdapter.ts).
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import {
  WatchWidgetBridgeManifest,
  WatchWidgetSourceError,
  type WatchWidgetSourceErrorReason,
  WatchWidgetSourceId,
  type WatchWidgetSourceGetInput,
  type WatchWidgetSourceGetResult,
  type WatchWidgetSourcePublishInput,
  type WatchWidgetSourcePublishResult,
  WatchWidgetSourceRecord,
  type WatchWidgetSourceSubscribeInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { Diagnostic, RawCompilerOptions } from "tsc-rs/unstable/async";

import * as ServerConfig from "../config.ts";

/**
 * Agent-authored widget pipeline: `publish` validates the bridge manifest,
 * transpiles the single-file TS/TSX source through a shared `tsc-rs`
 * compiler server into an IIFE artifact cached on disk by content hash, and
 * records the outcome as a `WatchWidgetSourceRecord`. A bad build is *data*,
 * not a call failure — the record's `transpileFailed` state is what the
 * widget shell renders; only manifest shape, source-size, and rate-limit
 * violations reject the call.
 *
 * Emitted code contract (the hardened host document owns the other half):
 * the artifact is a self-contained IIFE. `transpileModule` rewrites one
 * file; it never resolves specifiers. Compiling as CommonJS turns every
 * module form into detectable residue — static `import`/`export … from`,
 * `import x = require("y")`, and literal `import("y")` all lower to
 * `require(...)`/`exports.`/`module.exports` plumbing, while `import(expr)`
 * and `import.meta` survive verbatim — and output still containing any of
 * it is rejected, so a source can never smuggle filesystem contents into
 * the artifact or defer to modules that do not exist in the frame.
 * `</script` sequences are escaped to `<\/script` so the bundle cannot
 * close its own inline script tag; `scriptHash` covers the escaped bytes
 * actually served. JSX compiles to the `T3` host global (`T3.h`,
 * `T3.Fragment`), which the generated document defines before the bundle
 * runs.
 *
 * The artifact directory is bounded by count and byte caps: publishing a
 * new pair evicts the oldest pairs through the same removal path as
 * `remove` — files, cached record, tombstone — so the store cannot grow
 * without bound, and `get`/`publish` already tolerate missing files.
 */

export type TscRsModule = typeof import("tsc-rs/unstable/async");

// tsc-rs stays external to the CLI bundle: its JS API locates a
// per-platform `@tsc-rs/<os>-<arch>` binary on the real filesystem. Inside a
// Node SEA `import`/`import()` cannot reach file-backed packages, so — like
// node-pty — it loads through createRequire, which works in every runtime.
// The package is ESM, which `require()` loads through Node's require(esm)
// path (unflagged since Node 22.12, below our minimum engine).
const requireForTscRs = NodeModule.createRequire(import.meta.url);

const SOURCE_ID_PREFIX = "watch-widget-source:";

// The source id suffix is also the artifact filename: the strict hex shape
// is what makes a caller-supplied id incapable of naming a path outside the
// artifact directory. The `artifactHash` field carries the same constraint
// in `WatchWidgetSourceRecord` so a planted meta cannot reopen it.
const ARTIFACT_HASH_PATTERN = /^[0-9a-f]{64}$/;

const sourceError = (
  reason: WatchWidgetSourceErrorReason,
  message: string,
  options?: { readonly sourceId?: WatchWidgetSourceId; readonly cause?: unknown },
) =>
  new WatchWidgetSourceError({
    message,
    reason,
    ...(options?.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

// CSP `script-src` hash sources take the base64 digest form (`sha256-<b64>`).
const sha256Base64 = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("base64");

const ManifestJson = Schema.fromJsonString(WatchWidgetBridgeManifest);
const encodeManifestJson = Schema.encodeSync(ManifestJson);
const RecordJson = Schema.fromJsonString(WatchWidgetSourceRecord);
const encodeRecordJson = Schema.encodeSync(RecordJson);
const decodeRecordJson = Schema.decodeEffect(RecordJson);
const isSourceError = Schema.is(WatchWidgetSourceError);

// ── Transpiler seam ──────────────────────────────────────────────────────

export class WidgetTranspileError extends Schema.TaggedError<WidgetTranspileError>()(
  "WidgetTranspileError",
  {
    /**
     * `unavailable` marks the tsc-rs module or its platform binary as
     * missing/broken — latched by `makeTranspile` so later publishes fast-fail
     * instead of re-probing. `failed` is a per-source build diagnostic *or*
     * any other non-diagnostic rejection (a wedged compiler server, spawn
     * pressure); only the verifiably-permanent missing-binary signature
     * latches.
     */
    reason: Schema.Literals(["unavailable", "failed"]),
    detail: Schema.String,
  },
) {}

export class WidgetSourceTranspiler extends Context.Service<
  WidgetSourceTranspiler,
  {
    readonly transpile: (source: string) => Effect.Effect<string, WidgetTranspileError>;
  }
>()("t3/watch/WidgetTranspileService/WidgetSourceTranspiler") {}

/**
 * Latches the first `unavailable` transpile failure: a missing or mismatched
 * `@tsc-rs/*` platform binary cannot appear mid-process, so re-probing on
 * every publish would just fail the same way. Only that signature is
 * classified `unavailable` — transient compiler-server rejections and
 * per-source diagnostics are `failed` and pass through every time.
 */
export const makeTranspile = (
  build: (source: string) => Effect.Effect<string, WidgetTranspileError>,
) =>
  Effect.map(
    Ref.make<string | null>(null),
    (latch) => (source: string) =>
      Ref.get(latch).pipe(
        Effect.flatMap((latched) =>
          latched !== null
            ? Effect.fail(new WidgetTranspileError({ reason: "unavailable", detail: latched }))
            : build(source).pipe(
                Effect.tapError((error) =>
                  error.reason === "unavailable" ? Ref.set(latch, error.detail) : Effect.void,
                ),
              ),
        ),
      ),
  );

/**
 * `transpileModule` rewrites one file; it never resolves specifiers.
 * `module: CommonJS` is load-bearing for the residue scan below: every
 * import/export form compiles to `require(...)`/`exports.`/`module.exports`
 * plumbing — `import x = require("y")` is the case that silently vanishes
 * under `module: none` — so module syntax can never emit as a working
 * script that reached for a module the frame does not have. JSX lowers to
 * the host-provided T3 global.
 *
 * The enum members are RawCompilerOptions' wire values
 * (ScriptTarget.ES2022, ModuleKind.CommonJS, JsxEmit.React); keeping them
 * literal means `makeBuild`'s client never has to carry the enum exports.
 * `strict` is inert for `transpileModule` — it reports only parse/options
 * diagnostics, never semantic ones — but is kept so the option set matches
 * the tsconfig contract these sources are written against.
 */
const WIDGET_COMPILER_OPTIONS = {
  target: 9,
  module: 1,
  jsx: 2,
  jsxFactory: "T3.h",
  jsxFragmentFactory: "T3.Fragment",
  strict: true,
  removeComments: true,
} satisfies RawCompilerOptions;

/**
 * Module machinery in the emitted artifact means the source reached for a
 * module the widget frame does not have: a verbatim `import(` or
 * `import.meta`, CommonJS plumbing from lowered import/export forms
 * (`require(`, `exports.`, `module.exports`), or a `__require` shim. The
 * preceding-character check spares member lookups such as `foo.require(x)`.
 * Rather than ship a live module specifier in hash-authorized code,
 * `makeBuild` fails the build.
 */
const FORBIDDEN_ARTIFACT_PATTERN =
  /(?<![\w$.])(?:import\s*\(|import\.meta|require\s*\(|__require\b|exports\.|module\.exports\b)/g;

/** Extracts `"<specifier>"` from a `require("x")` for the failure detail. */
const REQUIRED_SPECIFIER_PATTERN = /(?<![\w$.])require\s*\(\s*["'`]([^"'`]+)["'`]/;

/**
 * `</script` in artifact bytes would close the host document's inline
 * script tag early — at best a dead widget under the CSP hash, at worst a
 * vector under a weaker embedding. `\/` is the same character as `/` to the
 * JS parser, so escaping is a runtime no-op. It runs in `publish` before
 * `scriptHash` is computed, so the hash covers the bytes actually served.
 */
const escapeScriptCloseTags = (text: string) => text.replace(/<\/script/gi, "<\\/script");

/**
 * The only non-diagnostic rejection worth latching `unavailable`: a missing
 * or mismatched `@tsc-rs/*` platform binary cannot appear mid-process. Its
 * signatures are `ENOENT` on the spawned binary and the wrapper's
 * `Unable to resolve @tsc-rs/<pkg>` / `Executable not found` messages.
 * Everything else — `EMFILE`/`EAGAIN` spawn pressure, a wedged compiler
 * server, a panic on pathological input — is a per-source `failed` so the
 * next publish retries cleanly.
 */
const MISSING_BINARY_PATTERN = /ENOENT|@tsc-rs\/|Executable not found/;

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The slice of the tsc-rs async API one widget build needs: a
 * `transpileModule` call on a long-lived `API` plus `formatDiagnostics` to
 * render its diagnostics. Kept narrow so tests can drive `makeBuild` and
 * `makeTranspilerLayer` with a fake.
 */
export interface WidgetTscRsClient {
  readonly transpileModule: (
    input: string,
    options: {
      readonly fileName: string;
      readonly reportDiagnostics: boolean;
      readonly compilerOptions: RawCompilerOptions;
    },
  ) => Promise<{
    readonly outputText: string;
    readonly diagnostics?: readonly Diagnostic[] | undefined;
  }>;
  readonly formatDiagnostics: (diagnostics: readonly Diagnostic[]) => string;
}

const formatDiagnostics = (client: WidgetTscRsClient, diagnostics: readonly Diagnostic[]) => {
  try {
    const formatted = client.formatDiagnostics(diagnostics).trim();
    return formatted === "" ? "tsc-rs transpile failed." : formatted;
  } catch {
    return "tsc-rs transpile failed.";
  }
};

const toTranspileError = (cause: unknown): WidgetTranspileError => {
  const detail = causeMessage(cause);
  return MISSING_BINARY_PATTERN.test(detail)
    ? new WidgetTranspileError({
        reason: "unavailable",
        detail: `The tsc-rs platform binary could not run: ${detail}.`,
      })
    : new WidgetTranspileError({
        reason: "failed",
        detail: `The widget transpile failed unexpectedly: ${detail}.`,
      });
};

/**
 * One source's transpile through the shared compiler client. There is no
 * per-request cancellation: interrupting the `tryPromise` (a
 * `transpileTimeoutMs` expiry or fiber interrupt) abandons the wait while
 * the request keeps running inside the shared server — a hung transpile can
 * stall the requests queued behind it, which surface as `failed` timeouts
 * rather than crashing the layer. Exported so tests can drive it with a
 * fake client.
 */
export const makeBuild =
  (client: WidgetTscRsClient) =>
  (source: string): Effect.Effect<string, WidgetTranspileError> =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.transpileModule(source, {
            fileName: "widget.tsx",
            reportDiagnostics: true,
            compilerOptions: WIDGET_COMPILER_OPTIONS,
          }),
        catch: toTranspileError,
      });
      // `transpileModule` still emits an outputText for a syntactically
      // broken source, so the diagnostics — parse and options errors — are
      // what make a bad build a failure instead of a broken artifact.
      if (result.diagnostics !== undefined && result.diagnostics.length > 0) {
        return yield* new WidgetTranspileError({
          reason: "failed",
          detail: formatDiagnostics(client, result.diagnostics),
        });
      }
      const forbidden = [...result.outputText.matchAll(FORBIDDEN_ARTIFACT_PATTERN)].map(
        (match) => match[0],
      );
      if (forbidden.length > 0) {
        const specifier = REQUIRED_SPECIFIER_PATTERN.exec(result.outputText)?.[1];
        return yield* new WidgetTranspileError({
          reason: "failed",
          detail:
            specifier === undefined
              ? `The emitted widget artifact still contains import or require forms (${[...new Set(forbidden)].map((form) => `"${form}"`).join(", ")}); widget sources are a single self-contained file. The artifact was rejected.`
              : `Widget sources are a single self-contained file; imports are not allowed ("${specifier}").`,
        });
      }
      // transpileModule emits loose top-level statements, but the artifact
      // contract is a self-contained IIFE so widget `var`/function
      // declarations cannot leak onto the host frame's window. The wrapper
      // is async so a stray top-level `await` still parses.
      return `(async () => {\n${result.outputText}\n})();\n`;
    });

const loadTscRs = Effect.try({
  try: () => requireForTscRs("tsc-rs/unstable/async") as TscRsModule,
  catch: (cause) =>
    new WidgetTranspileError({
      reason: "unavailable",
      detail: `The tsc-rs package could not be loaded: ${causeMessage(cause)}.`,
    }),
});

/**
 * One lazily-spawned compiler server shared by every publish. The module
 * require is the first probe (a missing tsc-rs package caches `unavailable`
 * through `Effect.cached` + `makeTranspile`'s latch); the first
 * `transpileModule` is the second — `API` connects to its child process on
 * first request, so a missing `@tsc-rs/<os>-<arch>` binary surfaces there.
 * Caching the client also dedupes concurrent first publishes onto a single
 * server. The API is closed when the layer's scope ends.
 */
export const makeTranspilerLayer = (
  tscRsModule: Effect.Effect<TscRsModule, WidgetTranspileError>,
) =>
  Layer.effect(
    WidgetSourceTranspiler,
    Effect.gen(function* () {
      const module = yield* Effect.cached(tscRsModule);
      const apiRef = yield* Ref.make<InstanceType<TscRsModule["API"]> | null>(null);
      const client = yield* Effect.cached(
        Effect.flatMap(module, (tscrs) =>
          Effect.try({
            try: () => {
              const api = new tscrs.API();
              return { tscrs, api };
            },
            catch: toTranspileError,
          }).pipe(Effect.tap(({ api }) => Ref.set(apiRef, api))),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Ref.get(apiRef).pipe(
          Effect.flatMap((api) => (api === null ? Effect.void : Effect.promise(() => api.close()))),
        ),
      );
      const build = (source: string) =>
        Effect.flatMap(client, ({ tscrs, api }) =>
          makeBuild({
            transpileModule: (input, options) => api.transpileModule(input, options),
            formatDiagnostics: (diagnostics) => tscrs.formatDiagnostics(diagnostics, api),
          })(source),
        );
      return { transpile: yield* makeTranspile(build) };
    }),
  );

export const layerTranspiler = makeTranspilerLayer(loadTscRs);

// ── Service ──────────────────────────────────────────────────────────────

export interface WidgetTranspileLimits {
  readonly maxSourceBytes: number;
  readonly transpileTimeoutMs: number;
  readonly maxPublishesPerWindow: number;
  readonly publishWindowMs: number;
  /** Cap on `manifest.subscriptions`/`manifest.actions` entries each. */
  readonly maxBridgeDeclarations: number;
  /**
   * Artifact-store bound: `<hash>.js`+`.json` pairs past this count evict
   * oldest-first (meta mtime) through the same removal path as `remove`.
   */
  readonly maxArtifacts: number;
  /**
   * Byte cap across artifact pairs, applied alongside `maxArtifacts`. The
   * pair just written is never evicted by the publish that created it.
   */
  readonly maxArtifactBytes: number;
  /**
   * Cap on decoded source records held in memory. The map is only a
   * memoized view of the sidecar metas — evicted entries reload from disk.
   */
  readonly maxCachedRecords: number;
}

const DEFAULT_LIMITS: WidgetTranspileLimits = {
  maxSourceBytes: 256 * 1024,
  transpileTimeoutMs: 10_000,
  maxPublishesPerWindow: 30,
  publishWindowMs: 60_000,
  maxBridgeDeclarations: 64,
  maxArtifacts: 256,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxCachedRecords: 256,
};

export class WidgetTranspileService extends Context.Service<
  WidgetTranspileService,
  {
    /**
     * Transpiles and caches a widget source. Size/rate violations reject the
     * call; a build failure records `status: "failed"` with a typed
     * `transpileFailed` state and returns normally.
     */
    readonly publish: (
      input: WatchWidgetSourcePublishInput,
    ) => Effect.Effect<WatchWidgetSourcePublishResult, WatchWidgetSourceError>;
    /**
     * The trusted publish leg for server-side callers (pack-bundled widget
     * registration): identical validation, caching, and records, but it does
     * not consume the agent-facing per-window publish cap — the cap bounds
     * agent churn, not human-confirmed pack installs. Never exposed over RPC.
     */
    readonly publishTrusted: (
      input: WatchWidgetSourcePublishInput,
    ) => Effect.Effect<WatchWidgetSourcePublishResult, WatchWidgetSourceError>;
    /**
     * The way out of publish, server-side only: deletes the source's artifact
     * and sidecar meta, drops the cached record, and emits a `null` tombstone
     * so live subscribers re-render the missing-source state. A sourceId that
     * cannot name an artifact still drops its record — it just has no files.
     * Artifact-store eviction runs the same path for over-cap pairs.
     */
    readonly remove: (
      input: WatchWidgetSourceGetInput,
    ) => Effect.Effect<void, WatchWidgetSourceError>;
    /** The source record plus, for a `ready` artifact, the emitted bundle. */
    readonly get: (
      input: WatchWidgetSourceGetInput,
    ) => Effect.Effect<WatchWidgetSourceGetResult, WatchWidgetSourceError>;
    /** Emits the current record (`null` while unknown), then every republish of that source. */
    readonly subscribe: (
      input: WatchWidgetSourceSubscribeInput,
    ) => Stream.Stream<WatchWidgetSourceRecord | null, WatchWidgetSourceError>;
  }
>()("t3/watch/WidgetTranspileService") {}

export const makeLayer = (overrides: Partial<WidgetTranspileLimits> = {}) =>
  Layer.effect(
    WidgetTranspileService,
    Effect.gen(function* () {
      const limits: WidgetTranspileLimits = { ...DEFAULT_LIMITS, ...overrides };
      const serverConfig = yield* ServerConfig.ServerConfig;
      const transpiler = yield* WidgetSourceTranspiler;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Indexed view of the artifact directory: records seen this run plus
      // any lazily decoded sidecar metas.
      const records = yield* Ref.make(new Map<WatchWidgetSourceId, WatchWidgetSourceRecord>());
      // The sourceId rides alongside so a removal tombstone (record: null)
      // can still reach the subscribers filtering on it.
      const publishes = yield* PubSub.unbounded<{
        readonly sourceId: WatchWidgetSourceId;
        readonly record: WatchWidgetSourceRecord | null;
      }>();
      const publishStamps = yield* Ref.make<ReadonlyArray<number>>([]);

      const artifactPath = (artifactHash: string) =>
        path.join(serverConfig.widgetArtifactsDir, `${artifactHash}.js`);
      const metaPath = (artifactHash: string) =>
        path.join(serverConfig.widgetArtifactsDir, `${artifactHash}.json`);

      /** Atomic file publish: temp write + rename so a crash never leaves a partial artifact. */
      const writeFileAtomic = Effect.fnUntraced(function* (target: string, contents: string) {
        const temp = `${target}.tmp`;
        yield* fs.writeFileString(temp, contents);
        yield* fs.rename(temp, target);
      });

      const readBundle = (artifactHash: string) =>
        fs.readFileString(artifactPath(artifactHash)).pipe(
          Effect.map((bundle): string | null => bundle),
          Effect.orElseSucceed((): string | null => null),
        );

      /**
       * The records map is bounded: delete-then-set keeps insertion order
       * "least recently written first", so the cap drops the coldest
       * entries. Records are only a memoized view of the sidecar metas —
       * dropped entries reload from disk on the next lookup.
       */
      const cacheRecord = (sourceId: WatchWidgetSourceId, record: WatchWidgetSourceRecord) =>
        Ref.update(records, (map) => {
          const next = new Map(map);
          next.delete(sourceId);
          next.set(sourceId, record);
          while (next.size > limits.maxCachedRecords) {
            const oldest = next.keys().next().value;
            if (oldest === undefined) break;
            next.delete(oldest);
          }
          return next;
        });

      const loadRecord = Effect.fnUntraced(function* (sourceId: WatchWidgetSourceId) {
        const memoized = (yield* Ref.get(records)).get(sourceId);
        if (memoized !== undefined) return memoized;
        if (!sourceId.startsWith(SOURCE_ID_PREFIX)) return null;
        const artifactHash = sourceId.slice(SOURCE_ID_PREFIX.length);
        if (!ARTIFACT_HASH_PATTERN.test(artifactHash)) return null;
        const metaExists = yield* fs
          .exists(metaPath(artifactHash))
          .pipe(Effect.orElseSucceed(() => false));
        if (!metaExists) return null;
        const record = yield* fs
          .readFileString(metaPath(artifactHash))
          .pipe(Effect.flatMap(decodeRecordJson), Effect.option);
        if (Option.isNone(record)) return null;
        yield* cacheRecord(sourceId, record.value);
        return record.value;
      });

      /**
       * Every way in has a way out: a `failed` record is rebuilt on republish,
       * and a `ready` record whose `.js` disappeared (pruned or corrupt)
       * degrades back to `transpileFailed` here instead of lying to the host.
       */
      const storeRecord = Effect.fnUntraced(function* (record: WatchWidgetSourceRecord) {
        yield* cacheRecord(record.sourceId, record);
        yield* PubSub.publish(publishes, { sourceId: record.sourceId, record });
      });

      /**
       * The shared removal path for `remove` and artifact eviction: the
       * pair's files go first — if they cannot be deleted the record stays
       * fetchable, matching the state a failed removal should leave — then
       * the cached record drops and subscribers get a `null` tombstone.
       */
      const dropArtifact = (artifactHash: string, sourceId: WatchWidgetSourceId) =>
        Effect.gen(function* () {
          yield* Effect.all(
            [
              fs.remove(artifactPath(artifactHash), { force: true }),
              fs.remove(metaPath(artifactHash), { force: true }),
            ],
            { concurrency: 1, discard: true },
          );
          yield* Ref.update(records, (map) => {
            const next = new Map(map);
            next.delete(sourceId);
            return next;
          });
          yield* PubSub.publish(publishes, { sourceId, record: null });
        });

      /**
       * Bounds the artifact directory: pairs past the count or byte caps are
       * evicted oldest-first through `dropArtifact`, so agent-published
       * sources get the same way out as `remove` — files gone, record
       * dropped, subscribers tombstoned — without a dedicated RPC. A pair's
       * age is its oldest file mtime; `keepHash` (the pair just written) is
       * never evicted by the publish that created it.
       */
      const evictArtifacts = Effect.fnUntraced(function* (keepHash: string) {
        const names = yield* fs.readDirectory(serverConfig.widgetArtifactsDir);
        const hashes = new Set<string>();
        for (const name of names) {
          const hash = name.endsWith(".js")
            ? name.slice(0, name.length - ".js".length)
            : name.endsWith(".json")
              ? name.slice(0, name.length - ".json".length)
              : null;
          if (hash !== null && ARTIFACT_HASH_PATTERN.test(hash)) hashes.add(hash);
        }
        const pairs: Array<{
          readonly hash: string;
          readonly mtimeMs: number;
          readonly bytes: number;
        }> = [];
        for (const hash of hashes) {
          const jsStat = yield* fs.stat(artifactPath(hash)).pipe(Effect.option);
          const metaStat = yield* fs.stat(metaPath(hash)).pipe(Effect.option);
          const stats = [jsStat, metaStat].flatMap((stat) =>
            Option.isSome(stat) ? [stat.value] : [],
          );
          if (stats.length === 0) continue;
          pairs.push({
            hash,
            mtimeMs: Math.min(
              ...stats.map((stat) =>
                Option.match(stat.mtime, {
                  onNone: () => 0,
                  onSome: (mtime) => mtime.getTime(),
                }),
              ),
            ),
            bytes: stats.reduce((sum, stat) => sum + Number(stat.size), 0),
          });
        }
        pairs.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.hash < b.hash ? -1 : 1));
        let count = pairs.length;
        let bytes = pairs.reduce((sum, pair) => sum + pair.bytes, 0);
        for (const victim of pairs) {
          if (count <= limits.maxArtifacts && bytes <= limits.maxArtifactBytes) break;
          if (victim.hash === keepHash) continue;
          yield* dropArtifact(
            victim.hash,
            WatchWidgetSourceId.make(`${SOURCE_ID_PREFIX}${victim.hash}`),
          ).pipe(Effect.orElseSucceed(() => undefined));
          count -= 1;
          bytes -= victim.bytes;
        }
      });

      const publishInner = (input: WatchWidgetSourcePublishInput, enforcePublishLimit: boolean) =>
        Effect.gen(function* () {
          if (
            input.manifest.subscriptions.length > limits.maxBridgeDeclarations ||
            input.manifest.actions.length > limits.maxBridgeDeclarations
          ) {
            return yield* sourceError(
              "manifestInvalid",
              `Bridge manifests declare at most ${limits.maxBridgeDeclarations} subscriptions and actions each.`,
            );
          }
          if (Buffer.byteLength(input.source, "utf8") > limits.maxSourceBytes) {
            return yield* sourceError(
              "sourceTooLarge",
              `Widget source exceeds the ${limits.maxSourceBytes}-byte limit.`,
            );
          }

          // The cache key covers exactly what determines the artifact: the
          // canonical manifest encoding plus the raw source.
          const manifestJson = encodeManifestJson(input.manifest);
          const artifactHash = NodeCrypto.createHash("sha256")
            .update(manifestJson, "utf8")
            .update("\0")
            .update(input.source, "utf8")
            .digest("hex");
          const sourceId = WatchWidgetSourceId.make(`${SOURCE_ID_PREFIX}${artifactHash}`);

          const cached = yield* loadRecord(sourceId);
          if (cached !== null && cached.status === "ready") {
            // A surviving meta whose bundle was pruned is rebuilt, not
            // returned — `get` degrades the same state, so the paths agree.
            const artifactExists = yield* fs
              .exists(artifactPath(cached.artifactHash))
              .pipe(Effect.orElseSucceed(() => false));
            if (artifactExists) {
              return { source: cached };
            }
          }

          // The per-window cap bounds agent-authored churn only: trusted
          // pack registration neither consumes nor is rejected by it. It
          // sits after the ready-cache-hit early return so republishing an
          // existing artifact is free — a retry loop cannot spend the budget
          // without doing real transpile work.
          if (enforcePublishLimit) {
            const admitted = yield* Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                Ref.modify(publishStamps, (stamps) => {
                  const fresh = stamps.filter((stamp) => now - stamp < limits.publishWindowMs);
                  if (fresh.length >= limits.maxPublishesPerWindow) {
                    return [false, fresh] as const;
                  }
                  return [true, [...fresh, now]] as const;
                }),
              ),
            );
            if (!admitted) {
              return yield* sourceError(
                "publishRateLimited",
                `Widget source publishes are limited to ${limits.maxPublishesPerWindow} per ${Math.round(limits.publishWindowMs / 1_000)}s.`,
              );
            }
          }

          // `Effect.result` turns a build diagnostic into a value first, so
          // the timeout bounds only a hung transpile. The shared tsc-rs
          // server has no per-request cancel, so interruption abandons the
          // wait while the request keeps running there. Either way the
          // outcome is written as a record — data, never an effect failure.
          const transpiled = yield* transpiler.transpile(input.source).pipe(
            Effect.result,
            Effect.timeoutOrElse({
              duration: limits.transpileTimeoutMs,
              orElse: () =>
                Effect.succeed(
                  Result.fail(
                    new WidgetTranspileError({
                      reason: "failed",
                      detail: `Widget source transpile exceeded the ${limits.transpileTimeoutMs}ms limit.`,
                    }),
                  ),
                ),
            }),
          );

          // `</script` is escaped before hashing and writing so the artifact
          // cannot close the host document's inline script tag; `scriptHash`
          // then covers exactly the bytes the host serves.
          const { bundle, record } = Result.match(transpiled, {
            onSuccess: (output) => {
              const bundle = escapeScriptCloseTags(output);
              const record: WatchWidgetSourceRecord = {
                sourceId,
                source: input.source,
                manifest: input.manifest,
                artifactHash,
                scriptHash: sha256Base64(bundle),
                status: "ready",
                failure: null,
              };
              return { bundle, record };
            },
            onFailure: (error) => {
              const record: WatchWidgetSourceRecord = {
                sourceId,
                source: input.source,
                manifest: input.manifest,
                artifactHash,
                scriptHash: null,
                status: "failed",
                failure: { cause: "transpileFailed", detail: error.detail },
              };
              return { bundle: null, record };
            },
          });

          yield* Effect.gen(function* () {
            if (bundle !== null) {
              // The bundle lands before the meta that points at it: a crash
              // leaves an orphan file, never a ready meta without its bundle.
              yield* writeFileAtomic(artifactPath(artifactHash), bundle);
            }
            yield* writeFileAtomic(metaPath(artifactHash), encodeRecordJson(record));
          }).pipe(
            Effect.mapError((cause) =>
              sourceError("artifactStoreFailed", "Could not write the widget artifact.", {
                sourceId,
                cause,
              }),
            ),
          );

          // Best-effort bound on the artifact dir: pairs past the count or
          // byte caps evict oldest-first through the same removal path as
          // `remove`. A sweep failure must not fail the publish — the pair
          // is written and `get`/`publish` tolerate a crowded dir.
          yield* evictArtifacts(artifactHash).pipe(Effect.orElseSucceed(() => undefined));

          yield* storeRecord(record);
          return { source: record };
        }).pipe(
          Effect.mapError((cause) =>
            isSourceError(cause)
              ? cause
              : sourceError("artifactStoreFailed", "Widget source publish failed.", { cause }),
          ),
        );

      const publish: WidgetTranspileService["Service"]["publish"] = (input) =>
        publishInner(input, true);

      const publishTrusted: WidgetTranspileService["Service"]["publishTrusted"] = (input) =>
        publishInner(input, false);

      const remove: WidgetTranspileService["Service"]["remove"] = (input) =>
        Effect.gen(function* () {
          const artifactHash = input.sourceId.startsWith(SOURCE_ID_PREFIX)
            ? input.sourceId.slice(SOURCE_ID_PREFIX.length)
            : null;
          if (artifactHash !== null && ARTIFACT_HASH_PATTERN.test(artifactHash)) {
            yield* dropArtifact(artifactHash, input.sourceId).pipe(
              Effect.mapError((cause) =>
                sourceError("artifactStoreFailed", "Could not remove the widget artifact.", {
                  sourceId: input.sourceId,
                  cause,
                }),
              ),
            );
          } else {
            yield* Ref.update(records, (map) => {
              const next = new Map(map);
              next.delete(input.sourceId);
              return next;
            });
            yield* PubSub.publish(publishes, { sourceId: input.sourceId, record: null });
          }
        }).pipe(
          Effect.mapError((cause) =>
            isSourceError(cause)
              ? cause
              : sourceError("artifactStoreFailed", "Widget source removal failed.", { cause }),
          ),
        );

      const get: WidgetTranspileService["Service"]["get"] = (input) =>
        Effect.gen(function* () {
          const record = yield* loadRecord(input.sourceId);
          if (record === null) return { source: null, bundle: null };
          if (record.status !== "ready") return { source: record, bundle: null };
          const bundle = yield* readBundle(record.artifactHash);
          if (bundle !== null) return { source: record, bundle };
          const degraded: WatchWidgetSourceRecord = {
            ...record,
            status: "failed",
            scriptHash: null,
            failure: {
              cause: "transpileFailed",
              detail: "The widget artifact is missing from the artifact cache.",
            },
          };
          yield* writeFileAtomic(metaPath(record.artifactHash), encodeRecordJson(degraded)).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          yield* storeRecord(degraded);
          return { source: degraded, bundle: null };
        }).pipe(
          Effect.mapError((cause) =>
            isSourceError(cause)
              ? cause
              : sourceError("artifactStoreFailed", "Widget source lookup failed.", { cause }),
          ),
        );

      const subscribe: WidgetTranspileService["Service"]["subscribe"] = (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before the lookup so a publish landing between them is
            // buffered rather than dropped.
            const subscription = yield* PubSub.subscribe(publishes);
            const current = yield* loadRecord(input.sourceId);
            return Stream.concat(
              Stream.succeed(current),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((event) => event.sourceId === input.sourceId),
                Stream.map((event) => event.record),
              ),
            );
          }),
        );

      return { publish, publishTrusted, remove, get, subscribe };
    }),
  );

export const layer = makeLayer();
