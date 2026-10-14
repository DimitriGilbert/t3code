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
      const publishing = yield* service.publish(input("const a = 1;")).pipe(Effect.forkChild);
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
