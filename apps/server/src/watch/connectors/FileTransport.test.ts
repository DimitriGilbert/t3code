// @effect-diagnostics nodeBuiltinImport:off - builds the denylisted `~/.ssh`
// path the tests assert against.
import * as NodeOS from "node:os";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { WatchConnectorError, type WatchConnectorErrorReason } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as FileTransport from "./FileTransport.ts";

const layer = Layer.provideMerge(
  ServerConfig.layerTest(process.cwd(), { prefix: "watch-file-config-" }),
  NodeServices.layer,
);
const isConnectorError = Schema.is(WatchConnectorError);

const expectConnectorError = <A, R>(
  reason: WatchConnectorErrorReason,
  effect: Effect.Effect<A, WatchConnectorError, R>,
) =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        assert.isTrue(isConnectorError(error), "expected a WatchConnectorError");
        if (isConnectorError(error)) assert.equal(error.reason, reason);
        return Effect.void;
      },
      onSuccess: () => Effect.die(new Error("expected the effect to fail")),
    }),
  );

const spec = (
  root: string,
  overrides?: Partial<FileTransport.FileWatchSpec>,
): FileTransport.FileWatchSpec => ({
  roots: [root],
  globs: ["**"],
  maxDepth: FileTransport.MAX_WATCH_DEPTH,
  ...overrides,
});

it.effect("rejects malformed watch config as configInvalid", () =>
  Effect.gen(function* () {
    yield* expectConnectorError("configInvalid", FileTransport.parseFileWatchConfig({}));
    yield* expectConnectorError(
      "configInvalid",
      FileTransport.parseFileWatchConfig({ watch: { roots: [] } }),
    );
    yield* expectConnectorError(
      "configInvalid",
      FileTransport.parseFileWatchConfig({ watch: { roots: [""] } }),
    );
    // More roots than the cap is a watch limit, not a shape error.
    yield* expectConnectorError(
      "watchLimitExceeded",
      FileTransport.parseFileWatchConfig({
        watch: { roots: Array.from({ length: FileTransport.MAX_WATCH_ROOTS + 1 }, () => "/x") },
      }),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("collects only glob-matched files, confined to the declared roots", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "watch-file-" });
    yield* fs.writeFileString(path.join(root, "a.json"), `{"a":1}`);
    yield* fs.writeFileString(path.join(root, "b.txt"), "not matched");
    yield* fs.makeDirectory(path.join(root, "sub"));
    yield* fs.writeFileString(path.join(root, "sub", "c.json"), `{"c":1}`);

    const files = yield* FileTransport.collectWatchedFiles(spec(root, { globs: ["**/*.json"] }));
    const rootName = path.basename(yield* fs.realPath(root));
    assert.deepEqual(Object.keys(files).toSorted(), [
      `${rootName}/a.json`,
      `${rootName}/sub/c.json`,
    ]);
    assert.equal(files[`${rootName}/a.json`], `{"a":1}`);
  }).pipe(Effect.provide(layer)),
);

it.effect("clamps traversal and files to the depth cap", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "watch-file-" });
    yield* fs.writeFileString(path.join(root, "a.json"), "{}");
    yield* fs.makeDirectory(path.join(root, "d1"));
    yield* fs.writeFileString(path.join(root, "d1", "b.json"), "{}");
    yield* fs.makeDirectory(path.join(root, "d1", "d2"));
    yield* fs.writeFileString(path.join(root, "d1", "d2", "c.json"), "{}");

    const files = yield* FileTransport.collectWatchedFiles(spec(root, { maxDepth: 2 }));
    assert.deepEqual(Object.keys(files).length, 2);
    assert.isFalse(Object.keys(files).some((key) => key.endsWith("d2/c.json")));
  }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!symlinksSupported)(
  "rejects a watched file that symlinks outside the allowlisted root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "watch-file-root-" });
      const outside = yield* fs.makeTempDirectory({ prefix: "watch-file-outside-" });
      yield* fs.writeFileString(path.join(outside, "secret.json"), `{"secret":true}`);
      yield* fs.symlink(path.join(outside, "secret.json"), path.join(root, "linked.json"));

      yield* expectConnectorError(
        "confinementRejected",
        FileTransport.collectWatchedFiles(spec(root)),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!symlinksSupported)(
  "rejects a watched directory that symlinks outside the allowlisted root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "watch-file-root-" });
      const outside = yield* fs.makeTempDirectory({ prefix: "watch-file-outside-" });
      yield* fs.writeFileString(path.join(outside, "inner.json"), "{}");
      yield* fs.symlink(outside, path.join(root, "linked-dir"));

      yield* expectConnectorError(
        "confinementRejected",
        FileTransport.collectWatchedFiles(spec(root)),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects a root that is not a directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "watch-file-" });
    const file = path.join(dir, "not-a-dir.json");
    yield* fs.writeFileString(file, "{}");
    yield* expectConnectorError("configInvalid", FileTransport.collectWatchedFiles(spec(file)));
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects a watched file over the per-file size cap", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "watch-file-" });
    yield* fs.writeFileString(
      path.join(root, "big.json"),
      "x".repeat(FileTransport.MAX_WATCH_FILE_BYTES + 1),
    );
    yield* expectConnectorError(
      "watchLimitExceeded",
      FileTransport.collectWatchedFiles(spec(root)),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects a watch set over the file count cap", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "watch-file-" });
    for (let i = 0; i < FileTransport.MAX_WATCH_FILES + 1; i += 1) {
      yield* fs.writeFileString(path.join(root, `f${i}.json`), "{}");
    }
    yield* expectConnectorError(
      "watchLimitExceeded",
      FileTransport.collectWatchedFiles(spec(root)),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects denylisted watch roots as confinementRejected", () =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const deniedRoots = [
      "/proc",
      "/proc/self",
      "/sys",
      "/dev/null/..",
      serverConfig.stateDir,
      serverConfig.connectorsDir,
      serverConfig.secretsDir,
      // A path nested under a denied root is denied even when it does not
      // exist — the resolved-path prefix check does not need realPath.
      path.join(serverConfig.stateDir, "nested", "deep"),
      path.join(NodeOS.homedir(), ".ssh"),
      path.join(NodeOS.homedir(), ".ssh", "sub"),
    ];
    for (const root of deniedRoots) {
      yield* expectConnectorError(
        "confinementRejected",
        FileTransport.parseFileWatchConfig({ watch: { roots: [root] } }),
      );
    }
    // A sibling sharing the stateDir name prefix is not denied.
    const sibling = `${serverConfig.stateDir}-sibling`;
    const parsed = yield* FileTransport.parseFileWatchConfig({ watch: { roots: [sibling] } });
    assert.deepEqual(parsed.roots, [sibling]);
    // An ordinary directory still parses.
    const dir = yield* fs.makeTempDirectory({ prefix: "watch-file-ok-" });
    const ok = yield* FileTransport.parseFileWatchConfig({ watch: { roots: [dir] } });
    assert.deepEqual(ok.roots, [dir]);
  }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!symlinksSupported)("rejects a watch root that symlinks into a denied path", () =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "watch-file-link-" });
    const link = path.join(dir, "state-link");
    yield* fs.symlink(serverConfig.stateDir, link);
    yield* expectConnectorError(
      "confinementRejected",
      FileTransport.parseFileWatchConfig({ watch: { roots: [link] } }),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("enforces the per-file byte cap on the stream, not stat.size", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "watch-file-" });
    yield* fs.writeFileString(
      path.join(root, "proc-like.json"),
      "x".repeat(FileTransport.MAX_WATCH_FILE_BYTES + 1),
    );
    // procfs-style lie: stat reports 0 bytes for a file that is not, so the
    // stat fast-path passes and only the read-side cap can stop it.
    const lyingStatFs = FileSystem.FileSystem.of({
      ...fs,
      stat: (requested) =>
        Effect.map(fs.stat(requested), (info) => ({ ...info, size: ByteSize.zero })),
    });
    yield* expectConnectorError(
      "watchLimitExceeded",
      FileTransport.collectWatchedFiles(spec(root)).pipe(
        Effect.provideService(FileSystem.FileSystem, lyingStatFs),
      ),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("collects a file named __proto__ as data", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "watch-file-" });
    yield* fs.writeFileString(path.join(root, "__proto__"), `{"polluted":false}`);

    const files = yield* FileTransport.collectWatchedFiles(spec(root));
    const rootName = path.basename(yield* fs.realPath(root));
    assert.equal(files[`${rootName}/__proto__`], `{"polluted":false}`);
  }).pipe(Effect.provide(layer)),
);

it.effect("coalesces a burst of file events into one debounced signal", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<number>();
    const collected = yield* Stream.fromQueue(queue).pipe(
      FileTransport.debounceSignals,
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    // Three events inside one quiet window collapse to a single signal.
    yield* Queue.offerAll(queue, [1, 2, 3]);
    yield* TestClock.adjust(FileTransport.FILE_WATCH_DEBOUNCE);
    // The next burst coalesces into a second signal, not two.
    yield* Queue.offerAll(queue, [4, 5]);
    yield* TestClock.adjust(FileTransport.FILE_WATCH_DEBOUNCE);
    const seen = yield* Fiber.join(collected);
    assert.deepEqual(seen, [3, 5]);
  }).pipe(Effect.provide(layer)),
);
