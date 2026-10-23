import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Notification history with a bounded retention: the service prunes rows
  // past a max age and a max row count. `notification_id` is the unique key
  // the server emits under, so a replayed domain event can never
  // double-record; it also keys per-sequence dead-letter marker rows
  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_notifications (
      notification_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      notification_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      source_sequence INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_watch_notifications_recorded
    ON watch_notifications(recorded_at DESC, notification_id DESC)
  `;

  // Single-row prefs (singleton = 1): delivery prefs only; muting never stops
  // a history write.
  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_notification_prefs (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      prefs_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // One resume cursor per consumed orchestration event type so the worker
  // restarts where it left off instead of re-emitting.
  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_notification_cursors (
      event_type TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
