# Verify — review-report-13 (web connector UI + widgets)

## Terse summary

| #   | Sev    | Verdict         | Note                                                                                                                                                                                                   |
| --- | ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | HIGH   | VERIFIED-DEFECT | **DUPLICATE of review-report-10 Finding 1** (itself VERIFIED-DEFECT). Same diff fn, same omitted surface; r13 adds operation-`description`. Fix once.                                                  |
| 2   | MEDIUM | VERIFIED-DEFECT | Confirmed, but note: DESIGN/PLAN deliberately scoped the dialog's "permissions list" to egress+secrets — this is a design-scope gap vs the gate's purpose, not an implementation slip.                 |
| 3   | MEDIUM | VERIFIED-DEFECT | Post-fetch ack is structurally dead: `prepareInstallConfirm` never notifies, `needsLocalFetchAck` never clears, `confirmDisabled`'s reviewed-gate unreachable on localUrl leg.                         |
| 4   | MEDIUM | VERIFIED-DEFECT | Notify exclusion is deliberate + documented; the defect is presenting the frozen timestamp as a liveness label. Mobile affected identically.                                                           |
| 5   | MEDIUM | VERIFIED-DEFECT | `clearSecretKeys` honored server-side, zero client senders anywhere (web or mobile). One-way door.                                                                                                     |
| 6   | MEDIUM | VERIFIED-DEFECT | Pending `vcsEnvironment.status` → `isRepo:false` → `"local"`, no pending gate on Start/Enter. Composer defaults unknown to `true`; widget pessimistically defaults to `false` — silent isolation loss. |

Counts: 6 VERIFIED-DEFECT / 0 VERIFIED-INTENTIONAL / 0 REJECTED. (F1 folds into r10-f1 for fixing.)

## Finding 1 — VERIFIED-DEFECT (DUPLICATE of r10-f1; merge)

All claims re-verified:

- `diffWatchConnectorManifests` (`packages/client-runtime/src/state/watchConnectors.ts:49-67`) diffs only `schemaVersion`, `transport`, `egressHosts`, `secretKeys`, operation names — confirmed verbatim.
- Manifest carries `authSchema` (optional, `contracts/src/watch.ts:439`) and `widgets` (`:447`), each widget with `bridge.subscriptions`/`bridge.actions` (`:415-428`, "the only data subscriptions and actions the frame may use").
- Bridge is the enforced surface: undeclared subscriptions refused at `packages/client-runtime/src/watchAppBridge.ts:178-180`, undeclared actions at `:259-261`. `registerPackWidgets` publishes `widget.bridge` via `publishTrusted` (`ConnectorService.ts:1021`) and runs inside the shared confirm path (`:1350`) — upgrades re-publish executable widget code and bridge grants.
- `ManifestDiffRows` (`WatchConnectorInstallConfirmDialog.tsx:91-146`) renders only this diff under "Changes"; widgets/authSchema/operation descriptions appear nowhere.
- Nuance (same as r10): `downgradeRejected` at `ConnectorService.ts:1233-1242` forces `schemaVersion` to advance on real upgrades, so the diff can never be literally empty — it renders as only `schemaVersion N → M`. r13 phrased this correctly.
- Fix direction (merged with r10-f1): extend `WatchConnectorManifestDiff` with a `widgets` group (added/removed names, per-widget `bridge.subscriptions`/`bridge.actions` deltas on same-name matches, `file` moves flagged) + an `authSchema` changed marker (deep-equal) + operation `description` deltas; at minimum a generic "manifest surface changed" row so a real surface move never renders as a bare version bump.

## Finding 2 — VERIFIED-DEFECT (design-scope gap, not implementation slip)

- `ConfirmBody` (`WatchConnectorInstallConfirmDialog.tsx:193-220`) renders exactly two `PermissionGroup`s — egress and secrets. `manifest.operations` and `manifest.widgets` appear nowhere on install or null-diffBase upgrade legs. Confirmed.
- The contract frames the manifest as "the pack contract a human confirms at install: declared operations, declared egress hosts, declared secret keys, and the transport" (`watch.ts:431-434`) — two of the four listed surface items are invisible.
- **Mitigating intent**: the design docs scoped this deliberately — DESIGN.md:389-401 defines the "permissions list" as exactly egress + secrets ("the load-bearing element"), and PLAN.md:655 specifies the dialog as "egress hosts, secret keys, origin, hash; upgrade diff". Operations/widgets were never specced into the review surface. So the omission matches plan — but pack-bundled widgets (executable code + bridge grants) landing invisibly is still a gap in the human gate's stated purpose, and this compounds F1.
- Fix direction: as reported — add operation rows (name + `description`) and a bundled-widgets section (name + bridge summary) to `ConfirmBody` on both legs. Cheap: the data is already in `manifest`.

## Finding 3 — VERIFIED-DEFECT

Confirmed end-to-end:

- `prepareInstallConfirm` (`ConnectorService.ts:1246-1264`) UPDATEs the request row with the fetched manifest and mutates the in-memory `row` for the return value — **no `notifyChanged` anywhere in 1202-1281**. `subscribeList` (693-704) re-pushes only on PubSub events, so `props.request.manifest` stays `null` for the dialog session.
- `needsLocalFetchAck` (dialog :236) is computed from `props.request`, not `shownRequest` — stays `true` forever. `confirmDisabled` (:354-358) gates on `needsReviewAck && !needsLocalFetchAck && !reviewed` → the `reviewed` term is unreachable on the localUrl leg (dead code).
- Checkbox label flips to "I reviewed what this pack can reach" once `prepared` is set (:388-390), but `reviewed` remains `true` from the pre-fetch ack (required to enable "Fetch and review" at :433) — and unchecking it does not disable Confirm.
- Extra wrinkle the report implies but worth stating: even if the row _did_ refresh and `needsLocalFetchAck` cleared, `reviewed` would still be `true` — the second ack can never be a fresh act without resetting `reviewed` when `prepared` arrives. The `confirmDisabled` expression's shape (`!needsLocalFetchAck`) shows the post-fetch gate was designed in and then never wired.
- Bounded: the fetched manifest is displayed (`shownRequest` at :353 uses `prepared.request`, which carries the populated manifest) and Confirm is an explicit click. MEDIUM is fair.
- Fix direction: as reported — recompute `needsLocalFetchAck` from `shownRequest` **and** reset `reviewed=false` when `prepared` lands for a localUrl request (both halves needed; either alone leaves the gate decorative). Optionally also `notifyChanged` after the row update so other clients see the request as fetched.

## Finding 4 — VERIFIED-DEFECT (deliberate mechanism, defective presentation)

- The exclusion is deliberate and documented: `healthChanged` (`ConnectorService.ts:910-926`) comment — "`lastFetchAt` ticks on every poll run, so it is excluded — notifying on it would re-push the full list to every subscriber on every tick." Correct call for notify cost.
- The defect: the widget renders `health.lastFetchAt` as the row's only liveness signal ("last fetch {label}", `WatchConnectorStatusWidget.tsx:125-126, 293`), and `subscribeList` only re-pushes on notify. A healthy instance producing no health-field deltas keeps a frozen timestamp indefinitely — `useNowMinute` re-renders the label against the same stale value. Failure polls incidentally refresh it (consecutiveFailures increments → notify), so staleness strikes precisely the healthy case.
- Neither the comment nor the plan docs acknowledge the label will freeze — PLAN.md:644/PRD:233 spec "last fetch" as a status-widget element, implying it should be meaningful. The mechanism is intentional; displaying the frozen field as live liveness is not — that's the defect.
- **Cross-surface**: mobile renders the same frozen field (`apps/mobile/src/features/watch/WatchWidgetBody.tsx:502-504`, `relativeTime(instance.health.lastFetchAt)`).
- Fix direction: pick one — (a) drop/relabel the readout (e.g. rely on the health badge + last _notified_ event time), (b) coarsen: re-push on `lastFetchAt` only when it crosses a bucket boundary (e.g. >15min drift), or (c) ship a cheap per-instance `lastFetchAt` field on a lightweight subscription. (b) preserves the churn-avoidance intent while bounding staleness.

## Finding 5 — VERIFIED-DEFECT

- `clearSecretKeys` exists on the wire (`contracts/src/watch.ts:704`) and is honored server-side (`ConnectorService.ts:824-836` — `removeSecrets` + `secret_keys_json` rewrite).
- Repo-wide grep: **zero** client-side references — web dialog (`WatchConnectorSecretDialog.tsx:74-80`) drops empty fields, `run()` (`WatchConnectorStatusWidget.tsx:139-166`) never sends it, and mobile's connector body is read-only (no secrets UI at all, `WatchWidgetBody.tsx:447-528`).
- Only out: `deleteInstance` calls `removeSecrets` for all configured keys (:790) — i.e., a stored credential persists until instance deletion, exactly as reported. One-way door for a sensitive value.
- Fix direction: per-key clear affordance beside keys in `configuredSecretKeys` mapping to `clearSecretKeys` on `setInstanceConfig`. Server already supports it — pure client work.

## Finding 6 — VERIFIED-DEFECT

- `envModeMayBeWorktree` (`WatchTaskStarterWidget.tsx:121-131`) subscribes `vcsEnvironment.status({environmentId, input:{cwd}})`; the atom family is keyed by `JSON.stringify([environmentId, input])` (`runtime.ts:447-454, 652-670`) with an idle TTL — switching projects or a cold cache starts pending.
- While pending, `gitStatusQuery.data` is `null` → `isRepo === true` is false → `resolveSendEnvMode` returns `"local"` (`ChatView.logic.ts:818-823`). `canStart` (:133-134) has no pending gate; Enter (:305-310) hits `onStart` directly.
- Comparative evidence strengthens it: the composer treats unknown as repo — `isGitRepo = liveIsGitRepo ?? recallCheckoutIsRepo(...) ?? true` (`ChatView.tsx:4266-4272`) plus a session `isRepo` memory (`ChatView.logic.ts:966-991`). The widget does the opposite: pessimistic `=== true` → silent downgrade to `"local"`, no `baseBranch` guard, no user signal. Worst-case direction for a workspace-isolation feature.
- Fix direction: as reported — when `envModeMayBeWorktree`, disable Start while `gitStatusQuery.isPending` (or `await` a fresh status inside `onStart`). Optionally mirror the composer's session `isRepo` memory to skip the gate on warm revisits.
