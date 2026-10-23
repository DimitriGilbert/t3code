# Review 7 — ConnectorPoller (per-instance poll runtime)

Scope: `apps/server/src/watch/connectors/ConnectorPoller.ts` (806 lines); skimmed
`ConnectorPoller.test.ts`, `FileConnectorLatency.test.ts`, `__fixtures__/` (test-only,
clearly marked "TEST FIXTURE ONLY — never shipped"), plus `FileTransport.ts`,
`PackStore.loadInstalled`, `PackModule.ts`, `ConnectorService.recordHealth/subscribeList`,
`UserNotificationService` dedupe semantics, and `effect-smol` `Effect.timeout`.

## Findings

### [SEVERITY: HIGH] Finding 1: join/leave race lets a new subscriber attach to a runtime that is then destroyed

**File**: `apps/server/src/watch/connectors/ConnectorPoller.ts:697-709` (leaveRuntime), `642-658` (teardownRuntime), `679-695` (joinRuntime)

**Problem**: `leaveRuntime` reads `remaining === 0` via `Ref.modify` **before** acquiring the
`lifecycle` permit, then calls `lifecycle.withPermits(1)(teardownRuntime(rt))`. `joinRuntime`
acquires the same permit and — while `rt` is still in `runtimes` — attaches the new subscriber
to the doomed runtime.

Interleaving:

1. Last subscriber leaves → `Ref.modify` returns `remaining = 0`.
2. Before `leaveRuntime` acquires the permit, a new `subscribe` runs `joinRuntime` first:
   finds `rt` in `runtimes`, adds the subscriber, returns `rt`. The stream then does
   `PubSub.subscribe(rt.items)` and `wake(rt, ...)`.
3. `teardownRuntime` now runs: removes `rt` from `runtimes`, `Scope.close(rt.scope)` kills the
   poll loop and file watchers, `PubSub.shutdown(rt.items)` ends the new subscription.

**Evidence**: map removal is the first step inside the permit (`runtimes` update at 644-649)
and happens unconditionally when `map.get(instanceId) === rt` — there is no re-check of
`rt.subscribers.size` inside the critical section. Because this teardown is invoked without
`missing: true`, no `connectorMissing` item is published; `PubSub.shutdown` just ends the
stream, so the widget sees a silently completed subscription (no data, no error) and nothing
in the server will resurrect it — the instance is no longer in `runtimes`, and the orphaned
subscriber's own `ensuring(leaveRuntime)` only re-runs a teardown that early-outs.

**Impact**: A widget that mounts for an instance in the same instant the previous last
subscriber unmounts (list reorder, StrictMode remount, dashboard churn) gets a permanently
dead stream until the client happens to resubscribe — which nothing triggers.

**Suggestion**: Re-check emptiness inside the critical section — e.g. have `teardownRuntime`
re-read `Ref.get(rt.subscribers)` under the permit and bail when non-empty, or wrap the whole
`Ref.modify` + teardown in `lifecycle` so the size check and teardown are atomic with
`joinRuntime`.

---

### [SEVERITY: MEDIUM] Finding 2: threshold alerts re-fire on every resubscribe / server restart — timestamped `notificationId` defeats dedupe

**File**: `apps/server/src/watch/connectors/ConnectorPoller.ts:409-420`, `779-782`

**Problem**: The false→true latch lives in `Subscriber.thresholdFired`, which is rebuilt as
all-`false` on every `subscribe` call (781). Any resubscribe — server restart, client
reconnect, widget remount — clears the latch, and the first published snapshot after a
restart always runs `evalThresholds` (`last === undefined` at 451). Worse, the dedupe key is
`watch-notification:widget.threshold:${instanceId}:${widgetId}:${index}:${nowIso}` (414):
`UserNotificationService.emit` dedupes via `INSERT ... ON CONFLICT(notification_id) DO
NOTHING`, but embedding `nowIso` makes every fire a brand-new id, so the store-level
idempotency the comment relies on never engages.

**Evidence**: `UserNotificationService` doc: "a deterministic id makes the emit idempotent, a
unique one is [always recorded]" — here the id is unique-by-timestamp.

**Impact**: A threshold rule that stays true across a restart produces a duplicate user
notification every restart (and every widget resubscribe while data still crosses). On a
crash-loop or frequent reconnect the alert repeats each cycle.

**Suggestion**: Drop the timestamp for latched rules — e.g.
`...:${instanceId}:${widgetId}:${index}` — so a re-emitted "still true" alert is a no-op at
the store, or persist the fired latch. If distinct repeated alerts are intended per crossing,
include a content/state component (e.g. hash of the triggering value) instead of time.

---

### [SEVERITY: MEDIUM] Finding 3: health-transition notifications have no cooldown — a flapping source spams every edge

**File**: `apps/server/src/watch/connectors/ConnectorPoller.ts:490-502`

**Problem**: Notifications emit on each status edge with a per-emit unique
`watch-notification:${type}:${instanceId}:${nowIso}` id — again timestamped, so no dedupe and
no rate limit. On a source alternating success/failure, `consecutiveFailures` resets to 0 on
each success (435), so the backoff never grows and the loop keeps polling at the base
interval — emitting `connector.unhealthy` every other poll indefinitely.

**Impact**: A connector flapping at a 5s interval (or a configured floor down to
`MIN_POLL_FLOOR_MS` = 1s) generates a user-facing notification every ~2 intervals forever.
Sustained-failure dedupe across restarts works (healthStatus is seeded from persisted
`info.instance.health.status` at 625-627), but edge-flapping is unbounded.

**Suggestion**: Add a per-instance minimum interval between health notifications (e.g. emit
at most once per N minutes while continuing to update `healthStatus`), or require the status
to hold for a couple of consecutive runs before notifying.

---

### [SEVERITY: MEDIUM] Finding 4: forced `fs.watch` runs have no minimum interval while healthy

**File**: `apps/server/src/watch/connectors/ConnectorPoller.ts:561-566`, `597`;
`FileTransport.ts:27` (`FILE_WATCH_DEBOUNCE` = 250ms)

**Problem**: Forced wakes are only deferred while `consecutiveFailures > 0` and the backoff
deadline is pending. While healthy, every debounced signal runs the full pipeline
immediately — `collectWatchedFiles` (≤512 files, `realPath`+`stat`+read each), pack re-read +
sha256 re-verify, fresh `node:vm` realm eval, `fetch`/`transform`. A directory written at a
~300ms cadence sustains ~3-4 complete runs/sec indefinitely; the 250ms trailing debounce is
the only cap. (`MIN_PUSH_INTERVAL_MS` caps _publishes_, not runs.)

**Impact**: Local CPU/IO burn rather than upstream hammering — a busy log/state directory
watched by a file connector can keep a core busy; the expensive part (pack re-hash + vm eval)
is fixed cost per run.

**Suggestion**: Apply a minimum gap between forced runs too (e.g. refuse a forced run if one
completed < `pollFloorMs` ago, queuing the request instead), so churn coalesces into the next
scheduled slot.

---

### [SEVERITY: MEDIUM] Finding 5 (minor): identical error items are re-published every failed run

**File**: `apps/server/src/watch/connectors/ConnectorPoller.ts:503-507`

**Problem**: The success path dedupes snapshots by `last.json` (451), but the failure path
publishes an `error` item on every run regardless of whether anything changed —
`errorState(failure, …)` produces identical JSON while `lastGoodDataAt` is pinned to the last
success. A persistently failing connector pushes one WS message per poll per subscriber with
no new information.

**Impact**: Bounded by the poll interval/backoff, so low — but it's pure websocket churn
(against the repo's "never send more over websockets" bar), and each republish re-renders
every bound widget.

**Suggestion**: Cache the last emitted error payload (like `lastSnapshot.json`) and skip the
publish when unchanged; still record health/backoff as today.

## Verified OK (no finding)

- **Hash re-verify vs pack-code TOCTOU**: `loadInstalled` re-reads all pack bytes and
  re-hashes them before returning; `evalConnectorModule` runs the same in-memory
  `bundle.files`. Verification happens before eval over the identical bytes — no TOCTOU
  window.
- **Forced wakes cannot bypass backoff**: the `consecutiveFailures > 0 && nextRunAt > now`
  guard (561-566) plus the `forceRequest`/`runGeneration` protocol correctly defer forced
  runs during backoff (tested at `ConnectorPoller.test.ts:358-391`) and prevent duplicate
  fetches for N subscribers.
- **sliding(1) fan-out**: subscribe-before-read ordering plus the identity `dropWhile`
  (798-799) covers every publish-vs-read interleave; subscribers joining mid-flight ride the
  in-flight run via `runActive`.
- **Failure accounting**: transform and fetch failures both flow through `runPipeline` →
  `consecutiveFailures` — no phase is exempt; `TimeoutError` from `Effect.timeout` classifies
  as `connectorDown`.
- **No reconcile↔restart loop**: `recordHealth` writes `health_json` without touching
  `updated_at` (`ConnectorService.ts:955-959`), and the health-diff notify doesn't change
  `rt.updatedAt`, so health writes never trigger `restartRuntime`.
- **Schema check**: `configMismatch` legitimately carries no `instanceId` in
  `WatchWidgetErrorState` — matches contract.
- **Fixture pack**: `__fixtures__/` is test-only (marked, .mjs stub + pack dir), nothing
  ships.

## Summary

1 HIGH (lifecycle race — dead subscriptions), 4 MEDIUM (threshold re-alerts on restart,
health-notification flapping, unthrottled forced fs.watch runs, redundant error republishes).
Backoff math, fan-out replay, hash re-verification, and wake coalescing are sound.
