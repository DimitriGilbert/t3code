# Verification Report — Review Report 7 (ConnectorPoller)

Verified each finding against `apps/server/src/watch/connectors/ConnectorPoller.ts` (806 lines),
`FileTransport.ts`, `ConnectorService.ts` (`recordHealth`/`healthChanged` :910-961),
`UserNotificationService.ts` (`emit`/`recordNotification` :61-69, :170-198),
client resubscribe machinery (`packages/client-runtime/src/rpc/client.ts` :242-444,
`state/runtime.ts` :643-671, `connection/registry.ts` `followStream` :446-478),
`ConnectorPoller.test.ts`, `FileTransport.ts` debounce + `effect-smol` `Stream.debounce`
(:7996+), and `.plans/welcome-screen/{PRD,PLAN,DESIGN,BRIEFING}.md`.

## Verdict counts

- VERIFIED-DEFECT: 5
- VERIFIED-INTENTIONAL: 0
- REJECTED: 0
- Severity changes: Finding 5 MEDIUM → LOW (the report itself calls it minor).
  Two fix-direction corrections on Findings 2 and 4 — details below.

---

### Finding 1 — VERIFIED-DEFECT, HIGH retained

Race confirmed line-by-line. `leaveRuntime` (ConnectorPoller.ts:697-709) removes the
subscriber and reads `remaining` via `Ref.modify` **outside** the `lifecycle` permit;
the teardown is dispatched afterwards under `lifecycle.withPermits(1)` (:705).
`joinRuntime` (:679-695) does map-lookup + `Ref.update(rt.subscribers)` entirely inside
the permit. Interleaving is real: leave's `Ref.modify` returns 0 → join acquires the
permit first, finds `rt` still in `runtimes`, attaches, returns → `subscribe`
(:789-800) does `PubSub.subscribe(rt.items)` + `wake` → leave's permit then runs
`teardownRuntime` (:642-658): `runtimes` removal is unconditional on identity
(`map.get === rt`, :644-649 — **no re-check of `subscribers.size`**), `Scope.close`
kills the poll loop and file watchers, `PubSub.shutdown` ends the new stream.
The orphaned subscriber's `ensuring(leaveRuntime)` (:800) re-runs teardown, which
early-outs on the identity check — nothing resurrects the runtime.

Client-side impact confirmed, not assumed: `watchConnectorSubscribe` is wired via
`createEnvironmentRpcSubscriptionAtomFamily` → `subscribe(tag, input)` with **no**
`retryExpectedFailureAfter` and no `resubscribe` signal (watch.ts:121-124,
client.ts:434-444). `subscribeDynamicMapped` only re-subscribes on
`supervisor.session` changes or expected _failures_ (client.ts:277-395). A clean
server-side stream end (PubSub shutdown, no error) terminates the inner stream
permanently — the widget sees a silently completed subscription until remount,
reconnect, or idle-TTL re-mount. This teardown path is invoked without
`missing: true`, so no `connectorMissing` item is published — genuinely silent.

The window is narrow (Ref.modify → permit acquisition) but the triggers are common:
React StrictMode unmount→remount, edit-mode widget remounts, multi-client churn.
Fix directions (either works):

- Re-check `Ref.get(rt.subscribers)` inside `teardownRuntime` under the permit and
  bail (skip map removal + scope close) when non-empty — the joined subscriber's
  queued wake keeps the runtime alive.
- Or move the subscriber removal _and_ the emptiness check inside the permit in
  `leaveRuntime`, so remove+teardown is atomic w.r.t. `joinRuntime`.

### Finding 2 — VERIFIED-DEFECT, MEDIUM retained

Mechanics confirmed: `thresholdFired` is per-`Subscriber`, rebuilt all-`false` per
`subscribe` (:781); after restart `lastSnapshot` is undefined so the first run always
evaluates thresholds (:450-466); `notificationId` embeds `nowIso` (:413-415) so
`INSERT ... ON CONFLICT(notification_id) DO NOTHING`
(UserNotificationService.ts:179-189) can never dedupe a re-fired alert. A widget
remount / StrictMode cycle re-arms the latch and the next _changed_ snapshot re-fires
while the condition stayed continuously true — contradicting PLAN 3b's
"once per crossing, not per poll".

Intent check: nothing in PRD/PLAN sanctions re-alerts on resubscribe. The codebase
shows the author _did_ care about restart dedupe where cheap — `healthStatus` is
seeded from persisted `info.instance.health.status` (:625-627) precisely so a
sustained failure doesn't re-notify across restarts. Thresholds have no persisted
state, so restart re-fire is an unhandled gap. The `emit` doc (:62-66) explicitly
offers deterministic vs. unique ids; the timestamped choice here buys nothing
in-crossing (the latch already prevents repeats) and only forfeits dedupe.

**Fix-direction correction**: dropping `nowIso` wholesale is wrong — a later
_distinct_ crossing (false→true again) would then dedupe forever in history. Right
minimal fix: hoist the latch to a per-runtime map keyed `${widgetId}:${ruleIndex}`
(survives resubscribe of the same widget, which is the common churn case), keep a
per-emit unique id for genuine new crossings. Cross-restart dedupe additionally
needs persisted latch state — acceptable to scope that out and accept one re-alert
per restart, but the resubscribe re-arm should be fixed.

### Finding 3 — VERIFIED-DEFECT, MEDIUM retained

Confirmed: failure path emits `connector.unhealthy`/`connector.authExpired` on every
status edge (:490-502) with a timestamped (unique) id; success resets
`consecutiveFailures` to 0 (:435) and `nextRunAt` to `now + interval` (:436), so a
flapping source never accrues backoff — it polls at the base interval (default 5s,
floor `MIN_POLL_FLOOR_MS` = 1s at :61) and emits a fresh user notification roughly
every other poll forever.

Edge-only emission is intentional design (comment :490, test :306-309 asserts once
per transition for sustained failure) — the _flap_ case is the unhandled emergent
defect, and there is no cooldown or hold-down anywhere. Extra churn the report
didn't mention: each flap also toggles `health_json.status`, so
`healthChanged` → `notifyChanged` (ConnectorService.ts:954-960) re-pushes the full
instances list to every `watchConnectorsSubscribeInstances` client each edge, and
every flap edge appends a `watch_notifications` history row (ties into
verify-report-2 Finding 4's unbounded-history defect). MEDIUM fair.

**Fix direction**: per-instance notification cooldown (e.g. suppress repeat
`connector.unhealthy` within N minutes of the last emit while still writing
`health_json`), or require the failure status to hold for ≥2 consecutive runs before
the first notify; persist `lastHealthNotifiedAt`-style state if the cooldown must
survive restarts.

### Finding 4 — VERIFIED-DEFECT, MEDIUM retained (one nuance)

Confirmed: forced wakes are deferred only while `consecutiveFailures > 0` and the
backoff deadline is pending (:561-566). While healthy, every debounced signal runs
the full `runPipeline` — file collection (≤512 files, `realPath`+`stat`+read each),
pack re-read + sha256 verify (:337-340), fresh vm realm eval (:341), fetch/transform.
`MIN_PUSH_INTERVAL_MS` (:389-399) caps _publishes_ only; `sliding(1)` wake queue +
`forceRequest`/`runGeneration` coalesce bursts but not the steady cadence — a run
completes, the next signal arrives ~300ms later, another run starts. ~3-4 heavy
runs/sec sustained is real.

Nuance on the debounce: `Stream.debounce` (effect-smol :7996+) is _trailing_ — under
truly continuous sub-250ms churn it emits **nothing** until a quiet window, so the
worst case is the ~300ms cadence the report describes, not higher rates; sustained
bursts actually starve the signal and degrade to the poll interval (freshness
quirk, not a crash vector).

**Fix-direction correction**: the report's "refuse a forced run if one completed <
`pollFloorMs` ago" would violate PRD journey 5 (file-write → snapshot p95 ≤1s)
under the default 5s floor. Correct fix is a dedicated minimum run gap on the
forced path (e.g. ~`MIN_PUSH_INTERVAL_MS` = 1s): a forced request arriving inside
the gap schedules a run at gap expiry rather than running immediately — the
existing `forceRequest`/`runGeneration` protocol already coalesces the request, so
this is a deadline check in `runLoop`, not a queue change.

### Finding 5 — VERIFIED-DEFECT, downgrade MEDIUM → LOW

Confirmed: the success path dedupes via `lastSnapshot.json` (:450-451) but the
failure path unconditionally `publishItem`s an `error` item every run (:503-507).
`errorState` (:180-202) carries only `cause`/`instanceId`/`field`/`lastGoodDataAt` —
no message — so identical failures with a pinned `lastGoodDataAt` produce byte-identical
payloads republished per poll per subscriber. Pure WS churn with zero information
gain; each republish re-renders every bound widget.

LOW rather than MEDIUM: bounded by poll interval + backoff (unlike Finding 3 the
_stream_ traffic does shrink under backoff), one message per failed run, and the
report itself labels it minor. Still a real defect — the asymmetry with the
success-path dedupe reads as oversight, not intent; nothing in PRD/PLAN asks for
re-published errors.

**Fix direction**: cache the last emitted error JSON alongside `lastSnapshot` (or a
`lastErrorJson` Ref) and skip `publishItem` when unchanged; keep `recordHealth` and
backoff updates as today.

## Verified OK — spot-checked, no objection

- Report's "Verified OK" list holds: `loadInstalled` re-hash before eval leaves no
  TOCTOU; backoff deferral of forced wakes is correct and tested
  (ConnectorPoller.test.ts:358-391); sliding(1)+subscribe-before-read fan-out is
  sound; `recordHealth` never touches `updated_at` (:955-959) so no
  reconcile↔restart loop; `configMismatch` legitimately lacks `instanceId`.

## Citation accuracy

All cited line numbers verified accurate. Minor nit: report cites "FileTransport
debounce ~250ms" as `FileTransport.ts:27` — the constant is `FILE_WATCH_DEBOUNCE`
at :27 (accurate); the debounce application is `debounceSignals` at :252-253.
