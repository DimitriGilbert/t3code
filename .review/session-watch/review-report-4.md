# Review report — Cluster 4: UserNotificationService

Scope: `apps/server/src/notifications/UserNotificationService.ts` (test file skimmed for
coverage context only). Verified against `EventSink.ts` (stream replay semantics),
`EventStore.ts` / `OrchestrationEventStore.ts` (`afterSequence` exclusivity, commit/publish
ordering), migration `064_WatchNotifications.ts`, contracts `watch.ts`, and the two `emit`
callers (`ConnectorPoller`, `ConnectorService`).

## Verified correct (no findings)

- **Cursor resume / off-by-one**: `afterSequence` is strictly exclusive
  (`sequence > afterSequence`, OrchestrationEventStore.ts:612), so storing the last processed
  sequence and resuming at `afterSequence: cursor` replays exactly the unhandled tail. The
  `blockedAt - 1` clamp correctly re-includes the blocked event itself.
- **Crash window insert→cursor**: a crash after `INSERT` but before `advanceCursor` replays
  the event on next boot; `ON CONFLICT DO NOTHING` dedupe makes re-insert and re-publish a
  no-op (`recordNotification` only publishes when `RETURNING` is non-empty).
- **Stream gap**: `eventSink.stream` subscribes to the PubSub _before_ reading `highWater`
  (EventSink.ts:751-757) and publishes post-commit, so replay `(after, highWater]` + live
  `> highWater` has neither gap nor duplication. Per-type PubSubs are populated on every
  commit (EventSink.ts:219-228). `head` seeding for a fresh type is covered by replay up to
  subscribe-time highWater.
- **Dedupe**: deterministic ids (`run.completed:<runId>` etc.) dedupe replays, restarts, and
  duplicate `run.updated` writes. `emit` callers namespace their ids; `recorded:false` is a
  faithful dedupe signal.
- **Mapping completeness vs contract**: all three orchestration-sourced notification types
  (`thread.completed`, `thread.failed`, `thread.awaitingInput`) are produced;
  `connector.*`/`widget.threshold` arrive via `emit` from `ConnectorPoller`/`ConnectorService`
  (verified call sites). `run.updated` `cancelled`/`interrupted`/`waiting` produce nothing —
  consistent with the contract, which defines no matching notification type.
- **Ordering**: one merged tap, `mapEffect` concurrency 1, per-type sequences monotone —
  `blockedSince`/`lastProcessed` keying is sound; a blocked event can never be overtaken by a
  cursor write (`min(seq, blockedAt - 1)`).
- **Lifecycle**: `forkScoped` worker, scope-bound `PubSub.subscribe`/`fromSubscription`
  everywhere; `subscribe()` grabs the subscription before loading prefs so a concurrent
  `setPrefs` cannot fall between snapshot and feed.

## Findings

### [SEVERITY: HIGH] Finding 1: Worker has no restart path — a single stream-level failure permanently and silently kills the notification pipeline

**File**: apps/server/src/notifications/UserNotificationService.ts:363-374 (also 344-359)

**Problem**: Event-level errors are handled thoroughly inside `processStoredEvent`, but
failures of the _stream itself_ — e.g. a transient `EventSinkStreamError` /
`EventStoreReadEventsError` raised by `eventStore.read` inside the catch-up replay
(`catchUp`/`eventStore.read`, EventSink.ts:691), or `latestSequence()` failing during seeding
— propagate out of `Stream.runDrain` to the single `catchCause` at line 373, which logs
`"Watch notification worker stopped"` and lets the `forkScoped` fiber complete. Nothing
restarts it.

**Impact**: From that point until the next process restart the tap is dead: no notifications
are recorded into history, nothing is published, cursors stop advancing — while the service
object reports healthy. If the failure hits before `Deferred.succeed(started)` (line 359),
`awaitStarted()` hangs forever; after it, `awaitStarted` resolves on a dead worker and
`awaitProcessed` waits indefinitely. Durability is preserved only because cursors replay on
the next _process_ lifetime — a reboot nobody knows is needed, since the only signal is one
log line. Compare `ConnectorPoller.runLoop` (ConnectorPoller.ts:567-587), which deliberately
prevents a defect from killing its loop.

**Suggestion**: Restart the tap on failure — e.g. `Stream.retry`/`Effect.retry` with a capped
backoff around the whole `Stream.mergeAll(...).runDrain`, or `Effect.forever` over a
re-subscribe step, so a transient SQL error self-heals instead of ending the worker. Fail
`started` (e.g. `Deferred.failCause`) when seeding/stream setup fails so awaiters observe the
death instead of hanging.

### [SEVERITY: MEDIUM] Finding 2: Per-type cursor seeding is not atomic — a mid-seed crash permanently skips one type's interim events

**File**: apps/server/src/notifications/UserNotificationService.ts:344-356

**Problem**: `head = latestSequence()` is captured once, then each type's seed `INSERT ...
ON CONFLICT DO NOTHING` runs as its own statement (no `sql.withTransaction`). If the process
dies after seeding `run.updated` but before `runtime-request.updated`, the restart computes a
newer `head` and seeds the missing type at _that_ point. Resume only replays strictly after
the recorded cursor, so every `runtime-request.updated` committed between the first `head`
and the second seed is skipped forever — even though the service had already "started" for
the other type.

**Impact**: Permanent, silent loss of a bounded window of notifications for one event type —
violates "history must record every event once". Window is small (two adjacent inserts) but
nonzero, and the resulting state looks indistinguishable from the intended "predate first
boot" skip.

**Suggestion**: Wrap the per-type seed inserts in a single transaction so "first boot" is a
single consistent boundary for all types (all-or-nothing at one `head`).

### [SEVERITY: MEDIUM] Finding 3: A deterministically-unmappable event wedges its type's cursor forever with no dead-letter; the replayed tail re-scans on every restart

**File**: apps/server/src/notifications/UserNotificationService.ts:281-310 (mapping failure);
200-206 (silent thread-drop)

**Problem**: `notificationsFor` gets one retry; on a _persistent_ failure the event is marked
blocked and the durable cursor is clamped at `blockedAt - 1` — correctly, for transient
faults. But if the failure is deterministic (e.g. a projection read that always throws a
non-`NotFound` error, a persistently failing `recordNotification`), the clamp never lifts:
every restart replays the blocked event _and the entire later history of that type_ (dedupe
makes re-inserts no-ops, but every replayed event still runs `notificationsFor` — including
the `getThread` projection read — so the re-scan grows without bound for the life of the
install). There is no attempt counter, no dead-letter marker, and nothing distinguishing
"transient, will retry next boot" from "poisoned forever" beyond identical log lines. Related:
`threadFor` returning `null` (deleted/absent thread) silently returns `[]` and advances the
cursor — a permanent, un-logged drop for e.g. replayed `run.completed` events whose thread
was deleted during the gap.

**Impact**: One poisoned event = that notification is effectively lost (retry-on-restart can
never converge) plus an unbounded re-mapping cost on every boot; silent drops for gone
threads leave no audit trail in history.

**Suggestion**: Bound the replay: persist a per-sequence failure count (or a dead-letter row)
and, after N lifetime attempts, record the skip and let the cursor pass. At minimum, log when
`threadFor` returns `null` so the drop is observable, and short-circuit replayed events whose
`notificationId` already exists before paying the projection read.

### [SEVERITY: MEDIUM] Finding 4: `watch_notifications` grows without bound — no retention anywhere

**File**: apps/server/src/notifications/UserNotificationService.ts:178-198;
apps/server/src/persistence/Migrations/064_WatchNotifications.ts:9-22

**Problem**: The table is append-only and nothing ever deletes: every `run.completed`,
`run.failed`, pending `runtime-request`, connector health edge, rollback, and threshold
notification writes a row (plus the `recorded_at` index entry) forever. Verified: no
`DELETE FROM watch_notifications` exists in the codebase. `history` caps reads at 500 rows
but storage is uncapped.

**Impact**: Steady-state growth on a long-lived install; the history index and table scan
costs degrade over time, and the table joins the event store as another unbounded SQLite
payload. Low per-row cost but never zero, and `emit`-driven producers (poller threshold
rules) can add volume independent of event-store retention.

**Suggestion**: Add a retention bound (e.g. keep newest N rows or last M days by
`recorded_at`), enforced opportunistically in the worker or a periodic pass; document the
chosen bound in the migration comment that currently promises "append-only".

## Notes (non-findings)

- `emit`'s caller-chosen ids share the dedupe keyspace with the service's deterministic
  `run.completed:`/`run.failed:`/`runtime-request.pending:` ids — a future caller minting a
  colliding id would silently suppress the real notification (`recorded:false`). Current
  callers namespace correctly; worth a comment-level convention, not a code bug.
- `thread.failed` notifications never populate the contract's optional `error` field — the
  run payload carries no error text, so this is a contract-shaped completeness gap at most.
- `history` has no pagination input (contract limits to `limit` ≤ 500) — oldest entries
  become unreachable through the API even though retained; matches the contract as written.
- Test coverage (skim): dedupe-under-duplicates, resume-without-reemit, pre-boot skip, prefs
  reversibility + muted-still-recorded, retry-once success, and blocked-cursor restart replay
  are all covered. No test covers worker death on stream-level failure (Finding 1) or the
  permanently-failing-event wedge (Finding 3).
