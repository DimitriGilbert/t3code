import { WatchConnectorError, type WatchConnectorErrorReason } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

/**
 * `file`-transport watches: instance config `watch` declares the allowlisted
 * roots and glob patterns; the runtime collects matching file contents,
 * confined to each root's real path — a symlink reaching outside is rejected
 * outright so a connector can never become an arbitrary-file-read primitive.
 *
 * Instance config convention:
 *
 *   { watch: { roots: ["/abs/dir", ...], globs?: ["**\/*.json"], maxDepth?: 4 } }
 *
 * Raw file contents stay server-side; only the transform output crosses the
 * wire as a snapshot.
 */
export const MAX_WATCH_ROOTS = 16;
export const MAX_WATCH_FILES = 512;
export const MAX_WATCH_FILE_BYTES = 256 * 1024;
export const MAX_WATCH_DEPTH = 8;
/** Writes within this window collapse into one rescan trigger. */
export const FILE_WATCH_DEBOUNCE = Duration.millis(250);

export interface FileWatchSpec {
  readonly roots: ReadonlyArray<string>;
  readonly globs: ReadonlyArray<string>;
  readonly maxDepth: number;
}

const connectorError = (
  reason: WatchConnectorErrorReason,
  message: string,
  options?: { readonly cause?: unknown },
) =>
  new WatchConnectorError({
    message,
    reason,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

const isRecord = Predicate.isObject;

/**
 * Reads the `watch` block out of instance config. Rejects malformed shapes as
 * `configInvalid` — the config is user/agent-written, so this is the boundary
 * where it becomes a typed spec.
 */
export const parseFileWatchConfig = Effect.fn("ConnectorFileTransport.parseFileWatchConfig")(
  function* (config: Readonly<Record<string, unknown>>) {
    const watch = config["watch"];
    if (!isRecord(watch)) {
      return yield* connectorError(
        "configInvalid",
        'File connector config must carry a "watch" object.',
      );
    }
    const roots = watch["roots"];
    if (
      !Array.isArray(roots) ||
      roots.length === 0 ||
      roots.some((root) => typeof root !== "string" || root.length === 0)
    ) {
      return yield* connectorError(
        "configInvalid",
        'File connector "watch.roots" must be a non-empty list of directories.',
      );
    }
    if (roots.length > MAX_WATCH_ROOTS) {
      return yield* connectorError(
        "watchLimitExceeded",
        `File connector declares ${roots.length} watch roots; the cap is ${MAX_WATCH_ROOTS}.`,
      );
    }
    const globs = watch["globs"];
    if (
      globs !== undefined &&
      (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string" || glob.length === 0))
    ) {
      return yield* connectorError(
        "configInvalid",
        'File connector "watch.globs" must be a list of non-empty patterns.',
      );
    }
    const maxDepth = watch["maxDepth"];
    if (
      maxDepth !== undefined &&
      (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 1)
    ) {
      return yield* connectorError(
        "configInvalid",
        'File connector "watch.maxDepth" must be a positive integer.',
      );
    }
    return {
      roots: roots as ReadonlyArray<string>,
      globs: (globs ?? ["**"]) as ReadonlyArray<string>,
      // The hard cap wins over config: a deeper request is clamped, not honored.
      maxDepth: Math.min(maxDepth ?? MAX_WATCH_DEPTH, MAX_WATCH_DEPTH),
    } satisfies FileWatchSpec;
  },
);

/**
 * Minimal glob matcher for watch patterns: `**` crosses directory boundaries,
 * `*` and `?` stay within one path segment. Patterns match the root-relative
 * POSIX path.
 */
const globToRegExp = (glob: string): RegExp => {
  let pattern = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` should also match zero directories ("a/**/b" ⊃ "a/b").
        if (glob[i + 2] === "/") {
          pattern += "(?:[^/]+/)*";
          i += 3;
        } else {
          pattern += ".*";
          i += 2;
        }
      } else {
        pattern += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      pattern += "[^/]";
      i += 1;
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
};

const matchesAny = (matchers: ReadonlyArray<RegExp>, relativePath: string) =>
  matchers.some((matcher) => matcher.test(relativePath));

/**
 * Collects the matched file contents under each root. Every candidate is
 * resolved with `realPath`; anything escaping the root's real path rejects the
 * whole run as `confinementRejected`. File count, file size, and depth are all
 * capped server-side.
 */
export const collectWatchedFiles = Effect.fn("ConnectorFileTransport.collectWatchedFiles")(
  function* (spec: FileWatchSpec) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const matchers = spec.globs.map(globToRegExp);
    const files: Record<string, string> = {};

    for (const declaredRoot of spec.roots) {
      const root = path.resolve(declaredRoot);
      const realRoot = yield* fs.realPath(root).pipe(
        Effect.mapError((cause) =>
          connectorError("configInvalid", `Watch root ${declaredRoot} could not be resolved.`, {
            cause,
          }),
        ),
      );
      const rootStat = yield* fs.stat(realRoot).pipe(
        Effect.mapError((cause) =>
          connectorError("configInvalid", `Watch root ${declaredRoot} could not be read.`, {
            cause,
          }),
        ),
      );
      if (rootStat.type !== "Directory") {
        return yield* connectorError(
          "configInvalid",
          `Watch root ${declaredRoot} is not a directory.`,
        );
      }
      const rootName = path.basename(realRoot);

      // Iterative walk with explicit depth: `readDirectory({recursive})` would
      // descend past the depth cap before we could refuse it.
      const stack: Array<{ readonly dir: string; readonly rel: string; readonly depth: number }> = [
        { dir: realRoot, rel: "", depth: 0 },
      ];
      while (stack.length > 0) {
        const { dir, rel, depth } = stack.pop()!;
        const entries = yield* fs.readDirectory(dir).pipe(
          Effect.mapError((cause) =>
            connectorError("fetchFailed", `Could not read watched directory ${rel || rootName}.`, {
              cause,
            }),
          ),
        );
        for (const name of entries) {
          const full = path.join(dir, name);
          const relative = rel === "" ? name : `${rel}/${name}`;
          // An entry that cannot be resolved (dangling link) is skipped — it
          // is unreadable anyway; an entry resolving outside the root is a
          // confinement violation and rejects the whole run.
          const realEntry = yield* fs.realPath(full).pipe(
            Effect.option,
            Effect.map((option) => (option._tag === "Some" ? option.value : null)),
          );
          if (realEntry === null) continue;
          if (realEntry !== realRoot && !realEntry.startsWith(`${realRoot}${path.sep}`)) {
            return yield* connectorError(
              "confinementRejected",
              `Watched entry ${relative} resolves outside its allowlisted root ${declaredRoot}.`,
            );
          }
          const stat = yield* fs.stat(realEntry).pipe(Effect.option);
          if (stat._tag === "None") continue;
          if (stat.value.type === "Directory") {
            if (depth + 1 < spec.maxDepth) {
              stack.push({ dir: realEntry, rel: relative, depth: depth + 1 });
            }
            continue;
          }
          if (stat.value.type !== "File") continue;
          if (relative.split("/").length > spec.maxDepth) continue;
          if (!matchesAny(matchers, relative)) continue;
          if (Object.keys(files).length >= MAX_WATCH_FILES) {
            return yield* connectorError(
              "watchLimitExceeded",
              `File connector exceeds the ${MAX_WATCH_FILES}-file watch cap.`,
            );
          }
          if (stat.value.size > MAX_WATCH_FILE_BYTES) {
            return yield* connectorError(
              "watchLimitExceeded",
              `Watched file ${relative} exceeds the ${MAX_WATCH_FILE_BYTES}-byte cap.`,
            );
          }
          files[`${rootName}/${relative}`] = yield* fs
            .readFileString(realEntry)
            .pipe(
              Effect.mapError((cause) =>
                connectorError("fetchFailed", `Could not read watched file ${relative}.`, {
                  cause,
                }),
              ),
            );
        }
      }
    }
    return files;
  },
);

/** Coalesces a burst of file events into one signal per quiet window. */
export const debounceSignals = <A, E, R>(events: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
  events.pipe(Stream.debounce(FILE_WATCH_DEBOUNCE));

/**
 * One debounced signal stream per root, merged — the payload is irrelevant;
 * any event just triggers a rescan. A root whose watcher dies is dropped from
 * the signal set (logged), not fatal: the poll interval still rescans.
 */
export const watchSignals = Effect.fn("ConnectorFileTransport.watchSignals")(function* (
  spec: FileWatchSpec,
) {
  const fs = yield* FileSystem.FileSystem;
  return debounceSignals(
    Stream.mergeAll(
      spec.roots.map((root) =>
        fs.watch(root, { recursive: true }).pipe(
          Stream.as("signal" as const),
          Stream.catchCause((cause) =>
            Stream.fromEffectDrain(
              Effect.logWarning("Connector file watch ended", { root, cause }),
            ),
          ),
        ),
      ),
      { concurrency: spec.roots.length },
    ),
  );
});
