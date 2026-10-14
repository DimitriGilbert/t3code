// @effect-diagnostics nodeBuiltinImport:off - resolves the on-disk fixture pack directory.
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type WatchConnectorStreamItem,
  type WatchConnectorSubscribeInput,
  type WatchNotificationEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { UserNotificationService } from "../../notifications/UserNotificationService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as WidgetTranspileService from "../WidgetTranspileService.ts";
import * as ConfirmationTokens from "./ConfirmationTokens.ts";
import * as ConnectorPoller from "./ConnectorPoller.ts";
import * as ConnectorService from "./ConnectorService.ts";
import * as FileTransport from "./FileTransport.ts";
import * as PackStore from "./PackStore.ts";

/**
 * Journey-5 coverage over the real service stack: the fixture Clanker pack
 * (`../__fixtures__/clanker-pack`) is installed through the real
 * request → prepare → confirm gate, a file-transport instance watches a
 * project `.clanker` directory, and `runs/<id>/state.json` writes drive
 * snapshots through fs.watch → debounce → forced run → transform → push.
 *
 * These are `it.live` tests on purpose: the 250ms debounce and the push rate
 * cap ride the real Clock, and the latency gate measures real elapsed time.
 * The subscriber requests a 60s interval so a scheduled poll can never
 * produce a push inside the test — every post-initial snapshot proves the
 * fs.watch signal forced the run.
 */

// Layers merged this way see every service provided later in the chain —
// siblings inside one Layer.mergeAll would not.
const layerInfra = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ServerSecretStore.layer,
  ConfirmationTokens.layer,
).pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "watch-file-latency-" })),
  Layer.provideMerge(NodeServices.layer),
);

const notificationsStub = (emitted: Queue.Queue<WatchNotificationEvent>) =>
  Layer.succeed(UserNotificationService, {
    subscribe: () => Stream.empty,
    history: () => Effect.die(new Error("history is not used by the connector poller")),
    getPrefs: () => Effect.die(new Error("getPrefs is not used by the connector poller")),
    setPrefs: () => Effect.die(new Error("setPrefs is not used by the connector poller")),
    emit: (notification) => Queue.offer(emitted, notification).pipe(Effect.as({ recorded: true })),
    awaitStarted: () => Effect.void,
    awaitProcessed: () => Effect.void,
  } satisfies UserNotificationService["Service"]);

/** Echo transpiler — the poller never publishes; connector confirm does. */
const layerWidgetTranspile = WidgetTranspileService.makeLayer().pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(WidgetTranspileService.WidgetSourceTranspiler, {
        transpile: (source) => Effect.succeed(source),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "watch-file-latency-widget-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
      NodeServices.layer,
    ),
  ),
);

const layerConnectors = (emitted: Queue.Queue<WatchNotificationEvent>) =>
  ConnectorService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerInfra,
        PackStore.layerPackFetch,
        notificationsStub(emitted),
        layerWidgetTranspile,
      ),
    ),
  );

const layerPoller = (emitted: Queue.Queue<WatchNotificationEvent>) =>
  ConnectorPoller.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(layerConnectors(emitted), notificationsStub(emitted))),
  );

const FIXTURE_PACK_DIR = NodePath.resolve(import.meta.dirname, "../__fixtures__/clanker-pack");

/** Installs the on-disk fixture pack through the real human-confirm gate. */
const installFixturePack = Effect.gen(function* () {
  const svc = yield* ConnectorService.ConnectorService;
  const { request } = yield* svc.requestInstall({
    origin: { kind: "localPath", path: FIXTURE_PACK_DIR },
  });
  const prepared = yield* svc.prepareInstallConfirm({ requestId: request.id });
  const { pack } = yield* svc.confirmInstall({
    requestId: request.id,
    confirmationToken: prepared.confirmationToken,
  });
  assert.equal(pack.packId, "pack.fixture.clanker");
  return pack;
});

/** Drains a subscription into a queue so tests await items instead of polling. */
const drain = (input: WatchConnectorSubscribeInput) =>
  Effect.gen(function* () {
    const poller = yield* ConnectorPoller.ConnectorPoller;
    const seen = yield* Queue.unbounded<WatchConnectorStreamItem>();
    yield* poller.subscribe(input).pipe(
      Stream.runForEach((item) => Queue.offer(seen, item).pipe(Effect.asVoid)),
      Effect.forkChild,
    );
    return seen;
  });

interface ClankerRunRow {
  readonly runId: string;
  readonly status: string;
  readonly currentStep: string | null;
  readonly stepsCompleted: number;
  readonly result: unknown;
}

const isRecord = Predicate.isObject;

/** Narrows a snapshot item's `data` to the fixture pack's clanker-runs shape. */
const clankerRuns = (item: WatchConnectorStreamItem): ReadonlyArray<ClankerRunRow> => {
  assert.equal(item.type, "snapshot");
  if (item.type !== "snapshot") return [];
  const data = item.snapshot.data;
  assert.isTrue(isRecord(data), "snapshot data is not an object");
  assert.equal((data as { kind?: unknown }).kind, "clanker-runs");
  const runs = (data as { runs?: unknown }).runs;
  assert.isArray(runs);
  return runs as ReadonlyArray<ClankerRunRow>;
};

/**
 * Blocks until a snapshot containing `runId` arrives — optionally satisfying
 * an extra predicate on that run row. An error item fails the test with the
 * typed cause instead of silently looping.
 */
const awaitRunSnapshot = (
  seen: Queue.Queue<WatchConnectorStreamItem>,
  runId: string,
  predicate?: (run: ClankerRunRow) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const item = yield* Queue.take(seen);
      if (item.type === "error") {
        assert.fail(`expected a snapshot for ${runId}, got an error item: ${item.error.cause}`);
      }
      const run = clankerRuns(item).find((entry) => entry.runId === runId);
      if (run !== undefined && (predicate === undefined || predicate(run))) {
        return item;
      }
    }
  });

/** Blocks for the next snapshot item regardless of content. */
const awaitSnapshot = (seen: Queue.Queue<WatchConnectorStreamItem>) =>
  Effect.gen(function* () {
    while (true) {
      const item = yield* Queue.take(seen);
      if (item.type === "error") {
        assert.fail(`expected a snapshot, got an error item: ${item.error.cause}`);
      }
      return item;
    }
  });

/** Blocks for the next error item and returns its typed cause. */
const awaitErrorCause = (seen: Queue.Queue<WatchConnectorStreamItem>) =>
  Effect.gen(function* () {
    while (true) {
      const item = yield* Queue.take(seen);
      if (item.type === "error") return item.error.cause;
    }
  });

/** Clanker's PersistedRunState shape for a stub run. */
const stateJson = (
  runId: string,
  status: "running" | "completed" | "failed",
  steps: Record<string, string>,
) =>
  JSON.stringify({
    runId,
    workflowName: "fixture-flow",
    workflowPath: "fixture-flow.yaml",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    status,
    steps: Object.fromEntries(
      Object.entries(steps).map(([name, stepStatus]) => [name, { status: stepStatus }]),
    ),
  });

/** Writes `runs/<runId>/state.json` under the watched `.clanker` dir. */
const writeRunState = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  clankerDir: string,
  runId: string,
  content: string,
) =>
  Effect.gen(function* () {
    const runDir = path.join(clankerDir, "runs", runId);
    yield* fs.makeDirectory(runDir, { recursive: true });
    yield* fs.writeFileString(path.join(runDir, "state.json"), content);
  });

it.live(
  "a clanker run state.json write reaches a subscriber as a snapshot through wave progress and completion",
  () =>
    Effect.gen(function* () {
      const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
      yield* Effect.gen(function* () {
        const svc = yield* ConnectorService.ConnectorService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pack = yield* installFixturePack;
        const project = yield* fs.makeTempDirectory({ prefix: "watch-clanker-proj-" });
        const clankerDir = path.join(project, ".clanker");
        yield* fs.makeDirectory(path.join(clankerDir, "runs"), { recursive: true });
        const { instance } = yield* svc.createInstance({
          packId: pack.packId,
          config: { watch: { roots: [clankerDir], globs: ["**/*.json"] } },
        });
        // A 60s request keeps the scheduled poll out of the test: every
        // post-initial push is an fs.watch-forced run.
        const seen = yield* drain({
          instanceId: instance.id,
          refreshPolicy: { intervalMs: 60_000 },
        });
        assert.deepEqual(clankerRuns(yield* awaitSnapshot(seen)), []);

        // Run appears.
        yield* writeRunState(
          fs,
          path,
          clankerDir,
          "run-1",
          stateJson("run-1", "running", { plan: "running", build: "pending" }),
        );
        const started = yield* awaitRunSnapshot(seen, "run-1");
        const startedRun = clankerRuns(started)[0]!;
        assert.equal(startedRun.status, "running");
        assert.equal(startedRun.currentStep, "plan");

        // Wave progress: plan lands, build picks up.
        yield* writeRunState(
          fs,
          path,
          clankerDir,
          "run-1",
          stateJson("run-1", "running", { plan: "passed", build: "running" }),
        );
        const progressed = yield* awaitRunSnapshot(
          seen,
          "run-1",
          (run) => run.currentStep === "build",
        );
        assert.equal(clankerRuns(progressed)[0]!.stepsCompleted, 1);

        // Finish: final state plus the run's result.json.
        yield* writeRunState(
          fs,
          path,
          clankerDir,
          "run-1",
          stateJson("run-1", "completed", { plan: "passed", build: "passed" }),
        );
        yield* fs.writeFileString(
          path.join(clankerDir, "runs", "run-1", "result.json"),
          JSON.stringify({ runId: "run-1", success: true, cancelled: false, steps: [] }),
        );
        const finished = yield* awaitRunSnapshot(
          seen,
          "run-1",
          (run) => run.status === "completed" && run.result !== null,
        );
        const finishedRun = clankerRuns(finished)[0]!;
        assert.equal(finishedRun.stepsCompleted, 2);
        assert.isNotNull(finishedRun.result);

        const row = (yield* svc.list({})).instances.find((entry) => entry.id === instance.id);
        assert.equal(row?.health.status, "healthy");
      }).pipe(Effect.provide(layerPoller(emitted)));
    }),
);

it.live(
  "a watched file over the cap surfaces a typed error and the instance recovers on removal",
  () =>
    Effect.gen(function* () {
      const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
      yield* Effect.gen(function* () {
        const svc = yield* ConnectorService.ConnectorService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pack = yield* installFixturePack;
        const project = yield* fs.makeTempDirectory({ prefix: "watch-clanker-cap-" });
        const clankerDir = path.join(project, ".clanker");
        yield* fs.makeDirectory(path.join(clankerDir, "runs"), { recursive: true });
        const { instance } = yield* svc.createInstance({
          packId: pack.packId,
          // A 1s floor keeps the post-failure backoff deadline short: forced
          // wakes defer to it, so recovery lands ~1s after the fix instead of
          // a full poll interval.
          config: {
            pollFloorMs: 1_000,
            watch: { roots: [clankerDir], globs: ["**/*.json"] },
          },
        });
        const seen = yield* drain({
          instanceId: instance.id,
          refreshPolicy: { intervalMs: 1_000 },
        });
        assert.deepEqual(clankerRuns(yield* awaitSnapshot(seen)), []);

        // Journey 2's "kill" leg on the file transport: a watched file over
        // the per-file cap fails the run as a config problem, not an outage.
        const oversized = path.join(clankerDir, "runs", "oversized.json");
        yield* fs.writeFileString(oversized, "x".repeat(FileTransport.MAX_WATCH_FILE_BYTES + 1));
        assert.equal(yield* awaitErrorCause(seen), "configMismatch");
        assert.equal(
          (yield* svc.list({})).instances.find((entry) => entry.id === instance.id)?.health.status,
          "unhealthy",
        );

        // Recovery: removing the offending file triggers a run that pushes a
        // fresh snapshot and returns health to healthy — no restart needed.
        yield* fs.remove(oversized);
        yield* writeRunState(
          fs,
          path,
          clankerDir,
          "recovered",
          stateJson("recovered", "running", { plan: "running" }),
        );
        const recovered = yield* awaitRunSnapshot(seen, "recovered");
        assert.equal(clankerRuns(recovered)[0]!.status, "running");
        const health = (yield* svc.list({})).instances.find(
          (entry) => entry.id === instance.id,
        )?.health;
        assert.equal(health?.status, "healthy");
        assert.equal(health?.consecutiveFailures, 0);
      }).pipe(Effect.provide(layerPoller(emitted)));
    }),
);

const RUNS = 24;

it.live(`file-write → snapshot-push latency p95 ≤ 1s across ${RUNS} isolated writes`, () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pack = yield* installFixturePack;

      interface Rig {
        readonly clankerDir: string;
        readonly seen: Queue.Queue<WatchConnectorStreamItem>;
      }

      // Setup: one instance per run, each watching its own .clanker root —
      // a measured write lands on a quiet instance, so its push is not
      // delayed behind the poller's 1Hz burst-coalescing cap (which is
      // correct behavior for back-to-back writes, and would hide the
      // single-write latency being measured).
      const rigs: Array<Rig> = [];
      for (let i = 0; i < RUNS; i += 1) {
        const project = yield* fs.makeTempDirectory({ prefix: `watch-lat-${i}-` });
        const clankerDir = path.join(project, ".clanker");
        yield* fs.makeDirectory(path.join(clankerDir, "runs"), { recursive: true });
        const { instance } = yield* svc.createInstance({
          packId: pack.packId,
          config: { watch: { roots: [clankerDir], globs: ["**/*.json"] } },
        });
        const seen = yield* drain({
          instanceId: instance.id,
          refreshPolicy: { intervalMs: 60_000 },
        });
        rigs.push({ clankerDir, seen });
      }

      // Warmup per instance: await the initial snapshot, then a write whose
      // push can only come from an fs.watch-forced run (the interval is
      // 60s) — the file watcher is proven attached before the timed write.
      for (let i = 0; i < RUNS; i += 1) {
        const rig = rigs[i]!;
        assert.deepEqual(clankerRuns(yield* awaitSnapshot(rig.seen)), []);
        yield* writeRunState(
          fs,
          path,
          rig.clankerDir,
          `warm-${i}`,
          stateJson(`warm-${i}`, "running", { s: "running" }),
        );
        yield* awaitRunSnapshot(rig.seen, `warm-${i}`);
      }

      // Measured writes: one per instance. The last push on each instance
      // is by now far older than the 1s publish gap (the whole warmup ran
      // in between), so nothing in the measured span is rate-coalesced —
      // it is debounce + collect + transform + publish.
      const latencies: Array<number> = [];
      for (let i = 0; i < RUNS; i += 1) {
        const rig = rigs[i]!;
        const marker = `latency-${i}`;
        const startedAt = yield* Clock.currentTimeMillis;
        yield* writeRunState(
          fs,
          path,
          rig.clankerDir,
          marker,
          stateJson(marker, "running", { plan: "running" }),
        );
        yield* awaitRunSnapshot(rig.seen, marker);
        latencies.push((yield* Clock.currentTimeMillis) - startedAt);
      }

      const sorted = [...latencies].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)]!;
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      const max = sorted[sorted.length - 1]!;
      yield* Effect.logInfo(
        `watch file-write→snapshot-push latency ms — n=${RUNS} p50=${p50} p95=${p95} max=${max} all=[${sorted.join(",")}]`,
      );
      assert.isAtMost(p95, 1_000);
    }).pipe(Effect.provide(layerPoller(emitted)));
  }),
);
