# Verify — review-report-10 (client-runtime watch state)

## Terse summary

| #   | Sev    | Verdict         | Note                                                                                                                                                         |
| --- | ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | HIGH   | VERIFIED-DEFECT | **DUPLICATE of review-report-13 Finding 1** — same file/lines, same omitted fields. Merge the fixes (r13 also catches operation-`description` invisibility). |
| 2   | MEDIUM | VERIFIED-DEFECT | Latent fail-closed; the "same permission wrapping" comment is false. Safe today only because no `watchWidgets*` method is grant-gated.                       |
| 3   | MEDIUM | VERIFIED-DEFECT | "One delivery per device" is PLAN-intended but unenforced; real dedupe is the `Notification` tag. Badge count is last-writer-wins across windows.            |
| 4   | MEDIUM | VERIFIED-DEFECT | Promoted standbys seat at the LRU tail despite being still-visible; `requestMount` seats front — internally inconsistent, flicker loop is reachable.         |

Counts: 4 VERIFIED-DEFECT / 0 VERIFIED-INTENTIONAL / 0 REJECTED.

## Finding 1 — VERIFIED-DEFECT (DUPLICATE of r13-f1)

All evidence checks out:

- Manifest carries `authSchema` (`contracts/src/watch.ts:439`) and `widgets` (`:447`), each widget with `bridge.subscriptions`/`bridge.actions` (`:402-428`) — "the only data subscriptions and actions the frame may use".
- `diffWatchConnectorManifests` (`packages/client-runtime/src/state/watchConnectors.ts:49-67`) diffs only `schemaVersion`, `transport`, `egressHosts`, `secretKeys`, operation **names**. Omissions confirmed: `widgets` (incl. per-widget bridge), `authSchema`, operation `description`.
- Bridge grants are the enforced sandbox surface: `watchAppBridge.ts:182` refuses undeclared subscriptions, `:259` refuses undeclared actions. `ConnectorService.registerPackWidgets` (`apps/server/src/watch/connectors/ConnectorService.ts:1002-1034`, `publishTrusted({source, manifest: widget.bridge})` at :1020-1021) runs inside the shared confirm path at `:1350` — **upgrades do re-publish pack widget code and bridge grants**.
- `ManifestDiffRows` (`apps/web/src/components/watch/WatchConnectorInstallConfirmDialog.tsx:91-146`) renders only this diff under "Changes"; `ConfirmBody` (:193-220) shows only full `egressHosts`/`secretKeys` lists — `manifest.widgets` and `authSchema` appear nowhere on either install or upgrade legs.
- Nuance on the "No manifest changes." claim: the confirm path rejects `schemaVersion <= approvedMax` (`ConnectorService.ts:1385-1390`), so a real upgrade always shows at least `schemaVersion N → M`; the literal empty state needs a same-version diff (e.g. re-request of an approved version). Report-13 phrases this more accurately ("renders as only `schemaVersion N → M`"). The defect is identical either way.
- **Duplicate**: review-report-13 Finding 1 covers the same root cause and fix; it additionally flags operation-`description` diffs and (separately, as its Finding 2) the missing install-leg surface listing. Track once, fix once.

Fix direction (as reported, merged with r13): extend `WatchConnectorManifestDiff` with a `widgets` group (added/removed names; per-widget `bridge.subscriptions`/`bridge.actions` deltas on same-name matches; `file` moves flagged) plus an `authSchema` changed marker (deep-equal suffices) and operation `description` deltas; at minimum emit a generic "manifest surface changed" row so the dialog can never show nothing/zero rows when the approved surface moved.

## Finding 2 — VERIFIED-DEFECT (latent, fail-closed)

- `revisionCheckedCommand` (`state/watch.ts:66-98`) runs `permissions.authorize` then `requestGuarded` with no `Effect.provideService(RpcPermissionGuard, ...)` — comment at :70-71 ("Same permission wrapping as `createEnvironmentRpcCommand`") is wrong.
- `createEnvironmentRpcCommand` installs the guard at `runtime.ts:832-835` (`authorize` → `createCommandPermissions(runtime, method).authorize(registry, id, payload)`); the provide wraps the whole pipe including a custom `execute` (:830-838). The only other install site is `vcsAction.ts:511-514`; tests aside, no app layer provides it.
- `requestGuarded` → `authorizeRequest` (`rpc/client.ts:184-191`) consults the guard whenever `clientRpcRequiredScopes` is non-empty; the `Context.Reference` default (:169-182) _denies_ every scoped method.
- `CLIENT_GUARDED_RPC_SCOPES` (`packages/contracts/src/clientRpcPermissions.ts:14-59`) contains `watchConnectorsConfirmInstall`/`ConfirmUpgrade`/`PurgeInstanceData` but none of the six wrapped widget methods (`watchWidgets{Add,Remove,Configure,SetLayout,SetMobileProjection,MoveToPage}`) — so `authorizeRequest` early-returns today: latent, not live.
- Consequence verified: the day any of the six is grant-gated, the outer `permissions.authorize` passes for granted sessions (and `permissionAtom` shows granted) but the default guard then denies unconditionally — silent fail-closed with no UI signal.
- Fix direction: build the wrapper on `createEnvironmentRpcCommand` (its `execute` option runs inside the provided guard — `requestGuarded(tag, input)` + the conflict-flag catch fits there), or mirror the `provideService` — noting `oxlint-plugin-t3code/rules/no-rpc-permission-bypass.ts` gates new install sites behind the `allowGuardInstallation` permit.

## Finding 3 — VERIFIED-DEFECT

- Intent is explicit: PLAN.md:304-309 — "the desktop-native channel is a singleton per device — …counts once even if multiple windows exist"; test goal at PLAN.md:333-336 "desktop-native singleton = one delivery per device". The docblock (`watchNotifications.ts:27-28`) claims the `DESKTOP_NATIVE_CHANNEL` singleton delivers it.
- Mechanism does not: `resolveWatchNotificationDelivery` only checks a caller-supplied `nativeDelivered` set (:161-169), and `sessionChannelFor` (`WatchNotificationCoordinator.tsx:61-72`) mints a fresh `nativeDelivered: new Set()` in each window's own module state (:59 `sessionChannels` map is per-JS-context). Two unattended windows both pass `shouldDeliverWatchNotification` and both construct a `Notification` (:323).
- Actual suppression is `tag: \`watch:${environmentId}:${notificationId}\``(:325) — platform tag-replace, not the delivered set. Mitigating detail the report underplays:`silent: true`(:326) is set, and`watchNotifications.ts:128`does acknowledge "deduped device-wide by the native`tag`" — so the file contradicts itself (singleton claimed at :27-28, tag admitted at :128). Residual real issues stand: tag-replace is not alert-free on all platforms (Linux/Electron variance), a replaced notification drops the first instance's click handler (:329-333), and the dock badge is per-window last-writer-wins (`pending`map :87-89 →`setNotificationBadgeForSource` :94/:109).
- Fix direction: either route native delivery through a cross-window leader (desktop main / BroadcastChannel) so one `Notification` is constructed, or correct the docblock to state the `tag` is the dedupe and the delivered set is only per-window bookkeeping. MEDIUM severity is fair — the common-case behavior approximately works via `tag`, the guarantee and bookkeeping do not.

## Finding 4 — VERIFIED-DEFECT

- `promoteStandby` (`watchMounts.ts:65-73`) does `mountedIds.push(id)` — the LRU tail — with comment "it was the least recently visible before" (:69). `evictOverLimit` pops that same tail (:47-54).
- The standby path in `setVisible` (:90-98) unshifts a re-reporting standby to the standby front — its recency is recorded _within_ standby but discarded on promotion.
- Verified asymmetry: `requestMount` (user tap, :119-128) seats via `mount()` → `unshift` → freshest seat (test at `watchMounts.test.ts:159-170` documents "takes the freshest seat"). Auto-promotion of an equally still-visible widget seats stalest. Every standby entry is still-visible — `setHidden` removes standby entries (:112-116) — so "least recently visible" is never established for them.
- Observer side confirms re-reports happen: `WatchAppWidget.tsx:123-136` puts the `IntersectionObserver` on the persistent wrapper ("the registry hears every enter/leave regardless of mount state"); `useWatchAppMounts.ts:77-84` forwards every entry.
- Reachable loop: with >6 visible agent widgets, promote → tail → next mount evicts it again → placeholder → re-report → standby front → promote → evict. Scroll jitter produces the repeated `setHidden`/mount events the cycle needs. Each bounce remounts an iframe — the flicker cost is real, not just ordering drift.
- Fix direction: track last-visible recency across both lists and seat a promoted standby where its last report implies (single recency list + mounted flag, or timestamped entries). Cheaper approximation: `unshift` promoted standbys — all standbys are still-visible by construction, so front is defensible — but the report's unified-recency suggestion is the accurate fix.
