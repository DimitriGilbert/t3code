import {
  WatchConnectorError,
  type WatchConnectorHealth,
  type WatchConnectorInstanceId,
  type WatchConnectorStreamItem,
  type WatchConnectorSubscribeInput,
  WatchConnectorThresholdRule,
  type WatchNotificationEvent,
  WatchNotificationId,
  WatchWidgetConfig,
  type WatchWidgetErrorState,
  type WatchWidgetId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { UserNotificationService } from "../../notifications/UserNotificationService.ts";
import * as ConnectorService from "./ConnectorService.ts";
import * as FileTransport from "./FileTransport.ts";
import * as HttpTransport from "./HttpTransport.ts";
import * as PackModule from "./PackModule.ts";
import * as PackStore from "./PackStore.ts";

/**
 * Per-instance poll runtime. Subscribers (widget bindings) attach with an
 * optional `refreshPolicy` request; the effective interval is the min over
 * live requests clamped up to the instance's `pollFloorMs` config floor. One
 */

/** Absolute floor — instance config can never push polling below this. */
const MIN_POLL_FLOOR_MS = 1_000;
/** Default instance floor when `config.pollFloorMs` is unset. */
const DEFAULT_POLL_FLOOR_MS = 5_000;
/** Consecutive-failure backoff ceiling. */
export const MAX_BACKOFF_MS = 15 * 60_000;
/** Minimum gap between pushed stream items; bursts coalesce to the latest. */
const MIN_PUSH_INTERVAL_MS = 1_000;
/**
 * Minimum gap between a completed run and the next *forced* run. Tied to the
 * push cadence on purpose: a forced run more frequent than `MIN_PUSH_INTERVAL_MS`
 * can rarely publish what it fetched anyway, and without it a busy watched
 */
export const MIN_FORCED_RUN_GAP_MS = MIN_PUSH_INTERVAL_MS;
/**
 * Repeat `connector.unhealthy`/`connector.authExpired` notifications for the
 * same health status are suppressed inside this window — a source flapping
 * healthy↔unhealthy every interval produces one alert per cooldown, not one
 * per edge. `health_json` keeps recording every run regardless.
 */
const HEALTH_NOTIFICATION_COOLDOWN_MS = 5 * 60_000;
/** A single run's fetch+transform budget. */
const RUN_TIMEOUT = Duration.seconds(60);

/** Backoff for the next run after `failures` consecutive failures. */
export const backoffDelayMs = (intervalMs: number, failures: number): number =>
  Math.min(intervalMs * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);

/** Poll floor from instance config: `pollFloorMs`, clamped to the absolute floor. */
const floorOf = (config: Readonly<Record<string, unknown>>): number => {
  const raw = config["pollFloorMs"];
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(MIN_POLL_FLOOR_MS, Math.floor(raw))
    : DEFAULT_POLL_FLOOR_MS;
};

// ── Threshold evaluation ─────────────────────────────────────────────────

const resolvePath = (data: unknown, path: string): unknown => {
  let current = data;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const valuesEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

const WidgetConfigJson = Schema.fromJsonString(WatchWidgetConfig);
const decodeWidgetConfigJson = Schema.decodeUnknownEffect(WidgetConfigJson);
const decodeStoredThresholds = Schema.decodeUnknownOption(
  Schema.Array(WatchConnectorThresholdRule),
);

/** One threshold rule against one snapshot. Comparisons are numeric; `eq`/`ne` compare JSON. */
const evalThresholdRule = (rule: WatchConnectorThresholdRule, data: unknown): boolean => {
  const value = resolvePath(data, rule.path);
  switch (rule.op) {
    case "exists":
      return value !== undefined && value !== null;
    case "eq":
      return valuesEqual(value, rule.value);
    case "ne":
      return !valuesEqual(value, rule.value);
    case "gt":
      return typeof value === "number" && typeof rule.value === "number" && value > rule.value;
    case "gte":
      return typeof value === "number" && typeof rule.value === "number" && value >= rule.value;
    case "lt":
      return typeof value === "number" && typeof rule.value === "number" && value < rule.value;
    case "lte":
      return typeof value === "number" && typeof rule.value === "number" && value <= rule.value;
  }
};

// ── Failure classification ───────────────────────────────────────────────

interface RunFailure {
  /** Health status written to the instance row. */
  readonly health: "unhealthy" | "authExpired";
  /** The typed widget-shell cause subscribers receive. */
  readonly cause:
    | "connectorDown"
    | "credentialsInvalid"
    | "configMismatch"
    | "connectorMissing"
    | "connectorSnapshotTooLarge";
  readonly message: string;
  /** The config field a `configInvalid` failure names — carried to the widget state. */
  readonly field?: string;
}

const isConnectorError = Schema.is(WatchConnectorError);

const classifyFailure = (cause: unknown): RunFailure => {
  // Pack callbacks reject with arbitrary values; `invokePackFunction` wraps
  // them in `UnknownError`, so unwrap before pattern-matching the markers.
  if (Cause.isUnknownError(cause)) return classifyFailure(cause.cause);
  if (cause instanceof PackModule.ConnectorAuthExpiredError) {
    return { health: "authExpired", cause: "credentialsInvalid", message: cause.message };
  }
  if (cause instanceof PackModule.ConnectorSecretAccessError) {
    return { health: "unhealthy", cause: "configMismatch", message: cause.message };
  }
  if (isConnectorError(cause)) {
    switch (cause.reason) {
      case "snapshotTooLarge":
        return { health: "unhealthy", cause: "connectorSnapshotTooLarge", message: cause.message };
      case "configInvalid":
      case "secretKeyUndeclared":
      // The declared watch set itself cannot be satisfied safely — a config
      // problem surfaced to the widget, not a flaky upstream.
      case "confinementRejected":
      case "watchLimitExceeded":
      // The pack tried an undeclared host — a policy violation by the pack's
      // own declarations, not an upstream outage.
      case "egressBlocked":
        return {
          health: "unhealthy",
          cause: "configMismatch",
          message: cause.message,
          ...(cause.field === undefined ? {} : { field: cause.field }),
        };
      case "instanceNotFound":
      case "packNotFound":
        return { health: "unhealthy", cause: "connectorMissing", message: cause.message };
      default:
        return { health: "unhealthy", cause: "connectorDown", message: cause.message };
    }
  }
  return {
    health: "unhealthy",
    cause: "connectorDown",
    message: cause instanceof Error ? cause.message : String(cause),
  };
};

const errorState = (
  failure: RunFailure,
  instanceId: WatchConnectorInstanceId,
  lastGoodDataAt: string | undefined,
): WatchWidgetErrorState => {
  const shared = lastGoodDataAt === undefined ? {} : { lastGoodDataAt };
  switch (failure.cause) {
    case "credentialsInvalid":
      return { cause: "credentialsInvalid", instanceId, ...shared };
    case "configMismatch":
      return {
        cause: "configMismatch",
        ...(failure.field === undefined ? {} : { field: failure.field }),
        ...shared,
      };
    case "connectorMissing":
      return { cause: "connectorMissing", instanceId, ...shared };
    case "connectorSnapshotTooLarge":
      return { cause: "connectorSnapshotTooLarge", instanceId, ...shared };
    default:
      return { cause: "connectorDown", instanceId, ...shared };
  }
};

// ── Runtime state ────────────────────────────────────────────────────────

interface Subscriber {
  readonly intervalMs: number | undefined;
  readonly widgetId: WatchWidgetId | undefined;
  readonly thresholds: ReadonlyArray<WatchConnectorThresholdRule>;
}

interface InstanceRuntime {
  readonly instanceId: WatchConnectorInstanceId;
  /** Reconcile key: the instance row's updated_at this runtime was built for. */
  updatedAt: string;
  readonly floorMs: Ref.Ref<number>;
  readonly subscribers: Ref.Ref<Map<string, Subscriber>>;
  /**
   * Wakes the poll loop early. `sliding(1)` coalesces bursts — `forceRequest`
   * stores the requested run *generation*, so a collapsed wake can never lose
   * a run request, and a request satisfied by an in-flight run never causes a
   * duplicate fetch: N subscribers on one instance still see one upstream call.
   */
  readonly wakes: Queue.Queue<"wake">;
  readonly forceRequest: Ref.Ref<number>;
  /** Bumped every time a run finishes — compared against `forceRequest`. */
  readonly runGeneration: Ref.Ref<number>;
  /** True while a run is executing — subscribers joining in that window share it. */
  readonly runActive: Ref.Ref<boolean>;
  readonly items: PubSub.PubSub<WatchConnectorStreamItem>;
  readonly lastSnapshot: Ref.Ref<CachedSnapshot | undefined>;
  readonly consecutiveFailures: Ref.Ref<number>;
  readonly healthStatus: Ref.Ref<WatchConnectorHealth["status"]>;
  readonly lastPublishAt: Ref.Ref<number>;
  readonly schedule: Ref.Ref<{ lastRunAt: number; nextRunAt: number }>;
  /**
   * False→true latch per `${widgetId}:${ruleIndex}`, owned by the run loop.
   * Living on the runtime (not the subscriber) means a widget resubscribing
   * while its condition stayed true does not re-alert; the latch releases
   * only when the rule reads false on a later snapshot.
   */
  readonly thresholdLatches: Ref.Ref<Map<string, boolean>>;
  /** The last published error item — identical failures are not repushed. */
  readonly lastError: Ref.Ref<WatchWidgetErrorState | undefined>;
  /** Health status → Clock time of its last emitted notification (flap cooldown). */
  readonly healthNotifiedAt: Ref.Ref<Map<string, number>>;
  /**
   * The egress impl behind `ctx.fetch`, pinned by whoever opened the runtime.
   * In production this is the default `fetch`; tests inject a stub. It is
   * pinned (not re-read per run) so a restart cannot silently swap the
   * transport a subscriber already relies on.
   */
  readonly egressFetch: HttpTransport.ConnectorEgressFetchImpl;
  scope: Scope.Closeable;
}

/** The transformed snapshot cache — `json` is the dedupe key, `item` the wire shape. */
interface CachedSnapshot {
  readonly json: string;
  readonly fetchedAt: string;
  readonly item: WatchConnectorStreamItem;
}

export class ConnectorPoller extends Context.Service<
  ConnectorPoller,
  {
    /**
     * Widget-facing connector data subscription. Emits the cached snapshot
     * immediately when one exists, then transformed snapshots and typed error
     * states as poll runs complete. The declared `refreshPolicy` contributes
     */
    readonly subscribe: (
      input: WatchConnectorSubscribeInput,
    ) => Stream.Stream<WatchConnectorStreamItem, WatchConnectorError>;
  }
>()("t3/watch/connectors/ConnectorPoller") {}

const isoNow = Effect.map(DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone), (value) =>
  DateTime.formatIso(DateTime.toUtc(value)),
);

export const layer = Layer.effect(
  ConnectorPoller,
  Effect.gen(function* () {
    const connectors = yield* ConnectorService.ConnectorService;
    const notifications = yield* UserNotificationService;
    const crypto = yield* Crypto.Crypto;
    const sql = yield* SqlClient.SqlClient;
    const packRuntime = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, yield* FileSystem.FileSystem),
      Layer.succeed(Path.Path, yield* Path.Path),
      Layer.succeed(ServerConfig.ServerConfig, yield* ServerConfig.ServerConfig),
    );
    const runtimes = yield* Ref.make(new Map<string, InstanceRuntime>());
    /** Serializes runtime create/teardown/restart so a map slot is never double-built. */
    const lifecycle = yield* Semaphore.make(1);
    /**
     * Services the forked poll loops need (collectWatchedFiles, loadInstalled).
     * Captured once at layer build and provided to each runtime fiber so a
     * subscriber's `subscribe` stream stays requirement-free.
     */
    const ambient = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
    >();

    const emitNotification = (notification: WatchNotificationEvent) =>
      notifications
        .emit(notification)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not emit connector notification", { cause }),
          ),
        );

    /**
     * Resolves a `widgetId` subscribe to the rules evaluated on snapshots.
     * The named widget row must exist and its connector source must bind the
     * subscribed instance; the rules are the row's stored
     */
    const resolveWidgetThresholds = Effect.fn("resolveWidgetThresholds")(
      function* (widgetId: WatchWidgetId, instanceId: WatchConnectorInstanceId) {
        const rows = yield* sql<{ readonly config_json: string }>`
          SELECT config_json FROM watch_widgets WHERE widget_id = ${widgetId}
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* new WatchConnectorError({
            message: `Watch widget "${widgetId}" does not exist.`,
            reason: "configInvalid",
            field: "widgetId",
            instanceId,
          });
        }
        const config = yield* decodeWidgetConfigJson(row.config_json).pipe(
          Effect.mapError(
            (cause) =>
              new WatchConnectorError({
                message: `Watch widget "${widgetId}" has an unreadable stored config.`,
                reason: "configInvalid",
                field: "widgetId",
                instanceId,
                cause,
              }),
          ),
        );
        if (config.source?.kind !== "connector" || config.source.binding !== instanceId) {
          return yield* new WatchConnectorError({
            message: `Watch widget "${widgetId}" is not bound to connector instance "${instanceId}".`,
            reason: "configInvalid",
            field: "widgetId",
            instanceId,
          });
        }
        // `settings` is widget-kind-owned free-form config: a malformed
        // `thresholds` value declares no rules rather than failing the stream.
        return Option.getOrElse(decodeStoredThresholds(config.settings?.["thresholds"]), () => []);
      },
      (effect, _widgetId, instanceId) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isConnectorError(cause)
              ? cause
              : new WatchConnectorError({
                  message: "Could not load the subscribing widget's config.",
                  reason: "fetchFailed",
                  instanceId,
                  cause,
                }),
          ),
        ),
    );

    const effectiveIntervalMs = Effect.fn("effectiveIntervalMs")(function* (rt: InstanceRuntime) {
      const floor = yield* Ref.get(rt.floorMs);
      let requested: number | undefined;
      for (const sub of (yield* Ref.get(rt.subscribers)).values()) {
        if (sub.intervalMs === undefined) continue;
        requested = requested === undefined ? sub.intervalMs : Math.min(requested, sub.intervalMs);
      }
      return Math.max(floor, requested ?? floor);
    });

    /**
     * One fetch→transform pass for an instance: pack is re-read from disk and
     * re-verified against the pinned content hash every run, the entry module
     * is invoked inside a fresh worker thread, and secrets resolve per-call
     */
    const runPipeline = Effect.fn("runPipeline")(
      function* (rt: InstanceRuntime) {
        const info = yield* connectors.loadRuntime(rt.instanceId);
        yield* Ref.set(rt.floorMs, floorOf(info.instance.config));
        // Config is re-validated against the pinned manifest every run: a
        // re-pin without a successful migrateConfig leaves the old config in
        // place, and that must surface as `configMismatch`, not run anyway.
        const configError = ConnectorService.validateConfigAgainstManifest(
          info.manifest,
          info.instance.config,
        );
        if (configError !== null) return yield* configError;
        const bundle = yield* PackStore.loadInstalled(
          info.instance.packId,
          info.instance.contentHash,
        ).pipe(Effect.provide(packRuntime));
        const mod = yield* PackModule.evalConnectorModule(bundle.files);
        const baseCtx = {
          config: info.instance.config,
          secrets: PackModule.makeSecretsAccessor(info.manifest.secretKeys, info.secrets),
          failAuthExpired: (message: string) => new PackModule.ConnectorAuthExpiredError(message),
        };
        let raw: unknown;
        let ctx: PackModule.ConnectorModuleContext;
        if (info.manifest.transport === "file") {
          const spec = yield* FileTransport.parseFileWatchConfig(info.instance.config);
          const files = yield* FileTransport.collectWatchedFiles(spec);
          ctx = { ...baseCtx, files };
          const fetchFn = mod.fetch;
          raw =
            fetchFn === undefined
              ? files
              : yield* PackModule.invokePackFunction(() => fetchFn(ctx));
        } else {
          const fetchFn = mod.fetch;
          if (fetchFn === undefined) {
            return yield* new WatchConnectorError({
              message: `HTTP connector pack must export a "fetch" function.`,
              reason: "packCodeInvalid",
            });
          }
          ctx = {
            ...baseCtx,
            fetch: HttpTransport.makeEgressFetch({
              egressHosts: info.manifest.egressHosts,
              fetchImpl: rt.egressFetch,
            }),
          };
          raw = yield* PackModule.invokePackFunction(() => fetchFn(ctx));
        }
        const transformFn = mod.transform;
        const data =
          transformFn === undefined
            ? raw
            : yield* PackModule.invokePackFunction(() => transformFn(raw, ctx));
        const json = yield* PackModule.serializeSnapshot(data);
        return { json, data };
      },
      // Pack code runs in a worker thread the run owns: the timeout bounds
      // the wait AND the work — interruption terminates the worker, so a
      // hung or spinning pack cannot outlive the run deadline.
      Effect.timeout(RUN_TIMEOUT),
      Effect.mapError(classifyFailure),
    );

    /** Rate-capped publish: pushes are at least `MIN_PUSH_INTERVAL_MS` apart. */
    const publishItem = Effect.fn("publishItem")(function* (
      rt: InstanceRuntime,
      item: WatchConnectorStreamItem,
    ) {
      const gap =
        MIN_PUSH_INTERVAL_MS -
        (yield* Clock.currentTimeMillis) +
        (yield* Ref.get(rt.lastPublishAt));
      if (gap > 0) yield* Effect.sleep(gap);
      yield* Ref.set(rt.lastPublishAt, yield* Clock.currentTimeMillis);
      yield* PubSub.publish(rt.items, item);
    });

    /**
     * Threshold crossings — only changed snapshots reach here. The latch is
     * keyed `${widgetId}:${ruleIndex}` on the runtime, so it survives a widget
     * resubscribe (remount, reconnect): a rule that stayed true cannot
     */
    const evalThresholds = Effect.fn("evalThresholds")(function* (
      rt: InstanceRuntime,
      data: unknown,
      nowIso: string,
    ) {
      const latches = yield* Ref.get(rt.thresholdLatches);
      for (const sub of (yield* Ref.get(rt.subscribers)).values()) {
        if (sub.widgetId === undefined) continue;
        for (let index = 0; index < sub.thresholds.length; index += 1) {
          const rule = sub.thresholds[index]!;
          const key = `${sub.widgetId}:${index}`;
          const hit = evalThresholdRule(rule, data);
          if (hit && latches.get(key) !== true) {
            latches.set(key, true);
            yield* emitNotification({
              type: "widget.threshold",
              notificationId: WatchNotificationId.make(
                `watch-notification:widget.threshold:${rt.instanceId}:${sub.widgetId}:${index}:${nowIso}`,
              ),
              createdAt: nowIso,
              widgetId: sub.widgetId,
              instanceId: rt.instanceId,
              ...(rule.summary === undefined ? {} : { summary: rule.summary }),
            });
          } else if (!hit) {
            latches.delete(key);
          }
        }
      }
    });

    const runOnce = Effect.fn("runOnce")(function* (rt: InstanceRuntime) {
      const interval = yield* effectiveIntervalMs(rt);
      const result = yield* Effect.result(runPipeline(rt));
      const now = yield* Clock.currentTimeMillis;
      const nowIso = yield* isoNow;
      if (Result.isSuccess(result)) {
        yield* Ref.set(rt.consecutiveFailures, 0);
        yield* Ref.set(rt.schedule, { lastRunAt: now, nextRunAt: now + interval });
        yield* Ref.set(rt.healthStatus, "healthy");
        yield* connectors
          .recordHealth(rt.instanceId, {
            status: "healthy",
            lastError: null,
            lastFetchAt: nowIso,
            consecutiveFailures: 0,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not record connector health", { cause }),
            ),
          );
        const last = yield* Ref.get(rt.lastSnapshot);
        if (last === undefined || last.json !== result.success.json) {
          const item: WatchConnectorStreamItem = {
            type: "snapshot",
            snapshot: {
              instanceId: rt.instanceId,
              fetchedAt: nowIso,
              data: result.success.data,
            },
          };
          yield* Ref.set(rt.lastSnapshot, {
            json: result.success.json,
            fetchedAt: nowIso,
            item,
          });
          // A published snapshot supersedes any error the stream showed —
          // the next failure must push its item even if byte-identical.
          yield* Ref.set(rt.lastError, undefined);
          yield* publishItem(rt, item);
          yield* evalThresholds(rt, result.success.data, nowIso);
        }
        return;
      }
      const failure = result.failure;
      const failures = yield* Ref.updateAndGet(rt.consecutiveFailures, (n) => n + 1);
      yield* Ref.update(rt.schedule, (s) => ({
        ...s,
        nextRunAt: now + backoffDelayMs(interval, failures),
      }));
      const previousStatus = yield* Ref.get(rt.healthStatus);
      yield* Ref.set(rt.healthStatus, failure.health);
      yield* connectors
        .recordHealth(rt.instanceId, {
          status: failure.health,
          lastError: failure.message,
          lastFetchAt: nowIso,
          consecutiveFailures: failures,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not record connector health", { cause }),
          ),
        );
      // Health transitions emit once, on the edge — but a flapping source
      // still produces an edge every other run, so a status that already
      // notified inside the cooldown window is recorded in health_json
      // without another user notification.
      if (previousStatus !== failure.health) {
        const notifiedAt = yield* Ref.get(rt.healthNotifiedAt);
        const lastNotified = notifiedAt.get(failure.health);
        if (lastNotified === undefined || now - lastNotified >= HEALTH_NOTIFICATION_COOLDOWN_MS) {
          notifiedAt.set(failure.health, now);
          const type =
            failure.health === "authExpired" ? "connector.authExpired" : "connector.unhealthy";
          yield* emitNotification({
            type,
            notificationId: WatchNotificationId.make(
              `watch-notification:${type}:${rt.instanceId}:${nowIso}`,
            ),
            createdAt: nowIso,
            instanceId: rt.instanceId,
          });
        }
      }
      const last = yield* Ref.get(rt.lastSnapshot);
      const error = errorState(failure, rt.instanceId, last?.fetchedAt);
      // `lastGoodDataAt` is pinned to the last success, so repeated runs of
      // the same failure produce an identical item — publish only on change.
      const lastError = yield* Ref.get(rt.lastError);
      if (lastError === undefined || !valuesEqual(error, lastError)) {
        yield* Ref.set(rt.lastError, error);
        yield* publishItem(rt, { type: "error", error });
      }
    });

    /**
     * Wakes the poll loop early: subscribe/leave, a file-watch signal, or a
     * runtime restart. A forced wake asks for "a run newer than the last
     * completed generation" — if the in-flight run finishes first, the
     * request is already satisfied and no duplicate fetch happens.
     */
    const wake = Effect.fn("wake")(function* (rt: InstanceRuntime, force: boolean) {
      if (force) {
        const generation = yield* Ref.get(rt.runGeneration);
        yield* Ref.update(rt.forceRequest, (request) => Math.max(request, generation + 1));
      }
      yield* Queue.offer(rt.wakes, "wake").pipe(Effect.asVoid);
    });

    /**
     * The wait between runs doubles as the wake inbox. A wake either runs
     * immediately (`forceRequest` beyond the completed generation) or just
     * re-evaluates the deadline after subscriber churn; a timeout means the
     */
    const runLoop = Effect.fn("runLoop")(function* (rt: InstanceRuntime) {
      while (true) {
        const schedule = yield* Ref.get(rt.schedule);
        // The deadline sleep computes its duration *inside* the racing
        // fiber so it always lands on `nextRunAt` absolutely — a fiber
        // scheduled late (event-loop stall, or a test clock that jumped
        // between the schedule read and the sleep registration) still
        const woke = yield* Effect.raceFirst(
          Effect.asSome(Queue.take(rt.wakes)),
          Clock.currentTimeMillis.pipe(
            Effect.andThen((now) => Effect.sleep(Math.max(0, schedule.nextRunAt - now))),
            Effect.as(Option.none<"wake">()),
          ),
        );
        const wanted = yield* Ref.getAndSet(rt.forceRequest, 0);
        const completed = yield* Ref.get(rt.runGeneration);
        if (Option.isSome(woke) && wanted <= completed) {
          // Non-forced wake (or a force an in-flight run already satisfied):
          // just re-evaluate the deadline for the current subscriber set.
          // While backing off, `nextRunAt` is the backoff deadline and
          // `lastRunAt` still holds the last *success* — recomputing
          if ((yield* Ref.get(rt.consecutiveFailures)) === 0) {
            const interval = yield* effectiveIntervalMs(rt);
            yield* Ref.update(rt.schedule, (s) => ({
              ...s,
              // Never push a nearer deadline out — a forced run deferred to
              // the run-gap floor below keeps its slot over this reschedule.
              nextRunAt: Math.min(s.nextRunAt, s.lastRunAt + interval),
            }));
          }
          continue;
        }
        // A forced wake still honors an active backoff: while failures are
        // pending the run is deferred to the backoff deadline, so a busy
        // watched directory cannot retry a failing pack every signal. The
        // request itself may be dropped — the scheduled run satisfies it.
        if (
          (yield* Ref.get(rt.consecutiveFailures)) > 0 &&
          schedule.nextRunAt > (yield* Clock.currentTimeMillis)
        ) {
          continue;
        }
        // A forced run inside the minimum run gap coalesces into a run at
        // the gap deadline instead of starting immediately — otherwise a
        // directory written at ~300ms cadence drives a full fetch +
        // pack-eval per debounced signal. `completed > 0` means a run
        if (wanted > completed && completed > 0) {
          const gapRemaining =
            schedule.lastRunAt + MIN_FORCED_RUN_GAP_MS - (yield* Clock.currentTimeMillis);
          if (gapRemaining > 0) {
            yield* Ref.update(rt.schedule, (s) => ({
              ...s,
              nextRunAt: Math.min(s.nextRunAt, schedule.lastRunAt + MIN_FORCED_RUN_GAP_MS),
            }));
            continue;
          }
        }
        // A defect in one run must not kill the poll loop — typed failures
        // are handled in runOnce; this only guards bugs, and the next
        // scheduled run retries. Interruption still propagates.
        yield* Ref.set(rt.runActive, true);
        yield* runOnce(rt).pipe(
          // A finished run satisfies any force requested while it was in
          // flight — bumped on every outcome, including defects.
          Effect.ensuring(
            Effect.all([Ref.update(rt.runGeneration, (n) => n + 1), Ref.set(rt.runActive, false)], {
              discard: true,
            }),
          ),
          Effect.catchDefect((defect) =>
            Effect.logError("Connector poll run defect", {
              instanceId: rt.instanceId,
              defect,
            }),
          ),
        );
      }
    });

    /** For `file` packs: debounced fs.watch signals enqueue runs. */
    const startFileWatcher = Effect.fn("startFileWatcher")(
      function* (rt: InstanceRuntime) {
        const info = yield* connectors.loadRuntime(rt.instanceId);
        if (info.manifest.transport !== "file") return;
        const spec = yield* FileTransport.parseFileWatchConfig(info.instance.config);
        const signals = yield* FileTransport.watchSignals(spec);
        yield* Stream.runForEach(signals, () => wake(rt, true)).pipe(Effect.forkIn(rt.scope));
      },
      Effect.provide(ambient),
      (effect, rt) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Connector file watch could not start; interval polling continues", {
              instanceId: rt.instanceId,
              cause,
            }),
          ),
        ),
    );

    /** Callers hold `lifecycle`. Runtime starts idle — subscribers enqueue the first run. */
    const buildRuntime = Effect.fn("buildRuntime")(function* (
      info: ConnectorService.ConnectorRuntimeInfo,
      egressFetch: HttpTransport.ConnectorEgressFetchImpl,
    ) {
      const rt: InstanceRuntime = {
        instanceId: info.instance.id,
        updatedAt: info.instance.updatedAt,
        floorMs: yield* Ref.make(floorOf(info.instance.config)),
        subscribers: yield* Ref.make(new Map<string, Subscriber>()),
        wakes: yield* Queue.sliding<"wake">(1),
        forceRequest: yield* Ref.make(0),
        runGeneration: yield* Ref.make(0),
        runActive: yield* Ref.make(false),
        items: yield* PubSub.sliding<WatchConnectorStreamItem>(1),
        consecutiveFailures: yield* Ref.make(0),
        healthStatus: yield* Ref.make<WatchConnectorHealth["status"]>(info.instance.health.status),
        // First push is never rate-limited — the gap is negative until a
        // real timestamp lands.
        lastPublishAt: yield* Ref.make(0 - MIN_PUSH_INTERVAL_MS),
        lastSnapshot: yield* Ref.make<CachedSnapshot | undefined>(undefined),
        thresholdLatches: yield* Ref.make(new Map<string, boolean>()),
        lastError: yield* Ref.make<WatchWidgetErrorState | undefined>(undefined),
        healthNotifiedAt: yield* Ref.make(new Map<string, number>()),
        schedule: yield* Ref.make({ lastRunAt: 0, nextRunAt: Number.MAX_SAFE_INTEGER }),
        egressFetch,
        scope: yield* Scope.make(),
      };
      yield* Effect.forkIn(Effect.provide(runLoop(rt), ambient), rt.scope).pipe(Effect.ignore);
      yield* startFileWatcher(rt);
      return rt;
    });

    /** Callers hold `lifecycle`. Tears a runtime down; `missing` pushes the typed placeholder first. */
    const teardownRuntime = Effect.fn("teardownRuntime")(function* (
      rt: InstanceRuntime,
      options?: { readonly missing?: boolean },
    ) {
      yield* Ref.update(runtimes, (map) => {
        if (map.get(rt.instanceId) !== rt) return map;
        const next = new Map(map);
        next.delete(rt.instanceId);
        return next;
      });
      yield* Scope.close(rt.scope, Exit.void).pipe(Effect.ignore);
      if (options?.missing === true) {
        yield* PubSub.publish(rt.items, {
          type: "error",
          error: { cause: "connectorMissing", instanceId: rt.instanceId },
        }).pipe(Effect.ignore);
      }
      yield* PubSub.shutdown(rt.items).pipe(Effect.ignore);
    });

    /**
     * Config/pack writes bump `updated_at`; the reconcile worker rebuilds the
     * runtime so a poll never runs stale pack code, config, or watch roots.
     * Subscriber state (and the cached snapshot) carries over.
     */
    const restartRuntime = Effect.fn("restartRuntime")(function* (
      rt: InstanceRuntime,
      updatedAt: string,
    ) {
      if ((yield* Ref.get(runtimes)).get(rt.instanceId) !== rt) return;
      yield* Scope.close(rt.scope, Exit.void).pipe(Effect.ignore);
      rt.scope = yield* Scope.make();
      rt.updatedAt = updatedAt;
      yield* Ref.set(rt.consecutiveFailures, 0);
      yield* Ref.set(rt.schedule, { lastRunAt: 0, nextRunAt: Number.MAX_SAFE_INTEGER });
      yield* Effect.forkIn(Effect.provide(runLoop(rt), ambient), rt.scope).pipe(Effect.ignore);
      yield* startFileWatcher(rt);
      yield* wake(rt, true);
    });

    /** Get-or-create under `lifecycle`; the subscriber registers inside the same critical section. */
    const joinRuntime = (
      info: ConnectorService.ConnectorRuntimeInfo,
      subscriberId: string,
      subscriber: Subscriber,
      egressFetch: HttpTransport.ConnectorEgressFetchImpl,
    ) =>
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const existing = (yield* Ref.get(runtimes)).get(info.instance.id);
          const rt = existing ?? (yield* buildRuntime(info, egressFetch));
          if (existing === undefined) {
            yield* Ref.update(runtimes, (map) => new Map(map).set(info.instance.id, rt));
          }
          yield* Ref.update(rt.subscribers, (map) => new Map(map).set(subscriberId, subscriber));
          return rt;
        }),
      );

    /**
     * Removal, the emptiness check, and the teardown itself all hold one
     * `lifecycle` permit — a `joinRuntime` can never squeeze between "last
     * subscriber gone" and "runtime destroyed" and inherit a doomed runtime.
     */
    const leaveRuntime = Effect.fn("leaveRuntime")(function* (
      rt: InstanceRuntime,
      subscriberId: string,
    ) {
      const tornDown = yield* lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const remaining = yield* Ref.modify(rt.subscribers, (map) => {
            const next = new Map(map);
            next.delete(subscriberId);
            return [next.size, next] as const;
          });
          if (remaining > 0) return false;
          yield* teardownRuntime(rt);
          return true;
        }),
      );
      if (!tornDown) yield* wake(rt, false);
    });

    /**
     * Keeps runtimes in step with the instance table: an archived or deleted
     * instance loses its runtime (subscribers get `connectorMissing`), a
     * config write (`updated_at`) restarts it. `subscribeList` re-emits the
     */
    const reconcile = lifecycle.withPermits(1)(
      Effect.gen(function* () {
        const list = yield* connectors.list({ includeArchived: true });
        const live = new Map<string, string>();
        for (const instance of list.instances) {
          if (instance.archivedAt === null) live.set(instance.id, instance.updatedAt);
        }
        for (const [instanceId, rt] of yield* Ref.get(runtimes)) {
          const updatedAt = live.get(instanceId);
          if (updatedAt === undefined) {
            yield* teardownRuntime(rt, { missing: true });
          } else if (updatedAt !== rt.updatedAt) {
            yield* restartRuntime(rt, updatedAt);
          }
        }
      }),
    );

    yield* Stream.runForEach(
      connectors.subscribeList({ includeArchived: true }),
      () => reconcile,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Connector poller reconcile worker stopped", { cause }),
      ),
      Effect.forkScoped,
    );

    const subscribe: ConnectorPoller["Service"]["subscribe"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const infoResult = yield* connectors.loadRuntime(input.instanceId).pipe(Effect.result);
          if (Result.isFailure(infoResult)) {
            // A missing or archived instance — or a pack version that is no
            // longer installed — is a widget state, not a stream failure:
            // emit the typed placeholder and stay quiet.
            if (
              infoResult.failure.reason === "instanceNotFound" ||
              infoResult.failure.reason === "packNotFound"
            ) {
              return Stream.succeed<WatchConnectorStreamItem>({
                type: "error",
                error: { cause: "connectorMissing", instanceId: input.instanceId },
              });
            }
            return Stream.fail(infoResult.failure);
          }
          const subscriberId = yield* crypto.randomUUIDv4().pipe(
            Effect.mapError(
              (cause) =>
                new WatchConnectorError({
                  message: "Could not allocate a connector subscription id.",
                  reason: "fetchFailed",
                  cause,
                }),
            ),
          );
          // Resolved in the caller's context so tests can inject a stub; the
          // first subscriber pins the runtime's egress impl.
          const egressFetch = yield* HttpTransport.ConnectorEgressFetch;
          // A claimed widgetId is verified against the stored widget row and
          // the rules come from that row's config — a widget that does not
          // exist or binds another instance cannot subscribe.
          const thresholds =
            input.widgetId === undefined
              ? []
              : yield* resolveWidgetThresholds(input.widgetId, input.instanceId);
          const rt = yield* joinRuntime(
            infoResult.success,
            subscriberId,
            {
              intervalMs: input.refreshPolicy?.intervalMs,
              widgetId: input.widgetId,
              thresholds,
            },
            egressFetch,
          );
          // Subscribe before deciding anything so the next publish can never
          // pass us by. A run is forced only when nothing is cached and none
          // is in flight — otherwise this subscription rides the shared run
          // or the cached snapshot: N widgets, one upstream fetch.
          const subscription = yield* PubSub.subscribe(rt.items);
          const cached = yield* Ref.get(rt.lastSnapshot);
          const runInFlight = yield* Ref.get(rt.runActive);
          yield* wake(rt, cached === undefined && !runInFlight);
          const live = Stream.fromSubscription(subscription);
          return Stream.concat(
            cached === undefined ? Stream.empty : Stream.succeed(cached.item),
            // A snapshot published between PubSub.subscribe and the cache
            // read sits in both the replay and the subscription queue —
            // drop that one queued duplicate (identical object identity).
            cached === undefined ? live : Stream.dropWhile(live, (item) => item === cached.item),
          ).pipe(Stream.ensuring(leaveRuntime(rt, subscriberId)));
        }),
      );

    return ConnectorPoller.of({ subscribe });
  }),
);
