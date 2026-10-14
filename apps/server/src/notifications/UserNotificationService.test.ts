import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type WatchNotificationEvent,
  WatchNotificationId,
  WatchPageId,
  WatchWidgetId,
  isUnknownUnionMember,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UserNotificationService from "./UserNotificationService.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerInfra = Layer.mergeAll(layerStoresProvided, layerEventSinkProvided);
const layerTest = Layer.provideMerge(UserNotificationService.layer, layerInfra);

/**
 * A projection store identical to `real` except `getThread` fails while
 * `shouldFail` says so — exercises the worker's retry and cursor-block paths.
 */
const flakyGetThread = (
  real: ProjectionStore.ProjectionStoreV2Shape,
  shouldFail: (threadId: ThreadId) => boolean,
): ProjectionStore.ProjectionStoreV2Shape => ({
  ...real,
  getThread: (threadId: ThreadId) =>
    shouldFail(threadId)
      ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }))
      : real.getThread(threadId),
});

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

const makeThread = (
  threadId: ThreadId,
  projectId: ProjectId,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: `Thread ${threadId}`,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const threadCreatedEvent = (
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
  id: string,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "thread.created",
  threadId: thread.id,
  providerInstanceId,
  occurredAt: now,
  payload: thread,
});

const makeRun = (
  runId: string,
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  now: DateTime.Utc,
  ordinal: number,
): OrchestrationV2Run => ({
  id: RunId.make(runId),
  threadId,
  ordinal,
  providerInstanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${runId}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

const runUpdatedEvent = (
  run: OrchestrationV2Run,
  now: DateTime.Utc,
  id: string,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "run.updated",
  threadId: run.threadId,
  providerInstanceId,
  occurredAt: now,
  payload: run,
});

const runtimeRequestEvent = (
  requestId: string,
  nodeId: string,
  threadId: ThreadId,
  now: DateTime.Utc,
  id: string,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "runtime-request.updated",
  threadId,
  providerInstanceId,
  occurredAt: now,
  payload: {
    id: RuntimeRequestId.make(requestId),
    nodeId: NodeId.make(nodeId),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: null,
  } satisfies OrchestrationV2RuntimeRequest,
});

const writeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) => sink.write({ events }));

type KnownNotification = Exclude<WatchNotificationEvent, { readonly tag: string }>;
const notificationType = (notification: WatchNotificationEvent): string =>
  isUnknownUnionMember(notification) ? notification.value : notification.type;
const knownNotification = (
  notification: WatchNotificationEvent,
): notification is KnownNotification => !isUnknownUnionMember(notification);

const setupThread = (threadId: string, projectId: string, now: DateTime.Utc) =>
  writeEvents([
    threadCreatedEvent(
      makeThread(ThreadId.make(threadId), ProjectId.make(projectId), now),
      now,
      `event:${threadId}:created`,
    ),
  ]);

it.effect("emits each notification once under duplicate domain events", () =>
  Effect.gen(function* () {
    const notifications = yield* UserNotificationService.UserNotificationService;
    yield* notifications.awaitStarted();
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:notifications");
    const projectId = ProjectId.make("project:notifications");
    yield* setupThread(threadId, projectId, now);

    // running: not a notifiable transition.
    yield* writeEvents([
      runUpdatedEvent(makeRun("run:one", threadId, "running", now, 1), now, "event:run.running"),
    ]);
    // completed: one notification; a second completed write for the same run dedupes.
    yield* writeEvents([
      runUpdatedEvent(
        makeRun("run:one", threadId, "completed", now, 1),
        now,
        "event:run.completed",
      ),
    ]);
    const duplicateStored = yield* writeEvents([
      runUpdatedEvent(
        makeRun("run:one", threadId, "completed", now, 1),
        now,
        "event:run.completed.dupe",
      ),
    ]);
    const requestStored = yield* writeEvents([
      runtimeRequestEvent("request:one", "node:one", threadId, now, "event:request.pending"),
    ]);
    const failedStored = yield* writeEvents([
      runUpdatedEvent(makeRun("run:two", threadId, "failed", now, 2), now, "event:run.failed"),
    ]);
    // The tap merges one stream per event type; each type checkpoints
    // independently, so observe both.
    yield* notifications.awaitProcessed(failedStored[0]!.sequence, "run.updated");
    yield* notifications.awaitProcessed(requestStored[0]!.sequence, "runtime-request.updated");
    assert.isTrue(duplicateStored[0]!.sequence < failedStored[0]!.sequence);

    const { entries } = yield* notifications.history({});
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => notificationType(entry.notification)).sort(), [
      "thread.awaitingInput",
      "thread.completed",
      "thread.failed",
    ]);
    const completed = entries
      .map((entry) => entry.notification)
      .find(
        (notification): notification is Extract<KnownNotification, { type: "thread.completed" }> =>
          knownNotification(notification) && notification.type === "thread.completed",
      );
    assert.equal(completed?.notificationId, "watch-notification:run.completed:run:one");
    assert.equal(completed?.threadId, threadId);
    assert.equal(completed?.projectId, projectId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("resumes from its last-sequence checkpoint without re-emitting", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:resume");
    yield* setupThread(threadId, "project:resume", now);

    // Phase 1: one service lifetime — a completed run emits once and checkpoints.
    const completedSequence = yield* Effect.scoped(
      Effect.gen(function* () {
        const notifications = yield* UserNotificationService.UserNotificationService;
        yield* notifications.awaitStarted();
        const completedStored = yield* writeEvents([
          runUpdatedEvent(
            makeRun("run:one", threadId, "completed", now, 1),
            now,
            "event:run.completed",
          ),
        ]);
        const sequence = completedStored[0]!.sequence;
        yield* notifications.awaitProcessed(sequence, "run.updated");
        assert.equal((yield* notifications.history({})).entries.length, 1);
        return sequence;
      }).pipe(Effect.provide(UserNotificationService.layer)),
    );
    const cursors = yield* sql<{
      readonly event_type: string;
      readonly last_sequence: number;
    }>`SELECT event_type, last_sequence FROM watch_notification_cursors`;
    const runCursor = cursors.find((row) => row.event_type === "run.updated");
    assert.isAtLeast(runCursor?.last_sequence ?? -1, completedSequence);

    // Phase 2: a fresh service instance over the same database is a restart.
    // Its persisted cursor resumes the tap, so only the new event emits.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const notifications = yield* UserNotificationService.UserNotificationService;
        yield* notifications.awaitStarted();
        const firstSeen = yield* Deferred.make<void>();
        const itemsFiber = yield* notifications.subscribe().pipe(
          Stream.tap(() => Deferred.succeed(firstSeen, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(firstSeen);
        const failedStored = yield* writeEvents([
          runUpdatedEvent(makeRun("run:two", threadId, "failed", now, 2), now, "event:run.failed"),
        ]);
        yield* notifications.awaitProcessed(failedStored[0]!.sequence, "run.updated");

        const items = Array.from(yield* Fiber.join(itemsFiber));
        assert.equal(items.length, 2);
        const item = items.find(
          (candidate): candidate is Extract<typeof candidate, { type: "notification" }> =>
            candidate.type === "notification",
        );
        assert.equal(items[0]?.type, "prefs");
        if (item !== undefined && knownNotification(item.notification)) {
          assert.equal(item.notification.notificationId, "watch-notification:run.failed:run:two");
        } else {
          assert.fail("restart emitted no thread.failed notification");
        }
        assert.equal((yield* notifications.history({})).entries.length, 2);
      }).pipe(Effect.provide(UserNotificationService.layer)),
    );
  }).pipe(Effect.provide(layerInfra)),
);

it.effect("does not emit for events that predate the worker's first boot", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:preboot");
    yield* setupThread(threadId, "project:preboot", now);
    yield* writeEvents([
      runUpdatedEvent(
        makeRun("run:one", threadId, "completed", now, 1),
        now,
        "event:run.completed",
      ),
    ]);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const notifications = yield* UserNotificationService.UserNotificationService;
        yield* notifications.awaitStarted();
        const failedStored = yield* writeEvents([
          runUpdatedEvent(makeRun("run:two", threadId, "failed", now, 2), now, "event:run.failed"),
        ]);
        yield* notifications.awaitProcessed(failedStored[0]!.sequence, "run.updated");
        const { entries } = yield* notifications.history({});
        assert.deepEqual(
          entries.map((entry) => notificationType(entry.notification)),
          ["thread.failed"],
        );
      }).pipe(Effect.provide(UserNotificationService.layer)),
    );
  }).pipe(Effect.provide(layerInfra)),
);

it.effect("stores prefs reversibly and records muted deliveries", () =>
  Effect.gen(function* () {
    const notifications = yield* UserNotificationService.UserNotificationService;
    const pageId = WatchPageId.make("watch-page:prefs");

    const defaults = yield* notifications.getPrefs();
    assert.deepEqual(defaults, { mutedEventTypes: [], mutedPageIds: [], snoozedUntil: null });

    // Every way in has a way out: mute then unmute, snooze then unsnooze.
    yield* notifications.setPrefs({
      mutedEventTypes: ["thread.completed"],
      mutedPageIds: [pageId],
      snoozedUntil: "2030-01-01T00:00:00.000Z",
    });
    assert.deepEqual(yield* notifications.getPrefs(), {
      mutedEventTypes: ["thread.completed"],
      mutedPageIds: [pageId],
      snoozedUntil: "2030-01-01T00:00:00.000Z",
    });
    const reverted = yield* notifications.setPrefs({
      mutedEventTypes: [],
      mutedPageIds: [],
      snoozedUntil: null,
    });
    assert.deepEqual(reverted.prefs, defaults);

    // A muted type is still emitted and recorded: mute is a delivery decision.
    yield* notifications.setPrefs({
      mutedEventTypes: ["widget.threshold"],
      mutedPageIds: [],
      snoozedUntil: null,
    });
    const threshold = {
      type: "widget.threshold" as const,
      notificationId: WatchNotificationId.make("watch-notification:widget.threshold:test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      widgetId: WatchWidgetId.make("watch-widget:prefs"),
      pageId,
    };
    const first = yield* notifications.emit(threshold);
    const second = yield* notifications.emit(threshold);
    assert.isTrue(first.recorded);
    assert.isFalse(second.recorded);
    const { entries } = yield* notifications.history({});
    assert.equal(entries.length, 1);
    assert.deepEqual(
      entries.map((entry) => notificationType(entry.notification)),
      ["widget.threshold"],
    );

    // Subscribers see the stored prefs first, then live pref updates.
    const firstSeen = yield* Deferred.make<void>();
    const itemsFiber = yield* notifications.subscribe().pipe(
      Stream.tap(() => Deferred.succeed(firstSeen, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(firstSeen);
    yield* notifications.setPrefs(defaults);
    const items = Array.from(yield* Fiber.join(itemsFiber));
    assert.equal(items.length, 2);
    if (items[0]?.type === "prefs") {
      assert.deepEqual(items[0].prefs.mutedEventTypes, ["widget.threshold"]);
    } else {
      assert.fail("first notification stream item was not prefs");
    }
    if (items[1]?.type === "prefs") {
      assert.deepEqual(items[1].prefs, defaults);
    } else {
      assert.fail("second notification stream item was not the prefs update");
    }
  }).pipe(Effect.provide(layerTest)),
);

// Live clock: the worker's mapping retry waits on a real delay.
it.live("retries a failed projection read once before dropping the event", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:retry");
    const attempts = new Map<string, number>();
    const failFirstRead = (candidate: ThreadId) => {
      if (candidate !== threadId) return false;
      const seen = (attempts.get(candidate) ?? 0) + 1;
      attempts.set(candidate, seen);
      return seen === 1;
    };
    yield* setupThread(threadId, "project:retry", now);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const real = yield* ProjectionStore.ProjectionStoreV2;
        yield* Effect.gen(function* () {
          const notifications = yield* UserNotificationService.UserNotificationService;
          yield* notifications.awaitStarted();
          const stored = yield* writeEvents([
            runUpdatedEvent(
              makeRun("run:retry", threadId, "completed", now, 1),
              now,
              "event:run.retry",
            ),
          ]);
          yield* notifications.awaitProcessed(stored[0]!.sequence, "run.updated");
          // First attempt fails, the one retry maps and records.
          assert.equal(attempts.get(threadId), 2);
          const { entries } = yield* notifications.history({});
          assert.deepEqual(
            entries.map((entry) => notificationType(entry.notification)),
            ["thread.completed"],
          );
        }).pipe(
          Effect.provide(UserNotificationService.layer),
          Effect.provideService(
            ProjectionStore.ProjectionStoreV2,
            flakyGetThread(real, failFirstRead),
          ),
        );
      }),
    );
  }).pipe(Effect.provide(layerInfra)),
);

it.live("keeps the cursor below an unmappable event so a restart replays it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const blockedThreadId = ThreadId.make("thread:blocked");
    const okThreadId = ThreadId.make("thread:ok");
    const failingReads = new Set<string>([blockedThreadId]);

    yield* setupThread(blockedThreadId, "project:blocked", now);
    yield* setupThread(okThreadId, "project:ok", now);

    const withFlakyReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const real = yield* ProjectionStore.ProjectionStoreV2;
        return yield* effect.pipe(
          Effect.provide(UserNotificationService.layer),
          Effect.provideService(
            ProjectionStore.ProjectionStoreV2,
            flakyGetThread(real, (threadId) => failingReads.has(threadId)),
          ),
        );
      });

    const blockedSequence = yield* Effect.scoped(
      withFlakyReads(
        Effect.gen(function* () {
          const notifications = yield* UserNotificationService.UserNotificationService;
          yield* notifications.awaitStarted();
          const blockedStored = yield* writeEvents([
            runUpdatedEvent(
              makeRun("run:blocked", blockedThreadId, "completed", now, 1),
              now,
              "event:run.blocked",
            ),
          ]);
          const okStored = yield* writeEvents([
            runUpdatedEvent(
              makeRun("run:ok", okThreadId, "completed", now, 1),
              now,
              "event:run.ok",
            ),
          ]);
          // Handling is serial per merged tap, so observing the later event
          // proves the blocked one's retry already ran.
          yield* notifications.awaitProcessed(okStored[0]!.sequence, "run.updated");
          const { entries } = yield* notifications.history({});
          assert.deepEqual(
            entries.map((entry) => notificationType(entry.notification)),
            ["thread.completed"],
          );
          return blockedStored[0]!.sequence;
        }),
      ),
    );

    // The later success must not carry the cursor past the failed event.
    const cursors = yield* sql<{
      readonly event_type: string;
      readonly last_sequence: number;
    }>`SELECT event_type, last_sequence FROM watch_notification_cursors`;
    const runCursor = cursors.find((row) => row.event_type === "run.updated");
    assert.isBelow(runCursor?.last_sequence ?? Number.MAX_SAFE_INTEGER, blockedSequence);

    // The reads recover; a fresh service lifetime replays the gap, and dedupe
    // keeps the already-recorded notification a no-op.
    failingReads.clear();
    yield* Effect.scoped(
      withFlakyReads(
        Effect.gen(function* () {
          const notifications = yield* UserNotificationService.UserNotificationService;
          yield* notifications.awaitStarted();
          yield* notifications.awaitProcessed(blockedSequence, "run.updated");
          const ids = (yield* notifications.history({})).entries
            .map((entry) => entry.notification)
            .filter(knownNotification)
            .map((notification) => notification.notificationId)
            .sort();
          assert.deepEqual(ids, [
            "watch-notification:run.completed:run:blocked",
            "watch-notification:run.completed:run:ok",
          ]);
        }),
      ),
    );
  }).pipe(Effect.provide(layerInfra)),
);

it.effect("surfaces the decode message when a history row is unreadable", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const notifications = yield* UserNotificationService.UserNotificationService;
    yield* notifications.awaitStarted();
    yield* sql`
      INSERT INTO watch_notifications (notification_id, type, notification_json, recorded_at, source_sequence)
      VALUES ('watch-notification:corrupt', 'thread.completed', 'not-json', '2026-01-01T00:00:00.000Z', NULL)
    `;
    const error = yield* notifications.history({}).pipe(Effect.flip);
    assert.equal(error.message, "Could not decode notification history.");
  }).pipe(Effect.provide(layerTest)),
);
