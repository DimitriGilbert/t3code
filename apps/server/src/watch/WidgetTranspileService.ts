// @effect-diagnostics nodeBuiltinImport:off - esbuild is external to the CLI
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
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as Esbuild from "esbuild";

import * as ServerConfig from "../config.ts";

/**
 * Agent-authored widget pipeline: `publish` validates the bridge manifest,
 * esbuild-bundles the single-file TS/TSX source into an IIFE artifact cached
 * on disk by content hash, and records the outcome as a
 * `WatchWidgetSourceRecord`. A bad build is *data*, not a call failure — the
 * record's `transpileFailed` state is what the widget shell renders; only
 * manifest shape, source-size, and rate-limit violations reject the call.
 *
 * Emitted code contract (the hardened host document owns the other half):
 * the bundle is a self-contained IIFE. Imports esbuild can resolve (static
 * `import`/`export … from`, `require("x")`, literal `import("x")`) are
 * rejected at build time by the no-imports plugin. Non-literal forms never
 * reach resolution, so three more defenses apply: `supported` with
 * `"dynamic-import": false` lowers `import(expr)` to a throwing `__require`
 * stub, any esbuild warning fails the build (the `import.meta` substitution
 * warns), and output still containing `import(`, `import.meta`, or
 * `__require` is rejected — a source can never smuggle filesystem contents
 * into the artifact or defer to modules that do not exist in the frame.
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

export type EsbuildModule = typeof import("esbuild");

// esbuild stays external to the CLI bundle: its JS wrapper locates a
// per-platform `@esbuild/<os>-<arch>` binary on the real filesystem. Inside a
// Node SEA `import`/`import()` cannot reach file-backed packages, so — like
// node-pty — it loads through createRequire, which works in every runtime.
const requireForEsbuild = NodeModule.createRequire(import.meta.url);

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
     * `unavailable` marks the esbuild module or its platform binary as
     * missing/broken — latched by `makeTranspile` so later publishes fast-fail
     * instead of re-probing. `failed` is a per-source build diagnostic *or*
     * any other non-diagnostic rejection (a wedged service, spawn pressure);
     * only the verifiably-permanent missing-binary signature latches.
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
 * `@esbuild/*` platform binary cannot appear mid-process, so re-probing on
 * every publish would just respawn a broken service. Only that signature is
 * classified `unavailable` — transient esbuild rejections and per-source
 * build diagnostics are `failed` and pass through every time.
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
 * Sources are one self-contained file: a resolvable import would pull
 * server-side modules into the artifact. Non-literal imports never reach
 * this hook — they are handled by `supported.dynamic-import` and the
 * residual-output check in `makeBuild`.
 */
const noImportsPlugin: Esbuild.Plugin = {
  name: "t3-watch-widget-no-imports",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      // The <stdin> entry resolves through this hook too; only real imports fail.
      if (args.kind === "entry-point") return undefined;
      return {
        errors: [
          {
            text: `Widget sources are a single self-contained file; imports are not allowed ("${args.path}").`,
            pluginName: "t3-watch-widget-no-imports",
          },
        ],
      };
    });
  },
};

const widgetBuildOptions = (source: string): Esbuild.BuildOptions => ({
  stdin: { contents: source, loader: "tsx", sourcefile: "widget.tsx" },
  bundle: true,
  // IIFE so the generated srcdoc document injects the artifact with a plain
  // inline <script>; JSX lowers to the host-provided T3 global.
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "transform",
  jsxFactory: "T3.h",
  jsxFragment: "T3.Fragment",
  write: false,
  charset: "utf8",
  // Non-literal `import(expr)` never reaches the no-imports resolver, so the
  // dynamic-import feature is dropped entirely: esbuild lowers it to a
  // throwing `__require` stub, and the residual-output check in `makeBuild`
  // then rejects the artifact — the emitted code can never hold a live
  // module-specifier fetch.
  supported: { "dynamic-import": false },
  // Diagnostics are captured into the source record, so esbuild must not
  // echo them to the server log.
  logLevel: "silent",
  legalComments: "none",
  plugins: [noImportsPlugin],
});

/**
 * Import-shaped residue in the emitted artifact means one of the
 * non-literal forms slipped past the resolver and its lowering: a verbatim
 * `import(`, an `import.meta`, or esbuild's `__require` shim. Rather than
 * ship a live module specifier in hash-authorized code, `makeBuild` fails
 * the build.
 */
const FORBIDDEN_ARTIFACT_PATTERN = /\bimport\s*\(|import\.meta|\b__require\b/;

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
 * or mismatched `@esbuild/*` platform binary cannot appear mid-process, and
 * its signature is `ENOENT` on the spawned binary or the wrapper's
 * `@esbuild/<pkg>` message. Everything else — `EMFILE`/`EAGAIN` spawn
 * pressure, a wedged service, a panic on pathological input — is a
 * per-source `failed` so the next publish retries cleanly.
 */
const MISSING_BINARY_PATTERN = /ENOENT|@esbuild\//;

const isBuildDiagnostics = (
  cause: unknown,
): cause is { readonly errors: ReadonlyArray<Esbuild.Message> } =>
  Predicate.isObject(cause) && "errors" in cause && Array.isArray(cause.errors);

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const formatDiagnostics = (
  esbuild: EsbuildModule,
  messages: ReadonlyArray<Esbuild.PartialMessage>,
  kind: "error" | "warning",
) => {
  try {
    const formatted = esbuild
      .formatMessagesSync([...messages], { kind })
      .join("\n")
      .trim();
    return formatted === "" ? "esbuild build failed." : formatted;
  } catch {
    return "esbuild build failed.";
  }
};

const toBuildError = (esbuild: EsbuildModule, cause: unknown): WidgetTranspileError => {
  if (isBuildDiagnostics(cause)) {
    return new WidgetTranspileError({
      reason: "failed",
      detail: formatDiagnostics(esbuild, cause.errors, "error"),
    });
  }
  const detail = causeMessage(cause);
  return MISSING_BINARY_PATTERN.test(detail)
    ? new WidgetTranspileError({
        reason: "unavailable",
        detail: `The esbuild platform binary could not run: ${detail}.`,
      })
    : new WidgetTranspileError({
        reason: "failed",
        detail: `The widget build failed unexpectedly: ${detail}.`,
      });
};

const loadEsbuild = Effect.try({
  try: () => requireForEsbuild("esbuild") as EsbuildModule,
  catch: (cause) =>
    new WidgetTranspileError({
      reason: "unavailable",
      detail: `The esbuild package could not be loaded: ${causeMessage(cause)}.`,
    }),
});

/**
 * One source's build, run through an `esbuild.context` so interruption can
 * cancel the work: `ctx.cancel()` fires both from the `tryPromise` abort
 * signal and again in the release finalizer (cancel is idempotent), so a
 * `transpileTimeoutMs` expiry or fiber interrupt actually stops the esbuild
 * service's work instead of abandoning a promise it keeps running.
 * Exported so tests can drive it with a fake esbuild module.
 */
export const makeBuild =
  (esbuild: EsbuildModule) =>
  (source: string): Effect.Effect<string, WidgetTranspileError> =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => esbuild.context(widgetBuildOptions(source)),
            catch: (cause) => toBuildError(esbuild, cause),
          }),
          (ctx) =>
            Effect.promise(async () => {
              await ctx.cancel();
              await ctx.dispose();
            }),
        ).pipe(
          Effect.flatMap((ctx) =>
            Effect.tryPromise({
              try: (signal) => {
                const abort = () => void ctx.cancel();
                signal.addEventListener("abort", abort, { once: true });
                return ctx.rebuild().finally(() => signal.removeEventListener("abort", abort));
              },
              catch: (cause) => toBuildError(esbuild, cause),
            }),
          ),
        ),
      );
      const output = result.outputFiles?.[0]?.text;
      if (output === undefined) {
        return yield* new WidgetTranspileError({
          reason: "failed",
          detail: "esbuild produced no output.",
        });
      }
      // Warnings are silent degradations of the artifact contract (e.g. the
      // `import.meta` → empty-object substitution), so they fail the build.
      if (result.warnings.length > 0) {
        return yield* new WidgetTranspileError({
          reason: "failed",
          detail: formatDiagnostics(esbuild, result.warnings, "warning"),
        });
      }
      if (FORBIDDEN_ARTIFACT_PATTERN.test(output)) {
        return yield* new WidgetTranspileError({
          reason: "failed",
          detail:
            "The emitted widget bundle still contains an import or require shim; the artifact was rejected.",
        });
      }
      return output;
    });

export const layerTranspiler = Layer.effect(
  WidgetSourceTranspiler,
  Effect.gen(function* () {
    // The module require and the first build are the two lazy probes for the
    // platform binary; a missing one caches its failure (Effect.cached keeps
    // the error, makeTranspile latches it) so a packaged server with a
    // missing @esbuild/* degrades to transpileFailed instead of crashing.
    const esbuildModule = yield* Effect.cached(loadEsbuild);
    const build = (source: string) =>
      Effect.flatMap(esbuildModule, (esbuild) => makeBuild(esbuild)(source));
    return { transpile: yield* makeTranspile(build) };
  }),
);

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
          // the timeout bounds only a hung transpile — and the transpiler
          // builds inside an `esbuild.context`, so interruption calls
          // `ctx.cancel()` and the limit bounds the service's work rather
          // than just this wait. Either way the outcome is written as a
          // record — data, never an effect failure.
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
