import {
  isUnknownUnionMember,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type ThreadId,
  WatchNotificationError,
  WatchNotificationEvent,
  WatchNotificationId,
  WatchNotificationPrefs,
  type WatchNotificationHistoryEntry,
  type WatchNotificationStreamItem,
  type WatchNotificationsHistoryInput,
  type WatchNotificationsHistoryResult,
  type WatchNotificationsSetPrefsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

/**
 * User-facing notification feed. A scoped worker taps the post-commit
 * orchestration event stream (one unbounded subscription per consumed event
 * type, merged), maps domain events into `WatchNotification`s, records every
 * one of them into the append-only `watch_notifications` history table, and
 * publishes it to subscribers exactly once — dedupe is by deterministic
 * `notificationId` (`INSERT ... ON CONFLICT DO NOTHING`), so a replayed event
 * can never double-emit. Per-type `last_sequence` cursors resume the tap
 * after a restart.
 *
 * Delivery is deliberately not decided here: mute/snooze are client-side,
 * per-channel predicates (`@t3tools/client-runtime/state/watchNotifications`)
 * keyed by `(notificationId, channel)`. This service always emits and always
 * writes history.
 */
export class UserNotificationService extends Context.Service<
  UserNotificationService,
  {
    /** Emits the caller's prefs first, then live notifications and pref updates. */
    readonly subscribe: () => Stream.Stream<WatchNotificationStreamItem, WatchNotificationError>;
    /** Newest-first notification history; records muted and snoozed events alike. */
    readonly history: (
      input: WatchNotificationsHistoryInput,
    ) => Effect.Effect<WatchNotificationsHistoryResult, WatchNotificationError>;
    readonly getPrefs: () => Effect.Effect<WatchNotificationPrefs, WatchNotificationError>;
    /** Full prefs replace: every way in has a way out (unmute, unsnooze). */
    readonly setPrefs: (
      prefs: WatchNotificationPrefs,
    ) => Effect.Effect<WatchNotificationsSetPrefsResult, WatchNotificationError>;
    /**
     * Emission hook for server-side producers (connector health checks,
     * widget threshold alerts). Callers pick the `notificationId`; a
     * deterministic id makes the emit idempotent, a unique one is
     * point-in-time. Returns whether it was newly recorded.
     */
    readonly emit: (
      notification: WatchNotificationEvent,
    ) => Effect.Effect<{ readonly recorded: boolean }, WatchNotificationError>;
    /**
     * Resolves once the worker's resume cursors are initialized and its tap is
     * live: anything committed afterwards is guaranteed to reach it. Tests use
     * it to order writes against startup without sleeping.
     */
    readonly awaitStarted: () => Effect.Effect<void>;
    /**
     * Resolves once the worker has finished handling this event type at a
     * sequence at least this high — whether it recorded, skipped, or dropped
     * the event after its retry. The merged tap does not order event types
     * against each other, so waiting on a global high-water mark cannot prove
     * an earlier event of another type ran. Tests use it to observe the tap
     * without sleeping.
     */
    readonly awaitProcessed: (
      sequence: number,
      eventType: OrchestrationV2DomainEvent["type"],
    ) => Effect.Effect<void>;
  }
>()("t3/notifications/UserNotificationService") {}

const DEFAULT_PREFS: WatchNotificationPrefs = {
  mutedEventTypes: [],
  mutedPageIds: [],
  snoozedUntil: null,
};

const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 500;
/** Delay before the one mapping retry: rides out a transient projection read. */
const MAPPING_RETRY_DELAY = Duration.millis(250);

/** Domain event types the worker taps, one unbounded subscription each, merged. */
const CONSUMED_EVENT_TYPES = [
  "run.updated",
  "runtime-request.updated",
] as const satisfies ReadonlyArray<OrchestrationV2DomainEvent["type"]>;

const NotificationJson = Schema.fromJsonString(WatchNotificationEvent);
const PrefsJson = Schema.fromJsonString(WatchNotificationPrefs);
const encodeNotificationJson = Schema.encodeSync(NotificationJson);
const decodeNotificationJson = Schema.decodeUnknownEffect(NotificationJson);
const encodePrefsJson = Schema.encodeSync(PrefsJson);
const decodePrefsJson = Schema.decodeUnknownEffect(PrefsJson);

const notificationError = (message: string, cause?: unknown) =>
  new WatchNotificationError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);
const iso = (value: DateTime.DateTime) => DateTime.formatIso(DateTime.toUtc(value));

interface WatchNotificationRow {
  readonly notification_json: string;
  readonly recorded_at: string;
}

interface WatchNotificationCursorRow {
  readonly event_type: string;
  readonly last_sequence: number;
}

/**
 * The `notificationId` a domain-event transition emits under. Deriving it from
 * the source identity — not a fresh random id — is what makes re-emission of
 * the same transition (duplicate `run.updated`, restart replay) a no-op.
 */
const deterministicNotificationId = (key: string) =>
  WatchNotificationId.make(`watch-notification:${key}`);

export const layer = Layer.effect(
  UserNotificationService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventSink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    // Unbounded like the other in-process event feeds (EventSink liveEvents):
    // publish never suspends, and a stalled subscriber must not stop delivery
    // to everyone else.
    const itemsPubSub = yield* PubSub.unbounded<WatchNotificationStreamItem>();
    const processedPubSub = yield* PubSub.unbounded<{
      readonly eventType: OrchestrationV2DomainEvent["type"];
      readonly sequence: number;
    }>();
    const lastProcessed = yield* Ref.make(new Map<OrchestrationV2DomainEvent["type"], number>());
    /**
     * Earliest sequence per event type dropped after its retry. The tap keeps
     * moving — stalling it behind one bad event would lose every later event —
     * but the durable cursor stays below this sequence, so the next service
     * lifetime replays the gap. Dedupe makes re-emitting the survivors a no-op.
     */
    const blockedSince = yield* Ref.make(new Map<OrchestrationV2DomainEvent["type"], number>());
    const started = yield* Deferred.make<void>();

    /**
     * Records one notification; publishes it only when the insert won its
     * dedupe key. Returns whether it was newly recorded.
     */
    const recordNotification = Effect.fn("UserNotificationService.recordNotification")(function* (
      notification: WatchNotificationEvent,
      sourceSequence: number | null,
    ) {
      if (isUnknownUnionMember(notification)) {
        return yield* notificationError("Cannot emit an unknown notification type.");
      }
      const recordedAt = iso(yield* localNow);
      const rows = yield* sql<{ readonly notification_id: string }>`
          INSERT INTO watch_notifications (notification_id, type, notification_json, recorded_at, source_sequence)
          VALUES (
            ${notification.notificationId},
            ${notification.type},
            ${encodeNotificationJson(notification)},
            ${recordedAt},
            ${sourceSequence}
          )
          ON CONFLICT(notification_id) DO NOTHING
          RETURNING notification_id
        `.pipe(
        Effect.mapError((cause) => notificationError("Could not record notification.", cause)),
      );
      if (rows.length === 0) return false;
      yield* PubSub.publish(itemsPubSub, {
        type: "notification" as const,
        notification,
      });
      return true;
    });

    /** The thread a notification's source event belongs to; null when it is gone. */
    const threadFor = (threadId: ThreadId) =>
      projections.getThread(threadId).pipe(
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
        }),
      );

    /**
     * Maps one stored domain event to the notifications it raises. Only
     * transitions into an interesting state map, and each maps under a
     * deterministic id so repeats are no-ops.
     */
    const notificationsFor = Effect.fn("UserNotificationService.notificationsFor")(function* (
      stored: OrchestrationV2StoredEvent,
    ) {
      const event = stored.event;
      if (event.type === "run.updated") {
        const run = event.payload;
        if (run.status !== "completed" && run.status !== "failed") return [];
        const thread = yield* threadFor(event.threadId);
        if (thread === null) return [];
        const createdAt = iso(yield* localNow);
        return [
          run.status === "completed"
            ? ({
                type: "thread.completed",
                notificationId: deterministicNotificationId(`run.completed:${run.id}`),
                createdAt,
                threadId: event.threadId,
                projectId: thread.projectId,
              } satisfies WatchNotificationEvent)
            : ({
                type: "thread.failed",
                notificationId: deterministicNotificationId(`run.failed:${run.id}`),
                createdAt,
                threadId: event.threadId,
                projectId: thread.projectId,
              } satisfies WatchNotificationEvent),
        ];
      }
      if (event.type === "runtime-request.updated" && event.payload.status === "pending") {
        const thread = yield* threadFor(event.threadId);
        if (thread === null) return [];
        return [
          {
            type: "thread.awaitingInput",
            notificationId: deterministicNotificationId(
              `runtime-request.pending:${event.payload.id}`,
            ),
            createdAt: iso(yield* localNow),
            threadId: event.threadId,
            projectId: thread.projectId,
          } satisfies WatchNotificationEvent,
        ];
      }
      return [];
    });

    const advanceCursor = (eventType: OrchestrationV2DomainEvent["type"], sequence: number) =>
      Effect.gen(function* () {
        const updatedAt = iso(yield* localNow);
        yield* sql`
          INSERT INTO watch_notification_cursors (event_type, last_sequence, updated_at)
          VALUES (${eventType}, ${sequence}, ${updatedAt})
          ON CONFLICT(event_type) DO UPDATE SET
            last_sequence = excluded.last_sequence,
            updated_at = excluded.updated_at
        `;
      });

    /** Notes `stored`'s sequence as the earliest unhandled one for its type. */
    const markBlocked = (stored: OrchestrationV2StoredEvent) =>
      Ref.update(blockedSince, (seen) => {
        const existing = seen.get(stored.event.type);
        if (existing !== undefined && existing <= stored.sequence) return seen;
        const next = new Map(seen);
        next.set(stored.event.type, stored.sequence);
        return next;
      });

    const processStoredEvent = (stored: OrchestrationV2StoredEvent) =>
      Effect.gen(function* () {
        // Mapping is the read that can fail transiently (ProjectionStoreV2 is
        // a live store), so it gets one delayed retry. If it still fails the
        // event is skipped for this session and marked blocked — the durable
        // cursor must stay below it, or the next success would skip it
        // forever.
        const notifications = yield* notificationsFor(stored).pipe(
          Effect.retry({ schedule: Schedule.spaced(MAPPING_RETRY_DELAY), times: 1 }),
        );
        for (const notification of notifications) {
          yield* recordNotification(notification, stored.sequence).pipe(
            Effect.catchCause((cause) =>
              Effect.andThen(
                markBlocked(stored),
                Effect.logWarning("Failed to record watch notification", {
                  sequence: stored.sequence,
                  cause,
                }),
              ),
            ),
          );
        }
        // The cursor only moves up to the last fully handled sequence: it can
        // never cross a blocked event, so a restart replays it.
        const blockedAt = (yield* Ref.get(blockedSince)).get(stored.event.type);
        yield* advanceCursor(
          stored.event.type,
          blockedAt === undefined ? stored.sequence : Math.min(stored.sequence, blockedAt - 1),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.andThen(
            markBlocked(stored),
            Effect.logWarning("Failed to process event for watch notifications", {
              sequence: stored.sequence,
              cause,
            }),
          ),
        ),
        Effect.ensuring(
          Effect.andThen(
            Ref.update(lastProcessed, (seen) => {
              const next = new Map(seen);
              next.set(
                stored.event.type,
                Math.max(next.get(stored.event.type) ?? 0, stored.sequence),
              );
              return next;
            }),
            PubSub.publish(processedPubSub, {
              eventType: stored.event.type,
              sequence: stored.sequence,
            }),
          ),
        ),
      );

    const worker = Effect.gen(function* () {
      // A type with no cursor yet has never been tapped: start it at the
      // current head so a migration onto an existing database does not
      // re-emit history as fresh notifications. Resume only replays what
      // landed after the recorded cursor.
      const head = yield* eventSink.latestSequence();
      const startedAt = iso(yield* localNow);
      for (const eventType of CONSUMED_EVENT_TYPES) {
        yield* sql`
          INSERT INTO watch_notification_cursors (event_type, last_sequence, updated_at)
          VALUES (${eventType}, ${head}, ${startedAt})
          ON CONFLICT(event_type) DO NOTHING
        `;
      }
      const cursorRows = yield* sql<WatchNotificationCursorRow>`
        SELECT event_type, last_sequence FROM watch_notification_cursors
      `;
      const cursors = new Map(cursorRows.map((row) => [row.event_type, row.last_sequence]));
      // Cursors are durable from here on: every commit after this point is
      // replayed on the next boot.
      yield* Deferred.succeed(started, undefined);
      // One unbounded subscription per consumed type (bounded subscribers may
      // drop under load — this worker must not), merged and processed
      // serially so history order matches event order.
      yield* Stream.mergeAll(
        CONSUMED_EVENT_TYPES.map((eventType) =>
          eventSink.stream({
            eventType,
            afterSequence: cursors.get(eventType) ?? head,
          }),
        ),
        { concurrency: CONSUMED_EVENT_TYPES.length },
      ).pipe(Stream.mapEffect(processStoredEvent, { concurrency: 1 }), Stream.runDrain);
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("Watch notification worker stopped", { cause })),
    );

    const loadPrefs = sql<{ readonly prefs_json: string }>`
      SELECT prefs_json FROM watch_notification_prefs WHERE singleton = 1
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(DEFAULT_PREFS) : decodePrefsJson(rows[0].prefs_json),
      ),
      Effect.mapError((cause) => notificationError("Could not load notification prefs.", cause)),
    );

    yield* worker.pipe(Effect.forkScoped);

    return UserNotificationService.of({
      subscribe: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading prefs so a concurrent setPrefs can
            // never fall between the snapshot and the live feed.
            const subscription = yield* PubSub.subscribe(itemsPubSub);
            const prefs = yield* loadPrefs;
            return Stream.concat(
              Stream.succeed({ type: "prefs" as const, prefs }),
              Stream.fromSubscription(subscription),
            );
          }),
        ),
      history: (input) =>
        Effect.gen(function* () {
          const limit = Math.min(input.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
          const rows = yield* sql<WatchNotificationRow>`
            SELECT notification_json, recorded_at
            FROM watch_notifications
            ORDER BY recorded_at DESC, notification_id DESC
            LIMIT ${limit}
          `.pipe(
            Effect.mapError((cause) =>
              notificationError("Could not read notification history.", cause),
            ),
          );
          const entries = yield* Effect.forEach(
            rows,
            (row): Effect.Effect<WatchNotificationHistoryEntry, WatchNotificationError> =>
              decodeNotificationJson(row.notification_json).pipe(
                Effect.map((notification) => ({
                  notification,
                  recordedAt: row.recorded_at,
                })),
                Effect.mapError((cause) =>
                  notificationError("Could not decode notification history.", cause),
                ),
              ),
            { concurrency: 1 },
          );
          return { entries };
        }),
      getPrefs: () => loadPrefs,
      setPrefs: (prefs) =>
        Effect.gen(function* () {
          const updatedAt = iso(yield* localNow);
          yield* sql`
            INSERT INTO watch_notification_prefs (singleton, prefs_json, updated_at)
            VALUES (1, ${encodePrefsJson(prefs)}, ${updatedAt})
            ON CONFLICT(singleton) DO UPDATE SET
              prefs_json = excluded.prefs_json,
              updated_at = excluded.updated_at
          `;
          yield* PubSub.publish(itemsPubSub, { type: "prefs" as const, prefs });
          return { prefs };
        }).pipe(
          Effect.mapError((cause) =>
            notificationError("Could not save notification prefs.", cause),
          ),
        ),
      emit: (notification) =>
        recordNotification(notification, null).pipe(Effect.map((recorded) => ({ recorded }))),
      awaitStarted: () => Deferred.await(started),
      awaitProcessed: (sequence, eventType) =>
        Effect.scoped(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(processedPubSub);
            if (((yield* Ref.get(lastProcessed)).get(eventType) ?? 0) >= sequence) return;
            yield* Stream.fromSubscription(subscription).pipe(
              Stream.filter((seen) => seen.eventType === eventType && seen.sequence >= sequence),
              Stream.take(1),
              Stream.runDrain,
            );
          }),
        ),
    });
  }),
);
