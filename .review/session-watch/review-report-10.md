# Cluster 10 review — client-runtime watch state (feat/watch-screen)

Scope: `packages/client-runtime/src/state/{watch,watchPages,watchWidgets,watchConnectors,watchNotifications,watchMounts}.ts`, watch tags in `rpc/client.ts`, `watchScreenSupportedAtom` in `presentation.ts`. Server semantics cross-checked against `apps/server/src/watch/WatchPageService.ts`, `apps/server/src/notifications/UserNotificationService.ts`, `apps/server/src/watch/connectors/ConnectorService.ts`, and contracts (`packages/contracts/src/watch.ts`, `clientRpcPermissions.ts`).

## Findings

### [SEVERITY: HIGH] Finding 1: manifest diff omits `widgets`/`bridge` and `authSchema` — a capability-adding upgrade renders "No manifest changes."

**File**: `packages/client-runtime/src/state/watchConnectors.ts:49-67`
**Problem**: `diffWatchConnectorManifests` only diffs `schemaVersion`, `transport`, `egressHosts`, `secretKeys`, and operation _names_. It never diffs `manifest.widgets` (each carrying `bridge.subscriptions`/`bridge.actions`) or `authSchema`.
**Evidence**: `widgets[].bridge` is the enforced sandbox grant — `watchAppBridge.ts:259` refuses undeclared actions (`manifest.actions.includes(name)`), and `ConnectorService.registerPackWidgets` (`ConnectorService.ts:1020-1021`) publishes each widget's `bridge` as its trusted manifest. The confirm dialog (`apps/web/src/components/watch/WatchConnectorInstallConfirmDialog.tsx:95-128`) renders _only_ this diff under "Changes" — it never lists `manifest.widgets` anywhere (only `egressHosts`/`secretKeys` full lists are shown). So an upgrade that adds a widget source, or widens `bridge.actions`/`bridge.subscriptions`, or rewrites `authSchema`, produces zero diff rows and the literal text "No manifest changes."
**Impact**: The human-confirm gate — the sole agent-unreachable approval step for running pack code — affirmatively reports nothing changed while new executable widget code and a wider host-action surface land in T3 home. This is exactly the "misleading diff in the confirm dialog" class of security-UI defect.
**Suggestion**: Extend `WatchConnectorManifestDiff` with a `widgets` list diff (keyed by `name` or `file`, and on a same-key match, diff `bridge.subscriptions`/`bridge.actions` and flag `file` moves) plus an `authSchema` changed-marker (deep-equal or key-set diff). At minimum, treat any `widgets`/`authSchema` change as a generic "manifest surface changed" row so the dialog can never say "No manifest changes" when the approved surface moved.

### [SEVERITY: MEDIUM] Finding 2: `revisionCheckedCommand` drops the `RpcPermissionGuard` install — comment claims identical wrapping

**File**: `packages/client-runtime/src/state/watch.ts:73-92`
**Problem**: The custom `execute` calls `permissions.authorize` then `requestGuarded`, but never installs the session-aware `RpcPermissionGuard` that `createEnvironmentRpcCommand` provides at `runtime.ts:832-835` (`authorize` delegating to `createCommandPermissions(runtime, method)`). Its own comment claims "Same permission wrapping as `createEnvironmentRpcCommand`" — it is not the same.
**Evidence**: `requestGuarded` → `authorizeRequest` (`rpc/client.ts:184-191`) consults `RpcPermissionGuard` whenever `clientRpcRequiredScopes` is non-empty; the `Context.Reference` default (lines 169-182) _denies_ every scoped method. No app layer provides another value (only `runtime.ts:832` and `vcsAction.ts:511` install it).
**Impact**: Latent, fail-closed. Today all six wrapped methods (`watchWidgets.add/remove/configure/setLayout/setMobileProjection/moveToPage`) are absent from `CLIENT_GUARDED_RPC_SCOPES`, so `authorizeRequest` early-returns and nothing breaks. The day any of them is granted-gated (plausible — they are agent-reachable mutations), the commands are unconditionally denied regardless of grants, with no signal at the permission-atom level.
**Suggestion**: Pipe `Effect.provideService(RpcPermissionGuard, { authorize: (id, method, payload) => createCommandPermissions(runtime, method).authorize(registry, id, payload) })` around the `requestGuarded` leg, mirroring `createEnvironmentRpcCommand`, or build the wrapper on top of it.

### [SEVERITY: MEDIUM] Finding 3: desktop-native "one delivery per device" is claimed by the channel id but not enforced by the delivered set

**File**: `packages/client-runtime/src/state/watchNotifications.ts:26-32, 113-171`
**Problem**: The docblock states the `DESKTOP_NATIVE_CHANNEL` singleton makes "a device fire once even when several windows exist." But `resolveWatchNotificationDelivery` only checks a caller-supplied `deliveredKeys` set, and the sole consumer keeps that set per window: `sessionChannelFor` (`apps/web/src/components/WatchNotificationCoordinator.tsx:59-72`) gives every window its own `nativeDelivered` `Set`. Two unattended windows each pass `shouldDeliverWatchNotification` for the same `notificationId` and each constructs a `Notification`.
**Evidence**: Actual cross-window suppression comes only from `tag: \`watch:${environmentId}:${notificationId}\``(coordinator line 325) — the platform replaces a same-tag notification rather than suppressing a second delivery. Replacement is not guaranteed alert-free (Linux/Electron paths can re-alert, and a replaced notification drops the first instance's click handler).
**Impact**: Worst case a duplicate device notification for one event; best case a silent replace that rebadges. Either way the documented per-device dedupe guarantee lives in an unstated dependency on`Notification.tag`semantics, and the`(notificationId, channel)` keying does nothing across windows. Badge counts (`pending`map) are likewise per-window, so the dock badge is last-writer-wins across windows.
**Suggestion**: Either document that the singleton's real dedupe is the notification`tag`(and remove the implication the delivered-set enforces it), or share native-delivery state — e.g. route native notifications through the desktop main process / a BroadcastChannel-owned leader so only one window constructs the`Notification`.

### [SEVERITY: MEDIUM] Finding 4: `promoteStandby` seats the freshest standby at the LRU tail, inverting recency for re-reported widgets

**File**: `packages/client-runtime/src/state/watchMounts.ts:65-73` (with `setVisible` standby path at 90-98)
**Problem**: A widget evicted to `standbyIds` can re-report `setVisible` while `mountedIds` is full — it is moved to the standby front (freshest waiting), but its recency over the mounted entries is never recorded. When a seat frees, `promoteStandby` does `mountedIds.push(id)` — the LRU tail — so the just-reported (most recently visible) widget is ordered _oldest_, and the very next overflow evicts it again ahead of genuinely staler mounted widgets.
**Evidence**: `evictOverLimit` pops `mountedIds` tail; `promoteStandby` pushes promoted ids to the same tail with the comment "it was the least recently visible before" — true only for standbys that never re-reported.
**Impact**: A still-visible widget can flip mounted → placeholder → mounted → placeholder (flicker under scroll jitter / IO re-fires), and the effective LRU order no longer matches last-visible order. Cap enforcement and stale-entry cleanup (`remove` on widget delete) are otherwise correct.
**Suggestion**: Track last-visible order across both lists (e.g. promote to the position its last `setVisible` implies, or keep a single recency list with a mounted flag) so a re-reported standby isn't demoted behind entries it outranks.

## Verified clean (no findings)

- **Grid math vs server**: `watchPlacementsOverlap` ≡ `placementsOverlap`; `watchPlacementFits` ≡ `placementInBounds` modulo schema guarantees (client's `x/y >= 0` mirrors `NonNegativeInt`; server's `minCols >= 1` mirrors `PositiveInt`; both enforce `w>=1`, `x+w<=12`, `minCols<=w`). `firstFreePlacement` clamps `w`/`minCols` to `columns`, scans to `bottom` inclusive — can't emit overflow. `watchMoveCandidate`/`watchResizeCandidate` produce in-grid candidates; `handleCommitLayout`/`handleKeyboardAdjust` re-check `watchPlacementFits` before any `setLayout` write.
- **Mobile projection writes**: `buildWatchWidgetSetMobileProjectionInput` emits only `{pageId, expectedMobileRevision, widgets: [{widgetId, mobileOrder, mobileHidden}]}` — layout fields are structurally unreachable; move skips `mobileHidden` and (kill-switch-off) `agent:` widgets, matching `watchMobileVisibleWidgets`/`moveState`. Renumber/patch-only-changed is consistent with the server's verbatim apply.
- **Revision contract**: add/remove/configure/setLayout/setMobileProjection/moveToPage builders embed the right `expectedRevision`/`expectedMobileRevision`/both-page revisions matching `bumpPageRevision`/`bumpMobileRevision`; conflicts flag `needsReload` per (env, pageId) and re-fail — no silent retry/drop.
- **Subscription keys**: `environmentRpcKey` = `JSON.stringify([environmentId, input])` — per-environment, parameterized; `client.ts` diff vs base `3feae3a9` is exactly the five new `EnvironmentSubscriptionRpcTag` members. `idleTtlMs` bounds idle atoms.
- **`watchScreenSupportedAtom`**: `.some(env => serverConfig?.watchScreen === true)` matches the `pullRequestsSupportedAtom` convention and per-screen re-checks (`WatchScreen.tsx:415`, mobile `watchScreenSupported`) gate the actual surface.
- **`isWatchPageRevisionConflict`** / notification prefs predicates / `watchWidgets.ts` readers/error table: sound; `notificationPageId` page-mute scoping is intentional per comment.

## Minor observations (below finding bar)

- `sessionChannels` entry for a removed environment is only deleted when it has a pending native notification (`WatchNotificationCoordinator.tsx:99-111`); otherwise the channel id + dedupe sets linger — tiny, arguably intentional for re-added environments.
- `firstFreePlacement` accepts `w <= 0`/`h <= 0` sizes and emits an invalid placement the server would reject; all current callers pass spec defaults or server-validated placements.
- `useWatchAppMounts` leaves `"unmounted"` tombstones in `states` for removed ids; harmless.
