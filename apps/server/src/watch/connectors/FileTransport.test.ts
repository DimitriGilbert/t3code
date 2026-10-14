import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { WatchConnectorError, type WatchConnectorErrorReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as FileTransport from "./FileTransport.ts";

const layer = NodeServices.layer;
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
