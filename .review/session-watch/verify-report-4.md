# Verify report — Cluster 4: UserNotificationService

Verifies `.review/session-watch/review-report-4.md` against
`apps/server/src/notifications/UserNotificationService.ts`, `EventSink.ts`,
`EventStore.ts`, `ConnectorPoller.ts`, migration `064_WatchNotifications.ts`, and
`.plans/welcome-screen/{PRD,PLAN,DESIGN}.md`.

**Verdicts: 4 VERIFIED-DEFECT, 0 VERIFIED-INTENTIONAL, 0 REJECTED.**

## Finding 1 (HIGH): worker dies permanently on stream failure — VERIFIED-DEFECT

- `worker` (UserNotificationService.ts:339-374) ends with a single
  `Effect.catchCause` that logs `"Watch notification worker stopped"` and lets the
  `Effect.forkScoped` fiber (line 385) complete. Grep confirms no `Stream.retry`,
  `Effect.retry` on the drain, `Effect.forever`, or supervision anywhere in the
  file — the only retry is the per-event mapping retry at line 289.
- Real failure paths escape `processStoredEvent`'s `catchCause` (which wraps only
  per-event handling, lines 311-320): `eventSink.latestSequence()` at line 344 and
  the seed/cursor SQL at 347-355 can fail pre-start; once streaming,
  `eventSink.stream`'s `Stream.unwrap` setup (`PubSub.subscribe`,
  `eventStore.latestSequence` — EventSink.ts:751-752) and `catchUp`'s
  `eventStore.read` (EventSink.ts:690-711) fail with `EventStoreReadEventsError`
  (EventStore.ts:86-108, 132-141) and propagate through `Stream.runDrain` to the
  one-shot `catchCause`. Worker dead until process restart; the service object
  still reports healthy.
- `awaitStarted` (line 450) is a bare `Deferred.await(started)`; `started` is only
  completed at line 359. Failure before 359 → `awaitStarted` hangs forever
  (nothing fails the Deferred). Failure after 359 → `awaitStarted` resolves on a
  dead worker and `awaitProcessed` (451-462) waits indefinitely — its
  `processedPubSub`/`lastProcessed` signals only fire in `processStoredEvent`'s
  `ensuring` (321-336).
- Contrast confirmed: `ConnectorPoller.runLoop` (ConnectorPoller.ts:567-586)
  wraps `runOnce` in `Effect.catchDefect` _inside_ the loop with the comment "a
  defect in one run must not kill the poll loop" — a deliberate guard this worker
  lacks.
- **Fix direction**: wrap the whole seed + `Stream.mergeAll(...).runDrain` in
  `Effect.retry` with a capped backoff (or `Effect.forever` over a re-subscribe),
  and `Deferred.failCause(started, ...)` when setup fails so awaiters observe
  death instead of hanging.

## Finding 2 (MEDIUM): non-atomic cursor seeding — VERIFIED-DEFECT

- Lines 344-356: `head` captured once, then the `for` loop issues two separate
  `INSERT ... ON CONFLICT DO NOTHING` statements (one per `CONSUMED_EVENT_TYPES`
  entry). No `sql.withTransaction` — the codebase has and uses the pattern
  (EventSink.ts:663).
- Crash between the two inserts: restart recomputes a newer `head'`; the missing
  type seeds at `head'` via `ON CONFLICT DO NOTHING`, so its events in
  `(head, head']` are skipped forever while the already-seeded type resumes from
  `head`. Permanent, silent, and indistinguishable from the intended
  "predate first boot" skip.
- **Fix direction**: wrap the seed inserts in a single `sql.withTransaction` so
  "first boot" is one consistent boundary for all types.

## Finding 3 (MEDIUM): permanently-blocked event wedges cursor — VERIFIED-DEFECT

- `notificationsFor` gets exactly one retry (line 289). On persistent failure the
  outer `catchCause` (312-320) calls `markBlocked` (272-279), recording the
  earliest unhandled sequence in the in-memory `blockedSince` Ref (line 163,
  reset per lifetime). The gen body's `advanceCursor` never runs for the failed
  event; subsequent same-type events clamp the durable cursor at
  `min(seq, blockedAt - 1)` (line 309) — never past `blockedAt` for the rest of
  the process lifetime.
- Restart replays from `blockedAt - 1` (`afterSequence` is strictly exclusive —
  OrchestrationEventStore.ts:592/612), re-running `notificationsFor` — including
  `getThread` projection reads — on the blocked event plus the entire later tail
  of that type. A deterministic failure re-blocks identically every boot, so the
  re-scan grows unboundedly. No persisted attempt count or dead-letter row exists
  (migration 064 has no such column; `blockedSince` is memory-only).
- `threadFor` returning `null` → `return []` at lines 220-221 and 242-243: silent
  drop, no log, cursor advances — confirmed for replayed events whose thread was
  deleted during the gap.
- **Fix direction**: persist a per-sequence failure count or dead-letter marker;
  after N lifetime attempts let the cursor pass. Log on `threadFor === null`.
  Optionally short-circuit replayed events whose deterministic `notificationId`
  already exists before paying the projection read.

## Finding 4 (MEDIUM): unbounded `watch_notifications` growth — VERIFIED-DEFECT

- Grep over `apps/server/src` confirms no `DELETE FROM watch_notifications`
  anywhere — only `INSERT` (UserNotificationService.ts:179) and `SELECT`
  (line 406). `history` caps reads at `HISTORY_MAX_LIMIT = 500` (lines 98, 403)
  but storage is uncapped. Migration 064:9-22 declares the table "append-only".
- Retention precedent exists in-repo: `pruneSettled` (EffectOutbox.ts:666-691)
  and `orchestration_events` pruning (ProjectionMaintenance.ts:315).
- **Docs check**: PLAN.md:289-303 documents "append-only" as a dedupe/emit-once
  guarantee and cursor checkpoints for _process_ restarts — it records no
  retention bound, no "never delete" rationale, and no worker-supervision intent
  (the "restarts" in PLAN.md:111-112 mean process restarts resuming from cursor).
  PRD.md:243-257 ("history always records it") and DESIGN.md §10 are silent on
  storage bounds. So the absence is an unaddressed gap, not documented intent.
- **Fix direction**: add a retention bound (newest N rows or last M days by
  `recorded_at`), pruned opportunistically in the worker or via a periodic pass
  following the `pruneSettled` precedent; amend the migration comment.

## Notes

- Report's file/line citations all check out (finding cites 363-374, 344-356,
  281-310, 178-198, and ConnectorPoller.ts:567-587 — all accurate).
- `catchCause` at line 373 also intercepts interruption/defects — on scope
  shutdown the worker logs "stopped" then completes normally; harmless but
  slightly noisy on shutdown.
