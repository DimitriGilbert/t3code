# Fix plan — feat/watch-screen deep review

Built from `review-report-{1..15}.md` + `verify-report-{1..15}.md` (verifies are
authoritative; severities/dedupe below follow their verdicts).

**Worktree state**: `git status --porcelain` shows only `?? .review/` — clean.
Scratch-file cleanup requested by orchestrator: `apps/server/scripts/seed-install-request.ts`
and `.plans/welcome-screen/seed-install-request.ts` — **both confirmed absent; nothing to delete.**

## Headline decision: the `node:vm` escape (r6-F1, CRITICAL)

**Decision: implement the `worker_threads` boundary (task P1-T1).**

Reasoning: the entire connector security model — `egressHosts` allowlist, declared
secret keys, file-root confinement, the human confirm dialog reviewing the manifest —
only means something if pack code is genuinely contained. "Honest docs only" converts
all of that machinery into decorative UI: an approved-but-hostile pack gets
`process.env` (provider API keys), unrestricted network, and `~/.t3/userdata` in one
line (`module.constructor.constructor("return process")()`). The PRD non-goal
(`PRD.md:60-62`) scoped out an isolate, but the shipped comments then claimed
guarantees the non-goal forfeited — we either pay for the boundary or admit the
confirm dialog reviews a manifest whose declared egress/secrets are unenforced.
`worker_threads` is feasible in-scope (verifier estimate ~1–2 days, no native deps —
`isolated-vm` rejected for the native dep, SES/membrane rejected because every host
value in the realm re-leaks `Function`), and it _additionally_ fixes r6-F6
(unpreemptable sync spin / untimed callbacks) via `worker.terminate()`. The comment
fixes ship regardless. If maintainers veto the worker boundary, the fallback is
documented under "Not fixing" — but the recommendation is to build it.

## Dedupe table (fix once)

| Merged fix                                         | Sources                                                  | Severity (final) |
| -------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| packDirName `..` traversal                         | r5-F1 = r6-F3                                            | HIGH             |
| migrateConfig secret laundering                    | r2-F1 = r5-F6                                            | HIGH             |
| approved-version pin overwrite                     | r2-F5 = r5-F2                                            | HIGH             |
| manifest diff gap (widgets/bridge/authSchema/desc) | r10-F1 = r13-F1                                          | HIGH             |
| watchUiBus unbounded queue                         | r12-F4 = r14-F8                                          | MEDIUM           |
| secrets storable in `config`                       | r1-F2 = r2-F2                                            | MEDIUM           |
| rename/reorder doc overclaim                       | r1-F5 = r3-F4                                            | LOW              |
| `allowLocalUrl`/prepare scope                      | r5-F4b = r11-F1 (intent) + r5-F4a,c (defects)            | see P2           |
| unbounded `watch_notifications`                    | r2-F4 = r4-F4                                            | MEDIUM           |
| threshold re-alert on resubscribe                  | r1-F1 amplifier = r7-F2 (fix together per verify-1 note) | MEDIUM           |

Rejected: r9-F7a (registryKey stranding — unreachable precondition; comment-level note only).
Verified-intentional but residual-bearing: r11-F1 scope choice (operate deliberate per
PLAN.md:367-370), r11-F2 agent prefs tool (PRD-specced).

---

## Phase 1 — CRITICAL / HIGH (server security core + the two client HIGHs)

### P1-T1 · Replace `node:vm` realm with a `worker_threads` pack boundary — r6-F1 (CRITICAL), r6-F6 (MEDIUM)

**Files** (≤5):

- `apps/server/src/watch/connectors/PackModule.ts` — rewrite `evalConnectorModule` /
  `invokePackFunction` to spawn a `Worker` per invocation (or pooled per run);
  `module.exports` evaluated inside the worker; ctx crosses as **data only**.
- `apps/server/src/watch/connectors/PackWorker.entry.ts` _(new)_ — worker entry.
  Packaging constraint: prefer `new Worker(source, { eval: true })` with an inline
  source constant so the CLI SEA/bundle (`build-exe`, `cli-external-packages.ts`)
  needs no extra shipped file; verify the bundled path works.
- `apps/server/src/watch/connectors/ConnectorPoller.ts` — build ctx as serialized
  data: `config`/`files` structured-clone in; `ctx.secrets.get` — resolve declared∩
  configured keys eagerly to a `Record` on the host and pass as data (declared-keys
  enforcement stays host-side); `ctx.fetch` → MessagePort RPC returning serialized
  `{status, headers, body}` (already async — no pack API change needed);
  `failAuthExpired` → tagged sentinel result the host maps to `AuthExpired`.
- `apps/server/src/watch/connectors/ConnectorService.ts` — `runConfigMigration`
  ctx likewise (and if P1-T4 lands first, the migrate ctx has no secrets accessor
  at all — preferred; see dependency).
- `apps/server/src/watch/connectors/PackModule.test.ts` (+ new worker test) —
  escape probes (`module.constructor.constructor("return process")` must throw/
  return undefined), sync `while(1){}` killed by `worker.terminate()` on timeout,
  fetch RPC round-trip, secret accessor contract.

**Fix specifics**: real timeouts — wrap invocation in `Effect.timeout` and terminate
the worker on expiry (fixes the 60s "bounds the wait not the work" gap in the poller
and the untimed `migrateConfig` wedge in confirm/rollback). Rewrite the overclaiming
comments: `PackModule.ts:2-3,26-29`, `HttpTransport.ts:7-9`, and the PRD-mitigation
wording in the service docstrings — post-worker these claims become _true_, so state
the boundary precisely ("pack code runs in a worker thread; only structured-clone
data crosses; fetch/secret access is host-mediated").

**Tests**: escape suite above; keep existing fetch/transform/migrate coverage.
**Deps**: sequence after **P1-T4** if both land — T4 removing `ctx.secrets` from the
migrate ctx shrinks the worker marshaling surface. Same fixer should own T3/T4 or run
strictly sequentially (all three touch `ConnectorService.ts`).
**Validation**: `vp test run apps/server/src/watch/connectors/PackModule.test.ts
apps/server/src/watch/connectors/ConnectorPoller.test.ts` ; `vp run --filter t3 typecheck`.

### P1-T2 · PackStore + HttpTransport hardening — r5-F1/r6-F3 (HIGH), r6-F2 (HIGH), r6-F4 (MEDIUM) + minors

**Files** (4):

- `apps/server/src/watch/connectors/PackStore.ts` —
  (a) validate `manifest.id` at bundle acceptance: reject any id not matching
  `^[A-Za-z0-9][A-Za-z0-9._-]*$` AND matching `^[.]+$` (dot-only). Failure →
  `manifestInvalid`.
  (b) Defense-in-depth: in `installedPackDir`, assert
  `path.resolve(...)` starts with `connectorsDir + sep` before write/remove.
  (c) Minor bundle-in: `readLocalBundle`'s `files[entry] = content` proto-setter
  wedge (`__proto__` file) — build the map via `Object.create(null)` or `Map`.
  (d) Stretch: `materializeBundle` write-side symlink-follow — open with
  `O_NOFOLLOW` or temp+rename (skip if it inflates the diff; note residual).
- `apps/server/src/watch/connectors/HttpTransport.ts` —
  (a) r6-F2: route `ctx.fetch` through the install path's
  resolve→`isLocalAddress`→pinned-`lookup` pipeline (export/reuse from
  `PackStore.ts`'s `ConnectorPackFetch`); no `allowLocal` carve-out for runtime
  egress.
  (b) r6-F4: validate `egressHosts` at manifest decode — reject `"*"`, `"*."`,
  empty wildcard suffix, and public-suffix wildcards (`*.com`, `*.co.uk`);
  normalize trailing dot off `url.hostname` before `isHostAllowed` matching.
  (c) Minor bundle-in: byte cap on `ctx.fetch` response bodies.
- `PackStore.test.ts`, `HttpTransport.test.ts` — `..`/`.`/dot-only ids rejected;
  confinement assert fires; `*.` rejected; `evil.example.` does not match
  `*.example.com`; declared host resolving to `127.0.0.1`/`169.254.169.254`
  blocked at runtime egress.

**Validation**: `vp test run apps/server/src/watch/connectors/PackStore.test.ts
apps/server/src/watch/connectors/HttpTransport.test.ts` ; `vp run --filter t3 typecheck`.

### P1-T3 · ConnectorService confirm-path integrity — r5-F2/r2-F5 (HIGH), r5-F3, r5-F7, r5-F5 (MEDIUM); r13-F3/F4 server halves

**Files** (2): `apps/server/src/watch/connectors/ConnectorService.ts`,
`ConnectorService.test.ts` (+ additive contract literal below — owned here,
one line in `watch.ts`).

- **Approved-version pin (HIGH)**: in the confirm write txn (:1393-1411), when a
  non-archived `(pack_id, schema_version)` row exists, allow the upsert only if
  `content_hash` and `manifest_hash` are identical (true re-approval /
  archived-revive — the revive behavior is intentional per
  `ConnectorService.test.ts:743`); else fail `versionAlreadyApproved` — **add the
  literal to `WatchConnectorErrorReason`** (`packages/contracts/src/watch.ts:560-586`).
  Optionally populate install-leg `diffBase` so the dialog can warn.
- **Pending re-check**: final UPDATE → `SET status='confirmed', resolved_at=?
WHERE request_id=? AND status='pending'`, fail `requestNotPending` on 0 rows.
- **Deferred NULL-pack_id requests**: on `uninstall`/`purge`, also cancel/delete
  pending deferred rows whose origin could resolve to the pack (or refuse
  prepare/purge while bindable rows exist); add `AND status='pending'` to the
  prepare UPDATE (:1246-1254); add a per-pack/environment pending-request cap.
- **`notifyChanged` after prepare row update** (:1246-1264) — required by the
  client-side half of r13-F3 (P1-T7).
- **`recordHealth` single-writer fix (r5-F5)**: merge via SQL `json_patch`/
  `json_set` against current `health_json`, or pass delta fields only from
  rollback/confirm; drop the false "poller is the only writer" comment.
- **`healthChanged` coarse `lastFetchAt` notify (r13-F4 server half)**: re-push
  when `lastFetchAt` crosses a coarse bucket (~15min) so the widget's liveness
  label stays honest without per-poll churn; mobile renders the same field and is
  fixed automatically.

**Tests**: same-version different-content install confirm rejected; archived-revive
still works (existing test must keep passing); cancel-during-confirm race yields
`requestNotPending`; deferred request cancelled on uninstall/purge; prepare UPDATE
status guard; health merge preserves `lastRollback` under interleaved poller write.
**Deps**: shares `ConnectorService.ts` with T1/T4 — same owner or strict sequencing.
**Validation**: `vp test run apps/server/src/watch/connectors/ConnectorService.test.ts` ;
`vp run --filter t3 typecheck` ; `vp run --filter @t3tools/contracts typecheck`.

### P1-T4 · ConnectorService secrets hygiene — r2-F1/r5-F6 (HIGH), r1-F2/r2-F2 (MEDIUM), r2-F3 (LOW)

**Files** (3): `ConnectorService.ts`, `PackModule.ts`, `ConnectorService.test.ts`
(+ `PackModule.test.ts` if the ctx type changes — keep ≤5 total).

- **migrateConfig laundering (HIGH)**: remove `ctx.secrets` from the migrate
  context entirely (verifier's cleanest option — migrateConfig only transforms
  config); belt-and-suspenders, scrub the migrated object before persist at both
  write sites (:1447 upgrade re-pin, :1547 `repinInstance`): drop keys ∩
  `manifest.secretKeys` and drop string values equal to a resolved secret. Fix the
  docstring at :105-108.
- **config∩secretKeys rejection (MEDIUM)**: in `createInstance` (:716-736) and
  `setInstanceConfig` (:821-844), reject `config` keys intersecting
  `manifest.secretKeys` with `configInvalid` naming the field (invert the existing
  `undeclaredSecretKey` check).
- **Orphaned secrets after re-pin (LOW)**: validate `clearSecretKeys` against
  `instance.configuredSecretKeys` (union with declared), and on re-pin prune
  `secret_keys_json` + stored values to the new manifest's declared set so stale
  values can't silently reactivate.

**Tests**: migrate returning a resolved secret lands nothing secret in
`config_json`; config with a declared-secret key rejected at create and update;
clearSecretKeys on a dropped-declaration key succeeds post-re-pin; secrets pruned
on re-pin.
**Deps**: before/with P1-T1 (shrinks worker ctx). Same owner as T3.
**Validation**: same as T3 + `PackModule.test.ts`.

### P1-T5 · ConnectorPoller lifecycle + notification discipline — r7-F1 (HIGH), r7-F2/F3/F4 (MEDIUM), r7-F5 (LOW)

**Files** (3): `ConnectorPoller.ts`, `ConnectorPoller.test.ts`, optionally
`FileConnectorLatency.test.ts`.

- **Join/leave race (HIGH)**: inside `teardownRuntime`'s permit, re-check
  `Ref.get(rt.subscribers)` and bail (no map removal / scope close) when non-empty
  — OR move leave's subscriber removal + emptiness check inside `lifecycle` so
  remove+teardown is atomic w.r.t. `joinRuntime`.
- **Threshold re-alert (MEDIUM)**: hoist the false→true latch to a per-runtime map
  keyed `${widgetId}:${ruleIndex}` (survives resubscribe — the common churn case);
  keep the per-emit unique `notificationId` for genuine new crossings (verifier
  correction: do NOT drop `nowIso` wholesale or later crossings dedupe forever).
  Cross-restart re-fire stays an accepted residual unless latch state is persisted.
- **Flap cooldown (MEDIUM)**: per-instance notification cooldown (suppress repeat
  `connector.unhealthy` within N minutes while still writing `health_json`) or
  require ≥2 consecutive failure runs before first notify.
- **Forced-run gap (MEDIUM)**: minimum run gap (~`MIN_PUSH_INTERVAL_MS` = 1s) on
  the forced-wake path — a deadline check in `runLoop`, not a queue change (the
  verify correction: `pollFloorMs` would violate the ≤1s freshness journey).
- **Error republish dedupe (LOW, bundled)**: cache last emitted error JSON;
  skip `publishItem` when unchanged.

**Tests**: join-during-teardown keeps stream alive; resubscribe does not re-fire a
still-true threshold while a fresh crossing does emit; flap → at most one
notification per cooldown window; forced signals inside the gap coalesce to one
run; identical error items not republished.
**Validation**: `vp test run apps/server/src/watch/connectors/ConnectorPoller.test.ts
apps/server/src/watch/connectors/FileConnectorLatency.test.ts` ; typecheck.

### P1-T6 · UserNotificationService supervision + retention — r4-F1 (HIGH), r4-F2/F3 (MEDIUM), r4-F4/r2-F4 (MEDIUM)

**Files** (≤4): `UserNotificationService.ts`, `UserNotificationService.test.ts`,
`apps/server/src/orchestration-v2/ProjectionMaintenance.ts` (or in-worker periodic
prune — follow the `pruneSettled` precedent), `064_WatchNotifications.ts` (comment
amendment only — do NOT edit migration DDL; it's already applied).

- **Worker death (HIGH)**: wrap seed + `Stream.mergeAll(...).runDrain` in
  `Effect.retry` with capped backoff (or `Effect.forever` over re-subscribe);
  `Deferred.failCause(started, ...)` on pre-start failure so `awaitStarted` /
  `awaitProcessed` callers observe death instead of hanging. Mirror the
  `ConnectorPoller.runLoop` "defect must not kill the loop" precedent.
- **Cursor seeding (MEDIUM)**: single `sql.withTransaction` around the per-type
  seed inserts (:344-356) — first boot is one boundary.
- **Poisoned event wedge (MEDIUM)**: persist a per-sequence failure count or
  dead-letter marker; after N lifetime attempts let the cursor pass; log on
  `threadFor === null`; short-circuit replayed events whose deterministic
  `notificationId` already exists before paying the projection read.
- **Retention (MEDIUM)**: prune by age and/or max row count (serviceable by
  `idx_watch_notifications_recorded`); run alongside ProjectionMaintenance or in
  the worker on an interval; amend the migration's "append-only" comment.

**Tests**: injected stream failure → worker restarts and `awaitStarted` doesn't
hang; seeded cursor atomicity; poisoned event dead-letters after N attempts and
cursor advances; retention deletes old rows, keeps newest N.
**Validation**: `vp test run apps/server/src/notifications/UserNotificationService.test.ts` ;
`vp run --filter t3 typecheck`. Note: server tests must drain
`OrchestrationEffectWorkerV2` / await persisted milestones — no sleeps.

### P1-T7 · Manifest diff + confirm dialog — r10-F1/r13-F1 (HIGH), r13-F2 (MEDIUM), r13-F3 client half (MEDIUM)

**Files** (3): `packages/client-runtime/src/state/watchConnectors.ts` (+ its test),
`apps/web/src/components/watch/WatchConnectorInstallConfirmDialog.tsx`.

- Extend `WatchConnectorManifestDiff`/`diffWatchConnectorManifests` (:49-67) with:
  a `widgets` group (added/removed names; per-widget `bridge.subscriptions`/
  `bridge.actions` deltas on same-name matches; `file` moves flagged), an
  `authSchema` changed marker (deep-equal), operation `description` deltas — and a
  generic "manifest surface changed" fallback row so a real surface move can never
  render as a bare `schemaVersion N → M`.
- `ConfirmBody` (:193-220): add operations (name + description) and
  bundled-widgets (name + bridge summary) sections on both install and upgrade legs.
- r13-F3 client half: compute `needsLocalFetchAck` from `shownRequest`
  (`prepared?.request ?? request`) **and** reset `reviewed = false` when `prepared`
  lands for a localUrl request — both halves needed or the gate stays decorative.
  (Server `notifyChanged` is P1-T3.)

**Tests**: diff emits widget/bridge/authSchema/description rows; dialog renders
operations+widgets on install; localUrl leg requires a fresh post-fetch ack.
**Validation**: `vp test run packages/client-runtime/src/state/watchConnectors.test.ts` ;
`vp run --filter @t3tools/client-runtime typecheck` ; `vp test run --project unit`
for any dialog test added (web test script: `vp test run --passWithNoTests --project unit`).

---

## Phase 2 — MEDIUM security-adjacent

### P2-T8 · Subscribe payload hardening — r1-F1 (MEDIUM)

**Files** (≤4): `packages/contracts/src/watch.ts` (subscribe input),
`apps/server/src/watch/connectors/ConnectorPoller.ts` (`subscribe` :742-802),
`packages/client-runtime/src/state/watch.ts` (atom input builder),
`apps/web/src/components/watch/WatchAppFrame.tsx` (feed caller :60-89) if the
payload shape changes.

**Fix** (verifier-preferred, matches PLAN intent "no client/agent RPC can raise a
threshold"): drop `thresholds` from `WatchConnectorSubscribeInput` and read rules
from the widget's stored `config.settings` at subscribe time; when `widgetId` is
present, require the widget row to exist and bind `input.instanceId` (reject
otherwise). Keep `refreshPolicy` (documented subscriber-driven cadence). If the
config-read proves invasive, the fallback is the minimum viable: validate
widgetId-existence + instanceId binding server-side. Do this together with T5's
latch hoist (verify-1 integrator note) — **dep: after P1-T5** (same file).
**Tests**: subscribe with foreign/missing widgetId rejected; thresholds arrive from
stored widget config, not the wire.
**Validation**: `vp test run apps/server/src/watch/connectors/ConnectorPoller.test.ts` ;
`vp run --filter @t3tools/contracts test` ; typechecks for contracts + server +
client-runtime.

### P2-T9 · File-transport roots hardening — r6-F5 (MEDIUM)

**Files** (2): `apps/server/src/watch/connectors/FileTransport.ts`,
`FileTransport.test.ts`.

- Denylist in `parseFileWatchConfig`: reject `/proc`, `/sys`, `/dev`, the T3
  `stateDir`/`connectorsDir`/`secrets` paths, and `~/.ssh` (resolve + prefix-check
  after `path.resolve`, incl. symlink-realpath).
- Read files with a streaming byte cap instead of trusting `stat.size` (procfs
  reports 0) — cut at `MAX_WATCH_FILE_BYTES`.
- Document residual: `watch.roots` remains agent-writable via `config_set`; the
  human-confirm gate for root changes is deferred (see "Not fixing") — state this
  in the service docstring.

**Tests**: denylist roots rejected; zero-size stat files still capped on read.
**Validation**: `vp test run apps/server/src/watch/connectors/FileTransport.test.ts`.

### P2-T10 · Bridge + frame + mounts hardening — r9-F1 mitigations (HIGH-residual), r9-F2/F4/F5 (MEDIUM), r9-F3/F6/F7b/F8/F9 + r10-F4 (LOW, bundled)

**Files** (5):

- `packages/client-runtime/src/watchAppBridge.ts` —
  (a) `opening` leak: check `pending >= MAX_PENDING_REQUESTS` _before_
  `opening.add(name)`, or pass an `onRefuse` cleanup into `answer` (:203-228).
  (b) sync-throw leak: `void Promise.resolve().then(run).then(ok, fail)` (:150-166);
  wrap `options.hostContext?.()` calls (:237, :307-308) in try/catch.
  (c) rate limiting: token-bucket in `receive` (drop beyond N/window), dedupe
  `onViolation` (last-wins per code+name), count subscribe/unsubscribe churn toward
  the budget; short-circuit `jsonBytes` for `typeof data === "string"` (fixes F8).
  (d) open-subscription cap below the 64-declaration ceiling; debounce re-open of
  the same name (F9).
  (e) action args: strip/forbid `instanceId` keys in `t3.watch/action` arguments,
  symmetric with subscribe (F6).
  (f) **r9-F1 mitigations**: prelude gains a `pagehide`/`beforeunload` listener
  posting a "navigating" notice so the host disposes before the request completes
  (closes the deliver-spoof gap; cannot stop the request itself); rewrite the
  "zero network" claims (:32-34, :493) to disclose that frame self-navigation can
  carry data out and detection is post-mortem — **any prelude edit MUST bump
  `WATCH_APP_PRELUDE_SCRIPT_HASH` (:485), asserted by `watchAppPrelude.test.ts`;
  the generated document is shared by web and mobile so both surfaces pick it up.**
- `apps/web/src/components/watch/WatchAppFrame.tsx` — rebind fix (F5): watch the
  bound `connectorInstanceId()` value and `closeSubscription` all open feeds on
  change (or key `subscriptions` entries by `(name, instanceId)`); fix the
  :142-148 comment's navigation-enforcement framing.
- `packages/client-runtime/src/state/watchMounts.ts` — `requestMount` only mounts
  ids in `standbyIds`/tracked-visible (F7b); `promoteStandby` `unshift`s promoted
  standbys or unified recency list (r10-F4).
- Tests: `watchAppBridge.test.ts`, `watchMounts.test.ts`, `WatchAppFrame.test.tsx`.

**Validation**: `vp test run packages/client-runtime/src/watchAppBridge.test.ts
packages/client-runtime/src/state/watchMounts.test.ts
apps/web/src/components/watch/WatchAppFrame.test.tsx
apps/web/src/components/watch/watchAppPrelude.test.ts` ; typechecks
(client-runtime, web).

### P2-T11 · WidgetTranspileService — r8-F1/F2/F3/F4 (MEDIUM), r8-F5 (LOW), r9-F1 mitigation (c)

**Files** (2): `apps/server/src/watch/WidgetTranspileService.ts`, its test.

- `supported: { "dynamic-import": false }` in `widgetBuildOptions` (verifier
  confirmed: lowers `import(expr)` to a throwing `__require`); optionally fail the
  build on non-empty `result.warnings` or residual `import(`/`import.meta`/
  `__require` in output; fix the "imports of any kind are rejected" docstring.
- `esbuild.context()` inside `Effect.acquireRelease` with `ctx.cancel()` on
  interruption so `transpileTimeoutMs` bounds the work.
- Latch `unavailable` only for `loadEsbuild` failure / missing-binary signature
  (ENOENT on resolved `@esbuild/*`); other non-diagnostic rejections → `failed`.
- Artifact store bound: LRU/byte-cap eviction of `*.js`+`*.json` pairs
  (`get`/`publish` already tolerate missing files) + bound the `records` Map; wire
  `remove` to widget-source deletion so agent-published sources have a way out
  (reverse-states rule).
- Move the publish admission check after the ready-cache-hit early return
  (cache hits free); optionally key the budget per caller.
- r9-F1 mitigation (c): escape `</script` sequences in the emitted bundle (e.g.
  `<\/script`) **before** `scriptHash` is computed — removes the script-free
  meta-refresh exfil vector; hash chain stays consistent since hashing follows.

**Tests**: `import(globalThis.X)` → failed/throwing artifact; cancelled build calls
`ctx.cancel()`; transient error does not latch; eviction prunes oldest pairs;
`</script>` in source produces a working artifact with intact hash.
**Validation**: `vp test run apps/server/src/watch/WidgetTranspileService.test.ts` ;
`vp run --filter t3 typecheck`.

### P2-T12 · Contract unions + honest comments — r1-F4 (LOW), r1-F5/r3-F4 (LOW), r11-F1 doc (LOW), r11-F2 residual comment (LOW)

**Files** (≤4): `packages/contracts/src/watch.ts`, `packages/contracts/src/rpc.ts`,
`apps/server/src/mcp/toolkits/watch/tools.ts`, `packages/client-runtime/src/rpc/client.ts`
(audit only — `subscribeDynamicMapped`/`isUnknownUnionMember` handling).

- Wrap `WatchWidgetErrorState` in `ForwardCompatibleUnion(members, "cause")`;
  optionally both stream envelopes in `ForwardCompatibleUnion(members, "type")`;
  ensure client decode paths handle `UnknownUnionMember` (helper exists,
  `baseSchemas.ts:256`).
- Correct `WatchPage.revision` doc (:28-30): "guards layout and membership writes;
  rename/reorder are last-writer-wins (rename still bumps `revision`)".
- Reword `rpc.ts:2187-2191`, `:2239-2242`, `watch.ts:822`: minting is any
  operate-scope session; `allowLocalUrl` is caller-asserted; the enforced boundary
  is `environment:maintain` on consume + MCP absence.
- `tools.ts` comment on the prefs tool: history is the tamper-evident record;
  delivery suppression by agents is accepted (closes r11-F2's loop without code).

**Validation**: `vp run --filter @t3tools/contracts test` + typecheck; client-runtime
typecheck.

---

## Phase 3 — MEDIUM correctness

### P3-T13 · WatchPageService — r3-F1/F2/F3/F5 (MEDIUM), r3-F6 + r1-F3 + nit (LOW)

**Files** (2): `apps/server/src/watch/WatchPageService.ts`, its test.

- Reserved-key order minting: `reorder`/`duplicate`/`spreadOrderKeys` treat
  archived rows' keys as reserved — iterate `orderKeyBetween` past reserved keys
  like `planPinnedReorder` does (`threadSort.ts:274-298`).
- `moveToPage` self-move: early-return no-op (or delegate to single-page
  placement) when `sourcePageId === destinationPageId` (:1246-1265).
- `configureWidget` archived guard: check parent `archivedAt`, fail the archived
  `WatchPageError` (:1092-1099); extend the "Archived pages are immutable" test to
  cover config writes.
- `create`/`instantiateFromGallery`: move `lastOrderKey` read inside
  `sql.withTransaction` (`create` needs a transaction wrapper).
- `restore`: also bump `mobile_revision` (:854-861).
- `pack:` provenance: when supplied, verify `watch_pack_widget_sources` has a
  `(packId, sourceId)` matching the kind's `agent:<sourceId>`; reject
  `WatchPageError` otherwise (`ConnectorService.selectWidgetSourceRows` pattern).
- Nit: `placementInBounds` — add `x >= 0`/`y >= 0` (:226-230).

**Tests**: reorder/duplicate with interleaved archived keys don't collide; self-move
is a no-op; config write on archived page fails; concurrent creates get distinct
keys; restore invalidates stale `expectedMobileRevision`; forged `pack:` provenance
rejected.
**Validation**: `vp test run apps/server/src/watch/WatchPageService.test.ts` ; typecheck.

### P3-T14 · client-runtime command/state — r10-F2 (MEDIUM, latent fail-closed), r10-F3 doc (MEDIUM→doc)

**Files** (2): `packages/client-runtime/src/state/watch.ts`,
`packages/client-runtime/src/state/watchNotifications.ts`.

- `revisionCheckedCommand` (:66-98): build on `createEnvironmentRpcCommand` (its
  `execute` option runs inside the provided guard — `requestGuarded(tag, input)` +
  the conflict-flag catch fits there) — OR mirror the
  `Effect.provideService(RpcPermissionGuard, …)`; note the
  `no-rpc-permission-bypass` oxlint rule gates new install sites behind
  `allowGuardInstallation`. Fix the false "same permission wrapping" comment.
- `watchNotifications.ts` docblock (:26-32, :128): state the truth — the
  `Notification` `tag` is the device-wide dedupe; the delivered set is per-window
  bookkeeping; cross-window leader routing deferred (see Not fixing).

**Tests**: a grant-gated widget method passes the guard when granted (the latent
path — add one guarded method to the test harness scope map rather than shipping
a new gate).
**Validation**: `vp test run packages/client-runtime/src/state/` (watch tests) ;
`vp run --filter @t3tools/client-runtime typecheck` ; `vp lint` on the touched file
(the oxlint rule).

### P3-T15 · Web WatchScreen + forms + bus — r12-F1/F2/F3 (MEDIUM), r12-F4/r14-F8 (MEDIUM)

**Files** (4): `apps/web/src/components/watch/WatchScreen.tsx`,
`WatchWidgetBody.tsx`, `WatchWidgetSettingsForm.tsx`, `watchUiBus.ts`.

- Stale draft: `key={widget.revision}` on the form at both `WatchWidgetBody`
  render sites (:124-131, :162-169); consider a "changed elsewhere" hint when a
  remote change remounts over in-progress edits.
- Close-on-success: move `setConfiguringWidgetId(null)` (:621-629) into `.then`
  behind `AsyncResult.isSuccess` so conflicts/failures keep the draft.
- Failure visibility: extend `reportWatchWriteConflict` → `reportWatchWriteResult`
  — conflict keeps warning toast + banner; `WatchLayoutCollisionError`,
  `WatchPageError`, auth denials, transport failures get an error toast via
  `squashAtomCommandFailure` + `toastManager.add` (the `reportConnectorConfigFailure`
  pattern at :215-226); attach a result handler to page ops (`renamePage`,
  `deletePage`, `updatePageScope`, `reorderPage`, `duplicatePage`, `restorePage`).
- `watchUiBus` (:17-34): bound the queue — deliver-once scoped to the
  post-navigation mount (flush-then-drop on first listener) or TTL/last-wins; the
  `open-gallery`-after-`navigate` and `/pair`-redirect and unconditional
  registration (`WatchScreen.tsx:771`, before the `watchSupported` early return)
  vectors all fold into "pending survives failed navigation".

**Tests**: form remounts on remote config change; conflict keeps draft + toast;
non-conflict failure toasts; queued action expires/doesn't detonate on unrelated
mount.
**Validation**: `vp test run --project unit apps/web/src/components/watch/` ;
`vp run --filter @t3tools/web typecheck`.

### P3-T16 · Web notification surfaces — r14-F1..F7 (7 MEDIUMs)

**Files** (5): `apps/web/src/components/WatchNotificationCoordinator.tsx`,
`apps/web/src/components/watch/watchNotificationStore.ts`,
`apps/web/src/components/watch/WatchNotificationBell.tsx`,
`apps/web/src/components/sidebar/SidebarChrome.tsx`,
`apps/web/src/components/ThreadNotificationCoordinator.tsx` (same `close` gap —
cheap shared fix).

- F1: sweep `sessionChannels` + store `unread`/`thresholdAlerts`/`prefs` against
  `activeIds` unconditionally in the `environmentIds` effect (or a store
  `evictEnvironment`), not only envs with pending notifications.
- F2: accrue `unread` whenever `resolveWatchNotificationDelivery` returns a
  deliverable channel (badge = lowest-intrusion surface) — else reconcile
  `docs/user/watch-screen.md` to say badges need a surface enabled. Recommend the
  accrual fix; docs promise badges unconditionally.
- F3: add `hasNotificationSound(mode)` → `playNotificationSound` branch mirroring
  `ThreadNotificationCoordinator.tsx:167-171`, plus the audio-unlock listener
  effect; fixes "sound"-only mode dropping events entirely.
- F4: optimistic local write / pending-prefs merge in `updatePrefs` so consecutive
  toggles compose; disable toggles until first prefs echo. (Full `patchPrefs` RPC
  deferred.)
- F5: `SidebarChrome.tsx:201` — apply `activeEnvironmentId ?? primaryEnvironmentId`
  fallback; consider summing `unread` across envs for the sidebar badge.
- F6: gate `WatchEnvironmentNotifications` (esp. the label-only `connectorsLive`)
  on `serverConfig?.watchScreen === true` (`watchScreenSupportedAtom` pattern,
  `presentation.ts:214-219`).
- F7: `native.addEventListener("close", …)` removing the tag from `pending` and
  recomputing the badge — fix in both coordinators.

**Validation**: `vp test run --project unit apps/web/src/components/` (touched
tests) ; `vp run --filter @t3tools/web typecheck`.

### P3-T17 · Connector widgets + task starter — r13-F5 (MEDIUM), r13-F6 (MEDIUM)

**Files** (3): `apps/web/src/components/watch/widgets/WatchConnectorSecretDialog.tsx`,
`WatchConnectorStatusWidget.tsx`, `WatchTaskStarterWidget.tsx`.

- F5: per-key "clear" affordance beside `configuredSecretKeys` entries →
  `setInstanceConfig` with `clearSecretKeys` (server already honors it); closes the
  one-way door on stored credentials.
- F6: when `envModeMayBeWorktree`, disable Start while `gitStatusQuery.isPending`
  (or `await` status inside `onStart`); optionally mirror the composer's session
  `isRepo` memory for warm revisits.

**Validation**: `vp test run --project unit apps/web/src/components/watch/` ;
`vp run --filter @t3tools/web typecheck`.

### P3-T18 · Mobile WebView lifecycle — r15-F1 (MEDIUM), r15-F2 (MEDIUM) + nits

**Files** (2): `apps/mobile/src/features/watch/WatchAppWebView.tsx`,
`WatchAppWebView.test.tsx`.

- Load-count enforcement (web parity): ref incremented per `onLoadStart`/
  `onLoadEnd`, reset alongside `setSessionDocument` (:138-144); on any second
  main-frame load → `stopSession()` + `onViolation({code:"navigatedAway"})`. Also
  add the missing `onViolation` call to the existing `stopIfNavigated` path.
  Optionally tighten the JS gate to permit `about:blank` only until first load —
  but the load counter is the real enforcement (covers `location.reload()`).
- `stopSession()`: `hostRef.current?.dispose()` (rides `closeName` teardown) +
  `setHost(null)`; call from all four terminal handlers
  (`onContentProcessDidTerminate`, `onRenderProcessGone`, `onError`,
  `onHttpError`) before `setCrashed(true)`; reuse inside `stopIfNavigated`; gate
  the feed block on `!crashed && !navigatedAway`.
- Nits: soften the "Desktop placement is never read" comment
  (`WatchScreen.tsx:74` vs `mobileWidgetHeight` reading `placement.h`).

**Tests**: second `onNavigationStateChange`/`onLoadStart` closes subscriptions;
each crash handler disposes the host.
**Validation**: `vp run --filter @t3tools/mobile test` (or
`vp test run --config ../../vite.config.ts --dir .` from `apps/mobile`) ;
`vp run --filter @t3tools/mobile typecheck`.

---

## Not fixing / deferred / documented residuals

**Residuals accepted with documentation (fixes ship only mitigations):**

- **r9-F1 web self-navigation exfil (HIGH→mitigated)**: no web-platform primitive
  blocks self-navigation in a srcdoc iframe (`navigate-to` dead; sandbox tokens
  gate only top-navigation). Shipped: prelude `pagehide` notice (P1 boundary for
  host dispose), `</script>` bundle escaping, honest comments in
  `watchAppBridge.ts`/`WatchAppFrame.tsx`. Residual: data in `deliver`/`hostContext`
  is exfiltratable to an arbitrary origin on web; mobile's deny-all load gate does
  not have this hole. Keep secrets out of widget-visible data — documented in the
  bridge header comment.
- **r6-F5 roots remain agent-writable**: denylist + byte cap ship in P2-T9; a
  human-confirm gate for `watch.roots` changes is a product/design decision —
  deferred, docstring states it.
- **r11-F1 scope raise**: operate scope for prepare RPCs is deliberate
  (PLAN.md:367-370); comment honesty fix ships in P2-T12. Optional hardening —
  scoping both prepare RPCs to `environment:maintain` — left to maintainers
  (safe: standard clients already hold maintain).
- **r6 realPath→stat→read TOCTOU + materializeBundle symlink-follow**: require
  local FS-write inside the watched tree; `O_NOFOLLOW` bundled into P2-T9…(T2) as
  stretch; TOCTOU documented, not fixed.

**Deferred (real but below the bar for this pass):**

- r10-F3 cross-window leader for native delivery (docblock corrected instead).
- r14-F4 `patchPrefs` RPC (proper atomic prefs); optimistic buffer suffices for now.
- r4-F3 full dead-letter table vs. in-column attempt count — implement whichever
  is cheaper; the wedge fix is the requirement.
- r5 minor: `confirmUpgrade` orphaned materialized dir when instance vanished;
  pending request wedged by post-request DNS rebind — rare, self-consistent states.
- r8 note: `artifactHash` lacks compiler-version salt (cosmetic).
- r7-F2 cross-restart threshold dedupe (needs persisted latch) — resubscribe
  churn fixed; one re-alert per restart accepted.

**Dropped (verified non-defects or self-inflicted-only):**

- r9-F7a registryKey stranding — REJECTED (unreachable precondition; widget ids
  can't survive a page/env key change). Optionally a comment note in P2-T10.
- `packDirName` `a/b`↔`a_b` collision — becomes moot if charset validation
  rejects `/` (it does); residual collision between e.g. `a:b`→`a_b` noted, not
  worth hashing the dir.
- `secretStoreName` key collisions — pack-declared keys only, self-inflicted.
- `isLocalAddress` ISATAP extraction — needs local ISATAP routing.
- `ctx.files` aggregate cap (~128MB worst-case bound, not unbounded).
- `placementInBounds`/`firstFreePlacement` input nits — only the server-side
  `x >= 0`/`y >= 0` line lands (P3-T13); client-side nit unreachable.
- r15 edit affordance on fully-hidden pages — cosmetic.
- Scratch files `apps/server/scripts/seed-install-request.ts` /
  `.plans/welcome-screen/seed-install-request.ts` — **do not exist; no cleanup needed.**

## Sequencing notes

- `ConnectorService.ts` is touched by P1-T1, P1-T3, P1-T4 — assign to one fixer
  or run strictly sequentially (T4 → T1 → T3 ideal: secrets removal shrinks the
  worker ctx; confirm-path integrity is independent).
- `ConnectorPoller.ts` touched by P1-T5 then P2-T8 — sequential, same file.
- `watch.ts` (contracts) touched by P1-T3 (one error literal), P2-T8, P2-T12 —
  additive changes, still sequence to avoid churn.
- Prelude edit in P2-T10 **must** bump `WATCH_APP_PRELUDE_SCRIPT_HASH`
  (`watchAppBridge.ts:485`); `watchAppPrelude.test.ts` asserts it. The document is
  shared web+mobile — no separate mobile change needed.
- Mobile (P3-T18) is independent; bridge changes in P2-T10 apply to both surfaces
  via the shared host — re-run `WatchAppWebView.test.tsx` after bridge edits.

## Validation cheat-sheet

- Targeted tests: `vp test run <file…>` (root vitest config covers server,
  client-runtime, web `--project unit`); contracts/mobile need their package
  scripts: `vp run --filter @t3tools/contracts test`, `vp run --filter @t3tools/mobile test`.
- Typecheck per package: `vp run --filter t3 typecheck` (server),
  `@t3tools/contracts`, `@t3tools/client-runtime`, `@t3tools/web`, `@t3tools/mobile`.
- Lint touched files: `vp lint --report-unused-disable-directives` (mind the
  `no-rpc-permission-bypass` rule for P3-T14).
- Do NOT run repo-wide `vp check`/`vp run -r test` — CI owns the full suite.
- Server tests: drain `OrchestrationEffectWorkerV2` / await persisted milestones —
  never sleep/poll.
