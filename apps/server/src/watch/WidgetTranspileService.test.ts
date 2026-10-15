// @effect-diagnostics nodeBuiltinImport:off - the test recomputes the
// expected scriptHash over the served bundle bytes.
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  WatchWidgetSourceError,
  type WatchWidgetSourceErrorReason,
  WatchWidgetSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as WidgetTranspileService from "./WidgetTranspileService.ts";

const manifest = { subscriptions: [], actions: [] };

const input = (source: string) => ({ source, manifest });

const UNKNOWN_SOURCE_ID = WatchWidgetSourceId.make(`watch-widget-source:${"0".repeat(64)}`);

const layerTranspiler = (
  transpile: (source: string) => Effect.Effect<string, WidgetTranspileService.WidgetTranspileError>,
) => Layer.succeed(WidgetTranspileService.WidgetSourceTranspiler, { transpile });

const layerDeps = (transpiler: Layer.Layer<WidgetTranspileService.WidgetSourceTranspiler>) =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "widget-transpile-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
    transpiler,
    NodeServices.layer,
  );

const layerService = (
  transpiler: Layer.Layer<WidgetTranspileService.WidgetSourceTranspiler>,
  limits?: Parameters<typeof WidgetTranspileService.makeLayer>[0],
) => WidgetTranspileService.makeLayer(limits).pipe(Layer.provide(layerDeps(transpiler)));

/**
 * Like `layerService`, but keeps the shared deps visible to the test body so
 * it can touch the same ServerConfig/artifact directory as the service.
 */
const layerServiceWithDeps = (
  transpiler: Layer.Layer<WidgetTranspileService.WidgetSourceTranspiler>,
  limits?: Parameters<typeof WidgetTranspileService.makeLayer>[0],
) => {
  const deps = layerDeps(transpiler);
  return Layer.mergeAll(WidgetTranspileService.makeLayer(limits).pipe(Layer.provide(deps)), deps);
};

const isSourceError = Schema.is(WatchWidgetSourceError);

const expectSourceError = (
  reason: WatchWidgetSourceErrorReason,
  effect: Effect.Effect<unknown, WatchWidgetSourceError>,
) =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        assert.isTrue(isSourceError(error));
        if (isSourceError(error)) assert.equal(error.reason, reason);
        return Effect.void;
      },
      onSuccess: () => Effect.die(new Error(`expected a ${reason} WatchWidgetSourceError`)),
    }),
  );

it.effect("transpiles a TSX source into a cached single-file artifact", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const { source } = yield* service.publish(
        input('const App = () => <div className="card">hi</div>;\nT3.render(App);'),
      );
      assert.equal(source.status, "ready");
      assert.isNull(source.failure);
      assert.isNotNull(source.scriptHash);
      assert.isTrue(source.sourceId.startsWith("watch-widget-source:"));

      const { source: fetched, bundle } = yield* service.get({ sourceId: source.sourceId });
      assert.equal(fetched?.status, "ready");
      if (bundle === null) assert.fail("expected the emitted bundle");
      // JSX lowers to the host-provided T3 global, and the artifact is one
      // self-contained IIFE — no require/import left in it.
      assert.include(bundle, "T3.h");
      assert.notInclude(bundle, "require(");
    }),
  ).pipe(Effect.provide(layerService(WidgetTranspileService.layerTranspiler))),
);

it.effect("a bad build is returned as a failed record, not an error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const { source } = yield* service.publish(input("const broken = ("));
      assert.equal(source.status, "failed");
      assert.isNull(source.scriptHash);
      assert.equal(source.failure?.cause, "transpileFailed");
      assert.isString(source.failure?.detail);

      const { source: fetched, bundle } = yield* service.get({ sourceId: source.sourceId });
      assert.equal(fetched?.failure?.cause, "transpileFailed");
      assert.isNull(bundle);
    }),
  ).pipe(Effect.provide(layerService(WidgetTranspileService.layerTranspiler))),
);

it.effect("a missing transpiler binary records failed and latches", () => {
  let calls = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const first = yield* service.publish(input("const a = 1;"));
      assert.equal(first.source.status, "failed");
      assert.equal(first.source.failure?.cause, "transpileFailed");
      assert.include(first.source.failure?.detail ?? "", "platform binary");

      // A missing @esbuild/* binary cannot appear mid-process, so the second
      // publish fast-fails from the latch without probing the transpiler.
      const second = yield* service.publish(input("const a = 2;"));
      assert.equal(second.source.status, "failed");
      assert.equal(second.source.failure?.cause, "transpileFailed");
      assert.equal(calls, 1);
    }),
  ).pipe(
    Effect.provide(
      layerService(
        Layer.effect(
          WidgetTranspileService.WidgetSourceTranspiler,
          Effect.map(
            WidgetTranspileService.makeTranspile(() => {
              calls += 1;
              return Effect.fail(
                new WidgetTranspileService.WidgetTranspileError({
                  reason: "unavailable",
                  detail: "The esbuild platform binary could not run: spawn ENOENT.",
                }),
              );
            }),
            (transpile) => ({ transpile }),
          ),
        ),
      ),
    ),
  );
});

it.effect("rejects a source that imports anything", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const { source } = yield* service.publish(input('import fs from "node:fs";\nT3.render(fs);'));
      assert.equal(source.status, "failed");
      assert.include(source.failure?.detail ?? "", "single self-contained file");
    }),
  ).pipe(Effect.provide(layerService(WidgetTranspileService.layerTranspiler))),
);

it.effect("rejects a non-literal dynamic import instead of shipping it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      // `import(globalThis.X)` never reaches the resolver: esbuild lowers it
      // to a throwing `__require` stub, and the residual-output check then
      // rejects the artifact — the record is failed, not ready-but-broken.
      const { source } = yield* service.publish(
        input("const m = import(globalThis.X);\nT3.render(() => m);"),
      );
      assert.equal(source.status, "failed");
      assert.isNull(source.scriptHash);
      assert.equal(source.failure?.cause, "transpileFailed");
      assert.include(source.failure?.detail ?? "", "import");
    }),
  ).pipe(Effect.provide(layerService(WidgetTranspileService.layerTranspiler))),
);

it.effect("fails the build when esbuild reports warnings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      // `import.meta` under iife output is a silent empty-object
      // substitution reported only as a warning — it must not ship.
      const { source } = yield* service.publish(input("const url = import.meta.url;"));
      assert.equal(source.status, "failed");
      assert.include(source.failure?.detail ?? "", "import.meta");
    }),
  ).pipe(Effect.provide(layerService(WidgetTranspileService.layerTranspiler))),
);

it.effect("identical source and manifest reuse the artifact without retranspiling", () => {
  let calls = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const first = yield* service.publish(input("const a = 1;"));
      const second = yield* service.publish(input("const a = 1;"));
      assert.equal(first.source.sourceId, second.source.sourceId);
      assert.equal(second.source.status, "ready");

      const other = yield* service.publish(input("const a = 2;"));
      assert.notEqual(other.source.sourceId, first.source.sourceId);
      assert.equal(calls, 2);
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler((source) => {
          calls += 1;
          return Effect.succeed(`/* ${source.length} */ T3.render();`);
        }),
      ),
    ),
  );
});

it.effect("rejects an oversized source before transpiling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      yield* expectSourceError("sourceTooLarge", service.publish(input("a".repeat(64))));
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler(() => Effect.die(new Error("transpile must not run"))),
        { maxSourceBytes: 32 },
      ),
    ),
  ),
);

it.effect("rejects an over-declared bridge manifest", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      yield* expectSourceError(
        "manifestInvalid",
        service.publish({
          source: "const a = 1;",
          manifest: { subscriptions: ["a", "b"], actions: [] },
        }),
      );
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler(() => Effect.succeed("T3.render();")),
        {
          maxBridgeDeclarations: 1,
        },
      ),
    ),
  ),
);

it.effect("a transpile that exceeds the timeout records a failed record", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      // The test clock never advances on its own, so the publish runs on a
      // fiber while the timeout horizon is pushed past it.
      const publishing = yield* service
        .publish(input("const a = 1;"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(100);
      const { source } = yield* Fiber.join(publishing);
      assert.equal(source.status, "failed");
      assert.equal(source.failure?.cause, "transpileFailed");
      assert.include(source.failure?.detail ?? "", "exceeded the 50ms limit");
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler(() => Effect.never),
        { transpileTimeoutMs: 50 },
      ),
    ),
  ),
);

it.effect("caps publishes per window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      yield* service.publish(input("const a = 1;"));
      yield* service.publish(input("const a = 2;"));
      yield* expectSourceError("publishRateLimited", service.publish(input("const a = 3;")));
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler((source) => Effect.succeed(`/* ${source} */`)),
        {
          maxPublishesPerWindow: 2,
        },
      ),
    ),
  ),
);

it.effect("a failed record is rebuilt on republish", () => {
  let calls = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const failed = yield* service.publish(input("const a = 1;"));
      assert.equal(failed.source.status, "failed");
      const rebuilt = yield* service.publish(input("const a = 1;"));
      assert.equal(rebuilt.source.sourceId, failed.source.sourceId);
      assert.equal(rebuilt.source.status, "ready");
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler(() => {
          calls += 1;
          return calls === 1
            ? Effect.fail(
                new WidgetTranspileService.WidgetTranspileError({
                  reason: "failed",
                  detail: "synthetic build failure",
                }),
              )
            : Effect.succeed("T3.render();");
        }),
      ),
    ),
  );
});

it.effect("a pruned bundle behind a ready meta is rebuilt on republish", () => {
  let calls = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const service = yield* WidgetTranspileService.WidgetTranspileService;

      const first = yield* service.publish(input("const a = 1;"));
      assert.equal(first.source.status, "ready");
      yield* fs.remove(
        path.join(serverConfig.widgetArtifactsDir, `${first.source.artifactHash}.js`),
      );

      const second = yield* service.publish(input("const a = 1;"));
      assert.equal(second.source.sourceId, first.source.sourceId);
      assert.equal(second.source.status, "ready");
      assert.equal(calls, 2);

      const { bundle } = yield* service.get({ sourceId: second.source.sourceId });
      assert.isNotNull(bundle);
    }),
  ).pipe(
    Effect.provide(
      layerServiceWithDeps(
        layerTranspiler(() => {
          calls += 1;
          return Effect.succeed("T3.render();");
        }),
      ),
    ),
  );
});

it.effect("unknown sources get and subscribe as null", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const { source, bundle } = yield* service.get({ sourceId: UNKNOWN_SOURCE_ID });
      assert.isNull(source);
      assert.isNull(bundle);
      const first = yield* service
        .subscribe({ sourceId: UNKNOWN_SOURCE_ID })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual([...first], [null]);
    }),
  ).pipe(Effect.provide(layerService(layerTranspiler(() => Effect.succeed("T3.render();"))))),
);

it.effect("rejects a sourceId that escapes the artifact directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const traversalId = WatchWidgetSourceId.make("watch-widget-source:../../escape");
      const { source, bundle } = yield* service.get({ sourceId: traversalId });
      assert.isNull(source);
      assert.isNull(bundle);
      const first = yield* service
        .subscribe({ sourceId: traversalId })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual([...first], [null]);
    }),
  ).pipe(Effect.provide(layerService(layerTranspiler(() => Effect.succeed("T3.render();"))))),
);

it.effect("ignores a planted meta whose artifactHash names a path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const service = yield* WidgetTranspileService.WidgetTranspileService;

      const artifactHash = "a".repeat(64);
      const sourceId = WatchWidgetSourceId.make(`watch-widget-source:${artifactHash}`);
      yield* fs.writeFileString(
        path.join(serverConfig.widgetArtifactsDir, `${artifactHash}.json`),
        JSON.stringify({
          sourceId,
          source: "T3.render();",
          manifest,
          // Would resolve outside the artifact directory if the decoded
          // record were trusted as a filename.
          artifactHash: "../../escape",
          scriptHash: null,
          status: "ready",
          failure: null,
        }),
      );

      const { source, bundle } = yield* service.get({ sourceId });
      assert.isNull(source);
      assert.isNull(bundle);
    }),
  ).pipe(
    Effect.provide(layerServiceWithDeps(layerTranspiler(() => Effect.succeed("T3.render();")))),
  ),
);

it.effect("subscribe emits the current record, then the republished one", () => {
  let calls = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const failed = yield* service.publish(input("const a = 1;"));

      const collected = yield* service
        .subscribe({ sourceId: failed.source.sourceId })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const rebuilt = yield* service.publish(input("const a = 1;"));
      assert.equal(rebuilt.source.status, "ready");

      const chunk = yield* Fiber.join(collected);
      assert.deepEqual(
        [...chunk].map((record) => record?.status ?? null),
        ["failed", "ready"],
      );
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler(() => {
          calls += 1;
          return calls === 1
            ? Effect.fail(
                new WidgetTranspileService.WidgetTranspileError({
                  reason: "failed",
                  detail: "synthetic build failure",
                }),
              )
            : Effect.succeed("T3.render();");
        }),
      ),
    ),
  );
});

it.effect("trusted publishes bypass the per-window cap without consuming it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      // Three trusted publishes under a two-per-window cap — and none of
      // them spends the agent-facing budget.
      yield* service.publishTrusted(input("const a = 1;"));
      yield* service.publishTrusted(input("const a = 2;"));
      yield* service.publishTrusted(input("const a = 3;"));
      yield* service.publish(input("const a = 4;"));
      yield* service.publish(input("const a = 5;"));
      yield* expectSourceError("publishRateLimited", service.publish(input("const a = 6;")));
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler((source) => Effect.succeed(`/* ${source} */`)),
        { maxPublishesPerWindow: 2 },
      ),
    ),
  ),
);

it.effect("remove deletes the artifact files and emits a tombstone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const service = yield* WidgetTranspileService.WidgetTranspileService;

      const { source } = yield* service.publish(input("const a = 1;"));
      const collected = yield* service
        .subscribe({ sourceId: source.sourceId })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* service.remove({ sourceId: source.sourceId });

      const chunk = yield* Fiber.join(collected);
      assert.deepEqual(
        [...chunk].map((record) => record?.status ?? null),
        ["ready", null],
      );

      const { source: gone, bundle } = yield* service.get({ sourceId: source.sourceId });
      assert.isNull(gone);
      assert.isNull(bundle);
      const artifactFile = path.join(serverConfig.widgetArtifactsDir, `${source.artifactHash}.js`);
      const metaFile = path.join(serverConfig.widgetArtifactsDir, `${source.artifactHash}.json`);
      assert.isFalse(yield* fs.exists(artifactFile));
      assert.isFalse(yield* fs.exists(metaFile));

      // A second removal is a no-op, not an error.
      yield* service.remove({ sourceId: source.sourceId });
    }),
  ).pipe(
    Effect.provide(layerServiceWithDeps(layerTranspiler(() => Effect.succeed("T3.render();")))),
  ),
);

/**
 * A minimal `EsbuildModule` stand-in for `makeBuild`: only `context` and
 * `formatMessagesSync` are exercised by the transpiler.
 */
const fakeEsbuildModule = (options: {
  readonly rebuild: () => Promise<unknown>;
  readonly cancel?: () => Promise<void>;
  readonly dispose?: () => Promise<void>;
}) =>
  ({
    context: () =>
      Promise.resolve({
        rebuild: options.rebuild,
        cancel: options.cancel ?? (() => Promise.resolve()),
        dispose: options.dispose ?? (() => Promise.resolve()),
      }),
    formatMessagesSync: (messages: ReadonlyArray<{ text?: string }>) =>
      messages.map((message) => message.text ?? ""),
  }) as unknown as WidgetTranspileService.EsbuildModule;

it.effect("a timed-out build cancels and disposes the esbuild context", () => {
  let cancels = 0;
  let disposes = 0;
  const fake = fakeEsbuildModule({
    rebuild: () => new Promise<never>(() => {}),
    cancel: () => {
      cancels += 1;
      return Promise.resolve();
    },
    dispose: () => {
      disposes += 1;
      return Promise.resolve();
    },
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      // The test clock never advances on its own: the publish runs on a
      // fiber while the timeout horizon is pushed past it.
      const publishing = yield* service
        .publish(input("const a = 1;"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(100);
      const { source } = yield* Fiber.join(publishing);
      assert.equal(source.status, "failed");
      assert.include(source.failure?.detail ?? "", "exceeded the 50ms limit");
      // Interruption routes to ctx.cancel() — via the rebuild abort signal
      // and the scope finalizer — so the work stops, not just the wait.
      assert.isTrue(cancels >= 1);
      assert.equal(disposes, 1);
    }),
  ).pipe(
    Effect.provide(
      layerService(layerTranspiler(WidgetTranspileService.makeBuild(fake)), {
        transpileTimeoutMs: 50,
      }),
    ),
  );
});

it.effect("a transient esbuild error records failed and does not latch", () => {
  let builds = 0;
  const fake = fakeEsbuildModule({
    rebuild: () => {
      builds += 1;
      return builds === 1
        ? Promise.reject(new Error("The service was stopped"))
        : Promise.resolve({ outputFiles: [{ text: "T3.render();" }], warnings: [], errors: [] });
    },
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const first = yield* service.publish(input("const a = 1;"));
      assert.equal(first.source.status, "failed");
      assert.equal(first.source.failure?.cause, "transpileFailed");
      // A wedged service is not a missing binary — the detail must say so
      // and the next publish must retry the transpiler instead of
      // fast-failing from the latch.
      assert.include(first.source.failure?.detail ?? "", "unexpectedly");
      const second = yield* service.publish(input("const a = 2;"));
      assert.equal(second.source.status, "ready");
      assert.equal(builds, 2);
    }),
  ).pipe(
    Effect.provide(
      layerService(
        Layer.effect(
          WidgetTranspileService.WidgetSourceTranspiler,
          Effect.map(
            WidgetTranspileService.makeTranspile(WidgetTranspileService.makeBuild(fake)),
            (transpile) => ({
              transpile,
            }),
          ),
        ),
      ),
    ),
  );
});

it.effect("a missing platform binary still latches unavailable", () => {
  let contexts = 0;
  const fake = {
    context: () => {
      contexts += 1;
      return Promise.reject(
        new Error("spawn /app/node_modules/@esbuild/linux-x64/bin/esbuild ENOENT"),
      );
    },
    formatMessagesSync: (messages: ReadonlyArray<{ text?: string }>) =>
      messages.map((message) => message.text ?? ""),
  } as unknown as WidgetTranspileService.EsbuildModule;
  return Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const first = yield* service.publish(input("const a = 1;"));
      assert.equal(first.source.status, "failed");
      assert.include(first.source.failure?.detail ?? "", "platform binary");
      const second = yield* service.publish(input("const a = 2;"));
      assert.equal(second.source.status, "failed");
      // The latch fast-fails the second publish without re-probing esbuild.
      assert.equal(contexts, 1);
    }),
  ).pipe(
    Effect.provide(
      layerService(
        Layer.effect(
          WidgetTranspileService.WidgetSourceTranspiler,
          Effect.map(
            WidgetTranspileService.makeTranspile(WidgetTranspileService.makeBuild(fake)),
            (transpile) => ({
              transpile,
            }),
          ),
        ),
      ),
    ),
  );
});

it.effect("a ready cache hit does not spend the publish budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      yield* service.publish(input("const a = 1;"));
      // Republishing the cached {source, manifest} returns the artifact
      // without consuming the one-per-window admission slot.
      const hit = yield* service.publish(input("const a = 1;"));
      assert.equal(hit.source.status, "ready");
      yield* expectSourceError("publishRateLimited", service.publish(input("const a = 2;")));
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler((source) => Effect.succeed(`/* ${source} */`)),
        { maxPublishesPerWindow: 1 },
      ),
    ),
  ),
);

it.effect("evicts the oldest artifact pairs past the count cap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const service = yield* WidgetTranspileService.WidgetTranspileService;

      const dir = serverConfig.widgetArtifactsDir;
      const stamp = (artifactHash: string, ms: number) =>
        Effect.all(
          [
            fs.utimes(path.join(dir, `${artifactHash}.js`), ms, ms),
            fs.utimes(path.join(dir, `${artifactHash}.json`), ms, ms),
          ],
          { discard: true },
        );

      const first = yield* service.publish(input("const a = 1;"));
      yield* stamp(first.source.artifactHash, 1_000);
      const second = yield* service.publish(input("const b = 2;"));
      yield* stamp(second.source.artifactHash, 2_000);
      const third = yield* service.publish(input("const c = 3;"));
      yield* stamp(third.source.artifactHash, 3_000);
      // Crossing the two-pair cap evicts the oldest pairs — both of them.
      const fourth = yield* service.publish(input("const d = 4;"));

      for (const hash of [first, second].map(({ source }) => source.artifactHash)) {
        assert.isFalse(yield* fs.exists(path.join(dir, `${hash}.js`)));
        assert.isFalse(yield* fs.exists(path.join(dir, `${hash}.json`)));
      }
      for (const hash of [third, fourth].map(({ source }) => source.artifactHash)) {
        assert.isTrue(yield* fs.exists(path.join(dir, `${hash}.js`)));
        assert.isTrue(yield* fs.exists(path.join(dir, `${hash}.json`)));
      }

      // Eviction drops the cached record too: `get` reports the same
      // missing-source state an explicit `remove` would.
      const { source, bundle } = yield* service.get({ sourceId: first.source.sourceId });
      assert.isNull(source);
      assert.isNull(bundle);
    }),
  ).pipe(
    Effect.provide(
      layerServiceWithDeps(
        layerTranspiler(() => Effect.succeed("T3.render();")),
        {
          maxArtifacts: 2,
        },
      ),
    ),
  ),
);

it.effect("evicts the oldest artifact pair past the byte cap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const service = yield* WidgetTranspileService.WidgetTranspileService;

      const first = yield* service.publish(input("const a = 1;"));
      // A one-byte budget is below a single pair, but the pair just written
      // is never evicted by the publish that created it — the next publish
      // is what pushes the oldest out.
      const second = yield* service.publish(input("const b = 2;"));

      const dir = serverConfig.widgetArtifactsDir;
      assert.isFalse(yield* fs.exists(path.join(dir, `${first.source.artifactHash}.js`)));
      assert.isFalse(yield* fs.exists(path.join(dir, `${first.source.artifactHash}.json`)));
      const { source, bundle } = yield* service.get({ sourceId: second.source.sourceId });
      assert.equal(source?.status, "ready");
      assert.isNotNull(bundle);
    }),
  ).pipe(
    Effect.provide(
      layerServiceWithDeps(
        layerTranspiler(() => Effect.succeed("T3.render();")),
        {
          maxArtifactBytes: 1,
        },
      ),
    ),
  ),
);

it.effect("escapes </script> in the artifact and hashes the escaped bytes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* WidgetTranspileService.WidgetTranspileService;
      const { source } = yield* service.publish(input("const html = '</script>';"));
      assert.equal(source.status, "ready");

      const { bundle } = yield* service.get({ sourceId: source.sourceId });
      if (bundle === null) assert.fail("expected the emitted bundle");
      assert.notInclude(bundle, "</script");
      assert.include(bundle, "<\\/script");
      // The CSP hash covers the escaped bytes exactly as served.
      assert.equal(
        source.scriptHash,
        NodeCrypto.createHash("sha256").update(bundle, "utf8").digest("base64"),
      );
      // `\/` is the same character as `/` to the parser — the artifact
      // still parses as a self-contained function body.
      assert.doesNotThrow(() => new Function(bundle));
    }),
  ).pipe(
    Effect.provide(
      layerService(
        layerTranspiler(() => Effect.succeed('var html = "</script>";\nT3.render(() => html);')),
      ),
    ),
  ),
);
