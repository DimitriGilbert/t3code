import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  isUnknownUnionMember,
  WatchConnectorError,
  WatchWidgetId,
  type WatchConnectorInstanceId,
  type WatchConnectorStreamItem,
  type WatchConnectorSubscribeInput,
  type WatchNotificationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { UserNotificationService } from "../../notifications/UserNotificationService.ts";
import * as WatchPageService from "../WatchPageService.ts";
import * as WidgetTranspileService from "../WidgetTranspileService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ConfirmationTokens from "./ConfirmationTokens.ts";
import * as ConnectorPoller from "./ConnectorPoller.ts";
import * as ConnectorService from "./ConnectorService.ts";
import * as HttpTransport from "./HttpTransport.ts";
import * as PackStore from "./PackStore.ts";

// Layers merged this way see every service provided later in the chain —
// siblings inside one Layer.mergeAll would not.
const layerInfra = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ServerSecretStore.layer,
  ConfirmationTokens.layer,
).pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "watch-poller-" })),
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
      ServerConfig.layerTest(process.cwd(), { prefix: "watch-poller-widget-" }).pipe(
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
    Layer.provideMerge(
      Layer.mergeAll(
        layerConnectors(emitted),
        notificationsStub(emitted),
        // Same `layerInfra` reference as `layerConnectors` — the widget rows
        // a `widgetId` subscribe resolves land in the same in-memory DB.
        WatchPageService.layer.pipe(Layer.provideMerge(layerInfra)),
      ),
    ),
  );

const manifest = (overrides?: Record<string, unknown>) => ({
  id: "pack.test",
  schemaVersion: 1,
  operations: [],
  egressHosts: ["api.example.com"],
  secretKeys: ["apiKey"],
  transport: "http",
  ...overrides,
});

const writePackDir = (manifestBody: unknown, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "watch-pack-" });
    yield* fs.writeFileString(path.join(dir, "manifest.json"), JSON.stringify(manifestBody));
    for (const [name, content] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(dir, name), content);
    }
    return dir;
  });

const installPack = (files: Record<string, string>, manifestOverrides?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const svc = yield* ConnectorService.ConnectorService;
    const dir = yield* writePackDir(manifest(manifestOverrides), files);
    const { request } = yield* svc.requestInstall({ origin: { kind: "localPath", path: dir } });
    const prepared = yield* svc.prepareInstallConfirm({ requestId: request.id });
    const { pack } = yield* svc.confirmInstall({
      requestId: request.id,
      confirmationToken: prepared.confirmationToken,
    });
    return pack;
  });

/** Pack whose `fetch` hits the allowlisted endpoint; `transform` echoes the body. */
const ECHO_CONNECTOR = `module.exports = {
  fetch: async (ctx) => {
    const response = await ctx.fetch("https://api.example.com/status");
    return response.json();
  },
  transform: (raw) => raw,
};`;

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/**
 * Drains a subscription into a queue so tests await items instead of polling.
 * The drain fiber binds to the test scope, not the calling fiber — a `drain`
 * wrapped in `forkChild` (a short-lived join fiber) must not take its stream
 * down with it.
 */
const drain = (input: WatchConnectorSubscribeInput) =>
  Effect.gen(function* () {
    const poller = yield* ConnectorPoller.ConnectorPoller;
    const seen = yield* Queue.unbounded<WatchConnectorStreamItem>();
    yield* poller.subscribe(input).pipe(
      Stream.runForEach((item) => Queue.offer(seen, item).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
    return seen;
  });

/** Same as `drain`, but returns the stream fiber so a test can end the subscription. */
const drainWithFiber = (input: WatchConnectorSubscribeInput) =>
  Effect.gen(function* () {
    const poller = yield* ConnectorPoller.ConnectorPoller;
    const seen = yield* Queue.unbounded<WatchConnectorStreamItem>();
    const fiber = yield* poller.subscribe(input).pipe(
      Stream.runForEach((item) => Queue.offer(seen, item).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
    return { seen, fiber };
  });

/**
 * A real widget row bound to `instanceId` with optional stored threshold
 * rules — the only way `widgetId` subscribes pass the binding check now that
 * rules live in `config.settings.thresholds`, never on the wire.
 */
const addBoundWidget = (
  instanceId: WatchConnectorInstanceId,
  thresholds?: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const watch = yield* WatchPageService.WatchPageService;
    const { page } = yield* watch.create({ name: "Page" });
    const { widget } = yield* watch.addWidget({
      pageId: page.id,
      expectedRevision: page.revision,
      kind: "agent:threshold-widget",
      config: {
        source: { kind: "connector", binding: instanceId },
        ...(thresholds === undefined ? {} : { settings: { thresholds } }),
      },
      placement: { x: 0, y: 0, w: 4, h: 4 },
    });
    return widget;
  });

/** A plain promise gate — the fetch impl is a Promise-returning function, not an Effect. */
interface Gate {
  readonly wait: Promise<void>;
  readonly release: () => void;
}

const makeGate = (): Gate => {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
};

/**
 * A fetch impl that counts calls and logs each one into `fetchLog` — a test
 * awaiting `Queue.take(fetchLog)` knows a run is inside upstream I/O. An
 * optional `gate` pins the run in flight so ordering stays explicit.
 */
const stubFetch = (
  fetchLog: Queue.Queue<number>,
  respond: (call: number) => Response | Promise<Response>,
  gate?: Gate,
) => {
  const calls = { current: 0 };
  const impl: HttpTransport.ConnectorEgressFetchImpl = () => {
    calls.current += 1;
    const call = calls.current;
    Queue.offerUnsafe(fetchLog, call);
    const wait = gate === undefined ? Promise.resolve() : gate.wait;
    return wait.then(() => respond(call));
  };
  return { impl, calls };
};

const snapshotData = (item: WatchConnectorStreamItem | undefined) => {
  assert.isDefined(item);
  if (item === undefined || !("type" in item)) return undefined;
  assert.equal(item.type, "snapshot");
  return item.type === "snapshot" ? item.snapshot.data : undefined;
};

const errorCause = (item: WatchConnectorStreamItem | undefined) => {
  assert.isDefined(item);
  if (item === undefined || !("type" in item)) return undefined;
  assert.equal(item.type, "error");
  if (item.type === "error") {
    return isUnknownUnionMember(item.error) ? item.error.value : item.error.cause;
  }
  return undefined;
};

/**
 * A run that ignores its backoff deadline needs no clock advance — it fires on
 * real time alone — so giving the poll loop a bounded number of real
 * event-loop turns surfaces it as a `fetchLog` entry. A correctly idle loop
 * produces nothing within the bound and the test moves on.
 */
const earlyFetchCall = (fetchLog: Queue.Queue<number>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i += 1) {
      const head = yield* Queue.poll(fetchLog);
      if (Option.isSome(head)) {
        return head;
      }
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    return Option.none<number>();
  });

/**
 * `health.consecutiveFailures` is the completion signal for a failed run —
 * a run whose error item was deduplicated pushes nothing a test could await,
 * but `recordHealth` still lands inside `runOnce`. A bounded real-event-loop
 * poll (same trick as `earlyFetchCall`) observes it without advancing the
 * virtual clock, which keeps `nextRunAt = now + backoff` on the deadline the
 * test computed instead of an overshot `now`.
 */
const awaitRecordedFailures = (
  svc: ConnectorService.ConnectorService["Service"],
  instanceId: WatchConnectorInstanceId,
  count: number,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5_000; i += 1) {
      const row = (yield* svc.list({})).instances.find((entry) => entry.id === instanceId);
      if ((row?.health.consecutiveFailures ?? 0) >= count) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    return assert.fail(`timed out waiting for failure ${count} to be recorded`);
  });

/** The event union is forward-compatible — narrow off the unknown member before reading fields. */
const knownNotification = (event: WatchNotificationEvent) => {
  if (isUnknownUnionMember(event)) {
    throw new Error(`Expected a known notification type, got "${event.tag}".`);
  }
  return event;
};

it.effect("shares one upstream fetch between concurrent widget subscribers", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const gate = makeGate();
    const { impl, calls } = stubFetch(fetchLog, () => okJson({ count: 7 }), gate);
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });

      const seenA = yield* drain({ instanceId: instance.id });
      // Wait until run #1 is parked inside fetch — subscriber B then rides
      // the in-flight run instead of starting a second upstream call.
      yield* Queue.take(fetchLog);
      const seenB = yield* drain({ instanceId: instance.id });
      gate.release();

      assert.deepEqual(snapshotData(yield* Queue.take(seenA)), { count: 7 });
      assert.deepEqual(snapshotData(yield* Queue.take(seenB)), { count: 7 });
      assert.equal(calls.current, 1);
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("denies egress to an undeclared host at the fetch layer", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl, calls } = stubFetch(fetchLog, () => okJson({}));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({
        "connector.js": `module.exports = {
          fetch: async (ctx) => {
            const response = await ctx.fetch("https://evil.example.com/steal");
            return response.json();
          },
          transform: (raw) => raw,
        };`,
      });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seen = yield* drain({ instanceId: instance.id });
      // An egress allowlist violation is a policy problem, not an outage.
      assert.equal(errorCause(yield* Queue.take(seen)), "configMismatch");
      // The allowlist rejected the request before a socket ever opened.
      assert.equal(calls.current, 0);
      const listed = yield* svc.list({});
      assert.equal(listed.instances[0]?.health.status, "unhealthy");
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("backs off exponentially on consecutive failures and records health", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl, calls } = stubFetch(fetchLog, () => Promise.reject(new Error("upstream down")));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seen = yield* drain({ instanceId: instance.id });

      // Run 1 (forced) fails; default floor is 5s so the retry lands at t=5s.
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorDown");
      assert.equal(yield* Queue.take(fetchLog), 1);
      yield* TestClock.adjust(4_999);
      assert.equal(calls.current, 1);
      yield* TestClock.adjust(1);
      // Identical error items are deduplicated — the fetch itself and the
      // health row are the observable proof each retry ran.
      assert.equal(yield* Queue.take(fetchLog), 2);
      yield* awaitRecordedFailures(svc, instance.id, 2);
      // Failure #2 doubles the backoff: next run at t=15s, not t=10s.
      yield* TestClock.adjust(9_999);
      assert.equal(calls.current, 2);
      yield* TestClock.adjust(1);
      assert.equal(yield* Queue.take(fetchLog), 3);
      yield* awaitRecordedFailures(svc, instance.id, 3);
      assert.equal(calls.current, 3);

      const instanceRow = (yield* svc.list({})).instances.find((row) => row.id === instance.id);
      assert.equal(instanceRow?.health.status, "unhealthy");
      assert.equal(instanceRow?.health.consecutiveFailures, 3);
      assert.isNotNull(instanceRow?.health.lastError);
      // The unhealthy notification fires once, on the transition edge.
      assert.equal(yield* Queue.size(emitted), 1);
      const notification = knownNotification(yield* Queue.take(emitted));
      assert.equal(notification.type, "connector.unhealthy");
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("a subscriber join during backoff does not pull the retry deadline forward", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    // Runs 1 and 3 succeed; run 2 fails so a backoff deadline is pending.
    const { impl } = stubFetch(fetchLog, (call) =>
      call === 2 ? Promise.reject(new Error("upstream down")) : okJson({ n: call }),
    );
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seenA = yield* drain({ instanceId: instance.id });
      assert.deepEqual(snapshotData(yield* Queue.take(seenA)), { n: 1 });
      assert.equal(yield* Queue.take(fetchLog), 1);

      // Run 2 fires at t=5s and fails → the backoff deadline lands at t=10s.
      yield* TestClock.adjust(5_000);
      assert.equal(errorCause(yield* Queue.take(seenA)), "connectorDown");
      assert.equal(yield* Queue.take(fetchLog), 2);

      // A second subscriber replays the cache and sends a non-forced wake.
      // lastRunAt still holds run 1's success, so a naive reschedule sets the
      // deadline in the past and retries immediately; honoring backoff keeps
      // the loop idle until t=10s.
      const seenB = yield* drain({ instanceId: instance.id });
      assert.deepEqual(snapshotData(yield* Queue.take(seenB)), { n: 1 });
      const early = yield* earlyFetchCall(fetchLog);
      assert.isTrue(Option.isNone(early), "a fetch ran before the backoff deadline");

      yield* TestClock.adjust(5_000); // t=10s — the deadline fires the retry
      assert.equal(yield* Queue.take(fetchLog), 3);
      assert.deepEqual(snapshotData(yield* Queue.take(seenA)), { n: 3 });
      assert.deepEqual(snapshotData(yield* Queue.take(seenB)), { n: 3 });
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("a forced wake during backoff defers the run to the backoff deadline", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    // Run 1 fails (backoff to t=5s); the next run succeeds.
    const { impl } = stubFetch(fetchLog, (call) =>
      call === 1 ? Promise.reject(new Error("upstream down")) : okJson({ n: call }),
    );
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seenA = yield* drain({ instanceId: instance.id });
      assert.equal(errorCause(yield* Queue.take(seenA)), "connectorDown");
      assert.equal(yield* Queue.take(fetchLog), 1);
      yield* TestClock.adjust(2_000); // t=2s — mid-backoff

      // A cache-less subscriber sends a forced wake — the same path a
      // debounced fs.watch signal takes for file packs. The retry must wait
      // for the t=5s deadline instead of running immediately.
      const seenB = yield* drain({ instanceId: instance.id });
      const early = yield* earlyFetchCall(fetchLog);
      assert.isTrue(Option.isNone(early), "a fetch ran before the backoff deadline");

      yield* TestClock.adjust(3_000); // t=5s — the deadline fires the retry
      assert.equal(yield* Queue.take(fetchLog), 2);
      assert.deepEqual(snapshotData(yield* Queue.take(seenB)), { n: 2 });
      assert.deepEqual(snapshotData(yield* Queue.take(seenA)), { n: 2 });
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it("backoffDelayMs doubles per consecutive failure and clamps at the cap", () => {
  assert.equal(ConnectorPoller.backoffDelayMs(5_000, 1), 5_000);
  assert.equal(ConnectorPoller.backoffDelayMs(5_000, 2), 10_000);
  assert.equal(ConnectorPoller.backoffDelayMs(5_000, 3), 20_000);
  assert.equal(ConnectorPoller.backoffDelayMs(5_000, 20), ConnectorPoller.MAX_BACKOFF_MS);
  // A zero-ish interval cannot stay at zero forever either.
  assert.equal(ConnectorPoller.backoffDelayMs(0, 1), 0);
});

it.effect("uses the minimum subscriber interval, clamped up to the instance floor", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl, calls } = stubFetch(fetchLog, (call) => okJson({ n: call }));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const subscribe = (intervalMs: number) =>
        drain({ instanceId: instance.id, refreshPolicy: { intervalMs } });

      // Subscriber A asks for 12s — slower than its own request is honored
      // (floor is 5s): run 2 lands at t=12s.
      const seenA = yield* subscribe(12_000);
      yield* Queue.take(seenA);
      assert.equal(calls.current, 1);
      yield* TestClock.adjust(11_999);
      assert.equal(calls.current, 1);
      yield* TestClock.adjust(1);
      yield* Queue.take(seenA);
      assert.equal(calls.current, 2);
      // Subscriber B asks for 8s — the min of {12s, 8s} wins; next run at +8s.
      const seenB = yield* subscribe(8_000);
      yield* Queue.take(seenB); // cached snapshot replay, no fetch
      yield* TestClock.adjust(7_999);
      assert.equal(calls.current, 2);
      yield* TestClock.adjust(1);
      yield* Queue.take(seenA);
      yield* Queue.take(seenB);
      assert.equal(calls.current, 3);
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("clamps a subscriber's interval request up to the instance floor", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    // Distinct payload per call — identical snapshots are deduped, not republished.
    const { impl, calls } = stubFetch(fetchLog, (call) => okJson({ n: call }));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({
        packId: pack.packId,
        config: { pollFloorMs: 6_000 },
      });
      const seen = yield* drain({
        instanceId: instance.id,
        refreshPolicy: { intervalMs: 1_000 },
      });
      yield* Queue.take(seen);
      assert.equal(calls.current, 1);
      // The widget asked for 1s but the instance floor is 6s.
      yield* TestClock.adjust(5_999);
      assert.equal(calls.current, 1);
      yield* TestClock.adjust(1);
      yield* Queue.take(seen);
      assert.equal(calls.current, 2);
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("rejects oversized transform output as a typed error — never truncated", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl } = stubFetch(fetchLog, () => okJson({}));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({
        "connector.js": `module.exports = {
          fetch: async (ctx) => {
            const response = await ctx.fetch("https://api.example.com/status");
            return response.json();
          },
          transform: () => ({ blob: "x".repeat(${262144}) }),
        };`,
      });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seen = yield* drain({ instanceId: instance.id });
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorSnapshotTooLarge");
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("declared secrets resolve into pack code; undeclared keys fail the run", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl } = stubFetch(fetchLog, () => okJson({}));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({
        "connector.js": `module.exports = {
          fetch: async (ctx) => ({ keyOk: ctx.secrets.get("apiKey") === "s3cr3t" }),
          transform: (raw) => raw,
        };`,
      });
      const { instance } = yield* svc.createInstance({
        packId: pack.packId,
        config: {},
        secrets: { apiKey: "s3cr3t" },
      });
      const seen = yield* drain({ instanceId: instance.id });
      assert.deepEqual(snapshotData(yield* Queue.take(seen)), { keyOk: true });

      // A key the manifest never declared throws inside pack code and
      // surfaces as a configMismatch — the value channel stays closed.
      const badPack = yield* installPack(
        {
          "connector.js": `module.exports = {
            fetch: (ctx) => ctx.secrets.get("adminToken"),
            transform: (raw) => raw,
          };`,
        },
        { id: "pack.test2" },
      );
      const { instance: badInstance } = yield* svc.createInstance({
        packId: badPack.packId,
        config: {},
      });
      const badSeen = yield* drain({ instanceId: badInstance.id });
      assert.equal(errorCause(yield* Queue.take(badSeen)), "configMismatch");
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("pack-marked auth expiry becomes credentialsInvalid + an authExpired notification", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl } = stubFetch(fetchLog, () => okJson({}));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({
        "connector.js": `module.exports = {
          fetch: async (ctx) => { throw ctx.failAuthExpired("upstream returned 401"); },
          transform: (raw) => raw,
        };`,
      });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seen = yield* drain({ instanceId: instance.id });
      assert.equal(errorCause(yield* Queue.take(seen)), "credentialsInvalid");
      const notification = knownNotification(yield* Queue.take(emitted));
      assert.equal(notification.type, "connector.authExpired");
      const row = (yield* svc.list({})).instances.find((entry) => entry.id === instance.id);
      assert.equal(row?.health.status, "authExpired");
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("widget thresholds emit once per false-to-true crossing", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const counts = [12, 13, 1, 12];
    const { impl } = stubFetch(fetchLog, (call) =>
      okJson({ count: counts[Math.min(call - 1, counts.length - 1)] ?? 0 }),
    );
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      // No `thresholds` field exists on the wire anymore — the evaluated
      // rules are this widget row's stored `config.settings.thresholds`.
      const widget = yield* addBoundWidget(instance.id, [
        { path: "count", op: "gt", value: 5, summary: "count above 5" },
      ]);
      const seen = yield* drain({ instanceId: instance.id, widgetId: widget.id });

      // Run 1 (count=12): crossing → one notification.
      yield* Queue.take(seen);
      const first = knownNotification(yield* Queue.take(emitted));
      assert.equal(first.type, "widget.threshold");
      if (first.type === "widget.threshold") {
        assert.equal(first.widgetId, widget.id);
        assert.equal(first.summary, "count above 5");
      }
      // Run 2 (count=13): still true but latched — no second emit.
      yield* TestClock.adjust(5_000);
      yield* Queue.take(seen);
      // Run 3 (count=1): false → latch releases.
      yield* TestClock.adjust(5_000);
      yield* Queue.take(seen);
      // Run 4 (count=12): a fresh crossing emits again.
      yield* TestClock.adjust(5_000);
      yield* Queue.take(seen);
      const second = knownNotification(yield* Queue.take(emitted));
      assert.equal(second.type, "widget.threshold");
      assert.equal(yield* Queue.size(emitted), 0);
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("rejects a widgetId that does not exist or binds another instance", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl } = stubFetch(fetchLog, () => okJson({}));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const poller = yield* ConnectorPoller.ConnectorPoller;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const { instance: other } = yield* svc.createInstance({ packId: pack.packId, config: {} });

      // A widgetId naming no widget row is rejected — no arbitrary
      // attributions or stored rules may be forged through it.
      const missing = yield* poller
        .subscribe({
          instanceId: instance.id,
          widgetId: WatchWidgetId.make("watch-widget:missing"),
        })
        .pipe(Stream.runDrain, Effect.flip);
      assert.instanceOf(missing, WatchConnectorError);
      assert.equal(missing.reason, "configInvalid");

      // A real widget row bound to a different instance is foreign here.
      const foreign = yield* addBoundWidget(other.id);
      const rejected = yield* poller
        .subscribe({ instanceId: instance.id, widgetId: foreign.id })
        .pipe(Stream.runDrain, Effect.flip);
      assert.instanceOf(rejected, WatchConnectorError);
      assert.equal(rejected.reason, "configInvalid");

      // The bound instance still accepts the widget — and a connector widget
      // with no stored `thresholds` declares no rules.
      const seen = yield* drain({ instanceId: other.id, widgetId: foreign.id });
      const item = yield* Queue.take(seen);
      assert.equal("type" in item ? item.type : undefined, "snapshot");
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("file transport delivers collected contents through transform, never raw", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "watch-file-pack-" });
      yield* fs.writeFileString(path.join(root, "state.json"), `{"open":3}`);
      const pack = yield* installPack(
        {
          "connector.js": `module.exports = {
            transform: (raw, ctx) => ({
              keys: Object.keys(raw).sort(),
              open: JSON.parse(raw[Object.keys(raw)[0]])["open"],
            }),
          };`,
        },
        { transport: "file", egressHosts: [], secretKeys: [] },
      );
      const { instance } = yield* svc.createInstance({
        packId: pack.packId,
        config: { watch: { roots: [root], globs: ["*.json"] } },
      });
      const seen = yield* drain({ instanceId: instance.id });
      const item = yield* Queue.take(seen);
      assert.equal("type" in item ? item.type : undefined, "snapshot");
      if ("type" in item && item.type === "snapshot") {
        const data = item.snapshot.data;
        assert.isObject(data);
        const keys = (data as { keys: ReadonlyArray<string> }).keys;
        assert.deepEqual(
          keys.map((key) => key.split("/").pop()),
          ["state.json"],
        );
        assert.equal((data as { open: number }).open, 3);
      }
    }).pipe(Effect.provide(layerPoller(emitted)));
  }),
);

it.effect("archiving the instance publishes connectorMissing and ends the stream", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl, calls } = stubFetch(fetchLog, () => okJson({}));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seen = yield* drain({ instanceId: instance.id });
      yield* Queue.take(seen); // snapshot
      yield* svc.deleteInstance({ instanceId: instance.id });
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorMissing");
      assert.equal(calls.current, 1);
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("uninstalling the pack publishes connectorMissing and stops polling", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl, calls } = stubFetch(fetchLog, () => okJson({}));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seen = yield* drain({ instanceId: instance.id });
      yield* Queue.take(seen); // snapshot
      yield* svc.uninstall({ packId: pack.packId });
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorMissing");
      assert.equal(calls.current, 1);
      // The instance row survives, config retained, but archived.
      const archived = yield* svc.list({ includeArchived: true });
      assert.isNotNull(archived.instances[0]?.archivedAt ?? null);
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect(
  "a re-pin without a successful migrateConfig degrades to configMismatch with the field",
  () =>
    Effect.gen(function* () {
      const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
      const fetchLog = yield* Queue.unbounded<number>();
      const { impl, calls } = stubFetch(fetchLog, () => okJson({}));
      yield* Effect.gen(function* () {
        const svc = yield* ConnectorService.ConnectorService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
        const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });

        // v2 requires a `region` config field and ships no migrator — the
        // retained config fails the new manifest's schema at run time.
        const dirV2 = yield* fs.makeTempDirectory({ prefix: "watch-pack-v2-" });
        yield* fs.writeFileString(
          path.join(dirV2, "manifest.json"),
          JSON.stringify(
            manifest({
              schemaVersion: 2,
              authSchema: {
                required: ["region"],
                properties: { region: { type: "string" } },
                additionalProperties: false,
              },
            }),
          ),
        );
        yield* fs.writeFileString(path.join(dirV2, "connector.js"), ECHO_CONNECTOR);
        const { request } = yield* svc.requestUpgrade({
          packId: pack.packId,
          origin: { kind: "localPath", path: dirV2 },
          instanceId: instance.id,
        });
        const { confirmationToken } = yield* svc.prepareInstallConfirm({
          requestId: request.id,
        });
        yield* svc.confirmUpgrade({ requestId: request.id, confirmationToken });

        const seen = yield* drain({ instanceId: instance.id });
        const item = yield* Queue.take(seen);
        assert.equal("type" in item ? item.type : undefined, "error");
        if (
          "type" in item &&
          item.type === "error" &&
          !isUnknownUnionMember(item.error) &&
          item.error.cause === "configMismatch"
        ) {
          assert.equal(item.error.field, "region");
        } else {
          assert.fail("expected a configMismatch error item");
        }
        // No upstream call happened — the run stopped at config validation.
        assert.equal(calls.current, 0);
      }).pipe(
        Effect.provide(layerPoller(emitted)),
        Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
      );
    }),
);

it.effect("a subscriber joining while the last subscriber leaves keeps a live stream", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    const { impl } = stubFetch(fetchLog, (call) => okJson({ n: call }));
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const a = yield* drainWithFiber({ instanceId: instance.id });
      assert.deepEqual(snapshotData(yield* Queue.take(a.seen)), { n: 1 });

      // B's subscribe races A's shutdown. Whether B's join lands on the
      // doomed runtime or a fresh one, removal+teardown under one lifecycle
      // permit means B can never attach to a runtime that then dies — every
      // interleaving leaves B with a working stream.
      const joinB = yield* drain({ instanceId: instance.id }).pipe(Effect.forkChild);
      yield* Fiber.interrupt(a.fiber);
      const seenB = yield* Fiber.join(joinB);

      const first = yield* Queue.take(seenB);
      assert.equal("type" in first ? first.type : undefined, "snapshot");

      // The stream is still alive for the next scheduled run — a silently
      // torn-down runtime would leave the poll empty. The run takes real
      // worker time to publish, so the item is awaited on real event-loop
      // turns rather than raced against a virtual timeout.
      yield* TestClock.adjust(30_000);
      const next = yield* Effect.gen(function* () {
        for (let i = 0; i < 200_000; i += 1) {
          const item = yield* Queue.poll(seenB);
          if (Option.isSome(item)) return item;
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        }
        return Option.none<WatchConnectorStreamItem>();
      });
      assert.isTrue(
        Option.isSome(next),
        "the joined subscriber's stream ended with the old runtime",
      );
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect(
  "a resubscribed widget does not re-fire a still-true threshold; a fresh crossing emits",
  () =>
    Effect.gen(function* () {
      const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
      const fetchLog = yield* Queue.unbounded<number>();
      const counts = [12, 13, 1, 12, 14, 15];
      const { impl } = stubFetch(fetchLog, (call) =>
        okJson({ count: counts[Math.min(call - 1, counts.length - 1)] ?? 0 }),
      );
      yield* Effect.gen(function* () {
        const svc = yield* ConnectorService.ConnectorService;
        const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
        const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
        const widget = yield* addBoundWidget(instance.id, [
          { path: "count", op: "gt", value: 5, summary: "count above 5" },
        ]);
        // A threshold-less subscriber pins the runtime so the widget's leave
        // does not tear it down — the common resubscribe-under-churn case the
        // per-runtime latch is built for.
        const pinned = yield* drain({ instanceId: instance.id });
        const w1 = yield* drainWithFiber({
          instanceId: instance.id,
          widgetId: widget.id,
        });

        // Run 1 (count=12): the crossing emits once.
        yield* Queue.take(pinned);
        yield* Queue.take(w1.seen);
        const first = knownNotification(yield* Queue.take(emitted));
        assert.equal(first.type, "widget.threshold");

        // The widget unsubscribes and resubscribes — the runtime survives via
        // `pinned`, and so does the latch.
        yield* Fiber.interrupt(w1.fiber);
        const w2 = yield* drainWithFiber({
          instanceId: instance.id,
          widgetId: widget.id,
        });
        yield* Queue.take(w2.seen); // cached snapshot replay {count:12}

        // Run 2 (count=13): still true — resubscribe must not re-fire.
        yield* TestClock.adjust(5_000);
        yield* Queue.take(pinned);
        // Run 3 (count=1): false — the latch releases.
        yield* TestClock.adjust(5_000);
        yield* Queue.take(pinned);
        // Run 4 (count=12): a genuine new crossing emits exactly once.
        yield* TestClock.adjust(5_000);
        yield* Queue.take(pinned);
        const second = knownNotification(yield* Queue.take(emitted));
        assert.equal(second.type, "widget.threshold");
        // Runs 5–6 stay true: no more emits once every run has settled.
        yield* TestClock.adjust(5_000);
        yield* Queue.take(pinned);
        yield* TestClock.adjust(5_000);
        yield* Queue.take(pinned);
        assert.equal(yield* Queue.size(emitted), 0);
      }).pipe(
        Effect.provide(layerPoller(emitted)),
        Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
      );
    }),
);

it.effect("a flapping source emits at most one health notification per cooldown window", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    // fail calls {1,3,5,6,7,8,9,10,12}; succeed {2,4,11}: flap-flap, a long
    // failing stretch (exponential backoff stretches it across the cooldown
    // window cheaply), one recovery, then the post-window edge.
    const failCalls = new Set([1, 3, 5, 6, 7, 8, 9, 10, 12]);
    const { impl } = stubFetch(fetchLog, (call) =>
      failCalls.has(call) ? Promise.reject(new Error("flapping upstream")) : okJson({ n: call }),
    );
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({ packId: pack.packId, config: {} });
      const seen = yield* drain({ instanceId: instance.id });

      // t≈0 run 1 fails — the healthy→unhealthy edge emits.
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorDown");
      const first = knownNotification(yield* Queue.take(emitted));
      assert.equal(first.type, "connector.unhealthy");

      // t=5s run 2 recovers; t=10s run 3 fails — an edge inside the cooldown
      // window is still written to health_json but not re-notified.
      yield* TestClock.adjust(5_000);
      assert.deepEqual(snapshotData(yield* Queue.take(seen)), { n: 2 });
      yield* TestClock.adjust(5_000);
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorDown");
      assert.equal(yield* Queue.size(emitted), 0);

      // t=15s recovers, t=20s fails — still inside the window.
      yield* TestClock.adjust(5_000);
      yield* Queue.take(seen); // snapshot
      yield* TestClock.adjust(5_000);
      yield* Queue.take(seen); // error
      assert.equal(yield* Queue.size(emitted), 0);
      // Health rows keep recording the flap even while notifications are
      // suppressed.
      const row = (yield* svc.list({})).instances.find((entry) => entry.id === instance.id);
      assert.equal(row?.health.status, "unhealthy");

      // Sustained failure: exponential backoff stretches the runs across the
      // window — each deduplicated failure marks its completion in the
      // health row, then the clock steps to the deadline it set. Runs land
      // at 25, 35, 55, 95, 175, and 335s.
      yield* TestClock.adjust(5_000); // t=25s — run 6 fails
      yield* awaitRecordedFailures(svc, instance.id, 2);
      yield* TestClock.adjust(10_000); // t=35s — run 7 fails
      yield* awaitRecordedFailures(svc, instance.id, 3);
      yield* TestClock.adjust(20_000); // t=55s — run 8 fails
      yield* awaitRecordedFailures(svc, instance.id, 4);
      yield* TestClock.adjust(40_000); // t=95s — run 9 fails
      yield* awaitRecordedFailures(svc, instance.id, 5);
      yield* TestClock.adjust(80_000); // t=175s — run 10 fails
      yield* awaitRecordedFailures(svc, instance.id, 6);
      yield* TestClock.adjust(160_000); // t=335s — run 11 recovers
      assert.deepEqual(snapshotData(yield* Queue.take(seen)), { n: 11 });
      // t=340s run 12 fails — past the cooldown, the edge notifies again.
      yield* TestClock.adjust(5_000);
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorDown");
      const second = knownNotification(yield* Queue.take(emitted));
      assert.equal(second.type, "connector.unhealthy");
      assert.equal(yield* Queue.size(emitted), 0);
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.effect("identical error items are not republished across failed runs", () =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
    const fetchLog = yield* Queue.unbounded<number>();
    // Calls 1–3 fail identically, call 4 recovers, call 5 fails again — the
    // error payload only changes when a snapshot lands in between.
    const { impl } = stubFetch(fetchLog, (call) =>
      call === 4 ? okJson({ n: call }) : Promise.reject(new Error("upstream down")),
    );
    yield* Effect.gen(function* () {
      const svc = yield* ConnectorService.ConnectorService;
      const pack = yield* installPack({ "connector.js": ECHO_CONNECTOR });
      const { instance } = yield* svc.createInstance({
        packId: pack.packId,
        config: { pollFloorMs: 1_000 },
      });
      const seen = yield* drain({ instanceId: instance.id });

      // t≈0 run 1 fails — the first error item publishes; the 1s floor puts
      // the backoff retry at t=1s.
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorDown");
      yield* awaitRecordedFailures(svc, instance.id, 1);
      // t=1s run 2 and t=3s run 3 fail identically — nothing new is pushed,
      // so the health row (not the stream) marks each completed run.
      yield* TestClock.adjust(1_000);
      yield* awaitRecordedFailures(svc, instance.id, 2);
      yield* TestClock.adjust(2_000);
      yield* awaitRecordedFailures(svc, instance.id, 3);
      // t=7s run 4 recovers — the next queued item must be the snapshot: if
      // identical errors republished, two more error items would front it.
      yield* TestClock.adjust(4_000);
      const recovered = yield* Queue.take(seen);
      assert.equal("type" in recovered ? recovered.type : undefined, "snapshot");
      // t=8s run 5 fails again — a snapshot intervened, so the failure state
      // pushes once more instead of staying swallowed by the dedupe.
      yield* TestClock.adjust(1_000);
      assert.equal(errorCause(yield* Queue.take(seen)), "connectorDown");
      assert.isTrue(Option.isNone(yield* Queue.poll(seen)));
    }).pipe(
      Effect.provide(layerPoller(emitted)),
      Effect.provideService(HttpTransport.ConnectorEgressFetch, impl),
    );
  }),
);

it.live(
  "fs.watch signals inside the minimum run gap coalesce into one run at the gap deadline",
  () =>
    Effect.gen(function* () {
      const emitted = yield* Queue.unbounded<WatchNotificationEvent>();
      yield* Effect.gen(function* () {
        const svc = yield* ConnectorService.ConnectorService;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "watch-gap-" });
        yield* fs.writeFileString(path.join(root, "state.json"), `{"v":0}`);
        const pack = yield* installPack(
          {
            "connector.js": `module.exports = {
            transform: (raw) => ({ files: Object.keys(raw).sort() }),
          };`,
          },
          { transport: "file", egressHosts: [], secretKeys: [] },
        );
        const { instance } = yield* svc.createInstance({
          packId: pack.packId,
          config: { watch: { roots: [root], globs: ["*.json"] } },
        });
        // A 60s request keeps the scheduled poll out of the test — every
        // post-initial run is fs.watch-forced.
        const seen = yield* drain({
          instanceId: instance.id,
          refreshPolicy: { intervalMs: 60_000 },
        });
        const initial = yield* Queue.take(seen);
        assert.equal("type" in initial ? initial.type : undefined, "snapshot");
        // Let the fs.watch fiber attach before driving signals.
        yield* Effect.sleep(100);

        const lastFetchAt = Effect.map(
          svc.list({}),
          (list) =>
            list.instances.find((row) => row.id === instance.id)?.health.lastFetchAt ?? null,
        );
        /** `lastFetchAt` is rewritten by every run — the observable run counter. */
        const awaitFetchAtAfter = (previous: string | null, label: string) =>
          Effect.gen(function* () {
            for (let i = 0; i < 400; i += 1) {
              const current = yield* lastFetchAt;
              if (current !== null && current !== previous) return current;
              yield* Effect.sleep(20);
            }
            return assert.fail(`timed out waiting for a run after ${label}`);
          });
        /** Snapshot contents: the watched file basenames the transform echoed. */
        const fileNames = (item: WatchConnectorStreamItem) => {
          if (!("type" in item) || item.type !== "snapshot") {
            assert.equal("type" in item ? item.type : undefined, "snapshot");
            return [] as ReadonlyArray<string>;
          }
          const data = item.snapshot.data;
          assert.isObject(data);
          return ((data as { files?: ReadonlyArray<string> }).files ?? []).map((file) =>
            file.split("/").pop()!,
          );
        };
        /** No further run should land within ~1.2s real time. */
        const noFurtherRun = (current: string) =>
          Effect.gen(function* () {
            for (let i = 0; i < 60; i += 1) {
              if ((yield* lastFetchAt) !== current) return true;
              yield* Effect.sleep(20);
            }
            return false;
          });

        const first = yield* lastFetchAt;
        // Signal 1 → run 2 (inside the gap → deferred to lastRunAt + gap).
        yield* fs.writeFileString(path.join(root, "a.json"), `{"v":1}`);
        const second = yield* awaitFetchAtAfter(first, "signal 1");
        assert.include(fileNames(yield* Queue.take(seen)), "a.json");

        // Signals 2 and 3 inside the next gap — spaced past the 250ms debounce
        // so they are distinct forced wakes — must coalesce into ONE deferred
        // run that observes both writes.
        yield* fs.writeFileString(path.join(root, "b.json"), `{"v":2}`);
        yield* Effect.sleep(300);
        yield* fs.writeFileString(path.join(root, "c.json"), `{"v":3}`);
        const third = yield* awaitFetchAtAfter(second, "signals 2-3");
        const gapMs = Date.parse(third) - Date.parse(second);
        assert.isAtLeast(gapMs, ConnectorPoller.MIN_FORCED_RUN_GAP_MS - 100);
        const names = fileNames(yield* Queue.take(seen));
        assert.include(names, "b.json");
        assert.include(names, "c.json");
        // And the coalesced signals did not sneak a second run in.
        assert.isFalse(yield* noFurtherRun(third));
      }).pipe(Effect.provide(layerPoller(emitted)));
    }),
);
