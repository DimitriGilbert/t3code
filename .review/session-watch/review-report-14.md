# Review — Cluster 14: Web notifications + app-shell integration (feat/watch-screen)

Scope: `apps/web/src/components/WatchNotificationCoordinator.tsx`, `apps/web/src/components/watch/WatchNotificationBell.tsx`, `watchNotificationStore.ts`, `notificationIcons.tsx`, watch diffs in `threadNotifications.ts`, `CommandPalette.tsx`, `sidebar/SidebarChrome.tsx`, `mainAppLocation.ts`, `routes/watch.tsx`, `routes/__root.tsx`, `state/environments.ts`. Cross-checked `packages/client-runtime/src/state/watchNotifications.ts`, `packages/client-runtime/src/state/presentation.ts`, `packages/shared/src/keybindings.ts`, and `apps/server/src/notifications/UserNotificationService.ts`.

Verified clean: subscription lifecycle is one `appAtomRegistry.subscribe` per env child keyed on a memoized atom — no double-subscribe on re-render, clean unsubscribe on env removal; server emits prefs-first then live-only (no history replay), so `(notificationId, channel)` dedupe correctly prevents re-delivery; multi-window native dedupe relies on the shared `Notification` tag — consistent with the stated design; badge merging in `threadNotifications.ts` sums disjoint per-source counts, no double-count; `/watch` route is auto-code-split (`tanstackRouter({ autoCodeSplitting: true })`) and renders an unsupported empty-state; `watchPageOpen && !editableFocus` is correctly supplied in the palette's shortcut context; mute/snooze/acknowledge all have reverse paths.

### [SEVERITY: MEDIUM] Finding 1: `sessionChannels` and store entries leak on environment removal

**File**: apps/web/src/components/WatchNotificationCoordinator.tsx:99-111; apps/web/src/components/watch/watchNotificationStore.ts:53-96

**Problem**: `sessionChannels.delete(environmentId)` runs only inside the `pending.current` loop — i.e., only when the removed environment has an outstanding native notification. An environment removed with zero pending notifications keeps its `SessionChannel` (inAppChannelId, `inAppDelivered`, `nativeDelivered`, prefs) for the rest of the page session. The same applies to `watchNotificationStore`: `unread`, `thresholdAlerts`, and `prefs` are keyed by environmentId and are never evicted when the environment leaves the catalog.

**Evidence**: The deletion is nested inside `for (const [tag, { environmentId, ... }] of pending.current)` gated on `!activeIds.has(environmentId)` — it is reached only for envs that happen to have an open native `Notification` at that moment. There is no other cleanup path for `sessionChannels`, `unread`, `thresholdAlerts`, or `prefs`.

**Impact**: Per-environment dedupe sets and surface state accumulate for removed environments (each `SessionChannel` holds every delivered notificationId string of the session). Modest memory growth over long sessions and repeated env churn; a re-added environment with the same id also silently inherits a stale channel/prefs snapshot.

**Suggestion**: Delete `sessionChannels` and the store's per-env entries unconditionally for every environment dropped from `environmentIds` (iterate `sessionChannels.keys()`/`unread` against `activeIds`), not just envs with pending notifications.

### [SEVERITY: MEDIUM] Finding 2: Unread badge never accrues under default settings — docs/UI promise a badge that is dead by default

**File**: apps/web/src/components/WatchNotificationCoordinator.tsx:289-320

**Problem**: `addWatchNotificationUnread` runs only inside `delivery.inApp && settings.inAppNotificationsEnabled` or `delivery.desktopNative && hasDesktopNotifications(mode)`. Both default to off (`ClientSettingsSchema`: `notificationMode` → `"off"`, `inAppNotificationsEnabled` → `false`, packages/contracts/src/settings.ts:322-325). With defaults, every watch notification marks a dedupe key and produces nothing — no toast, no native, and **no unread increment** — so the sidebar badge (`SidebarChrome.tsx`) and the bell badge never fire.

**Evidence**: `deliverNotification` gates unread accrual behind the surface flags. `docs/user/watch-screen.md` states notifications "show as a badge on the sidebar and in the app" unconditionally. Thread notifications have no equivalent "unread" surface, so this gating choice has no precedent to compare — the badge is the only ambient signal for watch alerts.

**Impact**: A user who never touched notification settings sees `thread.completed`/`connector.unhealthy`/`widget.threshold` events produce zero visible signal anywhere except the bell's history list — which they have no reason to open since its badge is also 0. Threshold widget badges (`addWatchThresholdAlert`) are the only exception.

**Suggestion**: Either accrue `unread` whenever the notification is deliverable under prefs (badge is itself the surface — count it even when toasts/native are disabled), or clarify that the badge intentionally mirrors delivered surfaces only; at minimum make the docstring in `deliverNotification` ("nothing accrues") match the user docs.

### [SEVERITY: MEDIUM] Finding 3: `notificationMode` "sound" is ignored — watch notifications produce no audible cue and silently drop in sound-only mode

**File**: apps/web/src/components/WatchNotificationCoordinator.tsx:319-338

**Problem**: `deliverNotification` never consults `hasNotificationSound`/`playNotificationSound`. In `notificationMode === "sound"` (and `"notifications-and-sound"`), thread notifications play a sound; watch notifications do not. Worse, in `"sound"`-only mode with the window unattended: `resolveWatchNotificationDelivery` picks the native channel (`!windowAttended`), `hasDesktopNotifications("sound")` is false, so the notification is marked delivered on the native channel and produces nothing at all — no sound, no native, no unread (per Finding 2's gating).

**Evidence**: `ThreadNotificationCoordinator.tsx:167-171` calls `playNotificationSound` under `hasNotificationSound(mode)`. The watch coordinator imports only `hasDesktopNotifications`. `nativeDelivered` is marked at lines 251-258 before the mode check, so the event is consumed for the session.

**Impact**: Users on "sound" or "notifications-and-sound" get no audio for watch events; on "sound"-only, unattended watch notifications vanish entirely (history only). Divergent from the established notification semantics.

**Suggestion**: Add a `hasNotificationSound` path in `deliverNotification` (e.g., map `toastType` to `completion`/`input` kinds, or play on any delivered channel), matching thread behavior.

### [SEVERITY: MEDIUM] Finding 4: Prefs writes are full-replace against a possibly-stale snapshot — rapid toggles lose updates

**File**: apps/web/src/components/watch/WatchNotificationBell.tsx:97-117

**Problem**: `updatePrefs` sends `{...prefs, mutedEventTypes: ...}` where `prefs` is the last stream-echoed value (`useWatchNotificationPrefs`). There is no optimistic update: the local store only changes when the server's `prefs` item round-trips back. Two toggles clicked within that round-trip compute against the same pre-write snapshot — the second write drops the first's change (`{muted:[A]}` then `{muted:[B]}` → final `[B]`). Same hazard for toggles made before the stream's first `prefs` item arrives: `EMPTY_PREFS`-based writes would clobber any existing server-side mutes/snooze (prefs are a server-global singleton shared by all clients).

**Evidence**: `toggleMutedType`/`toggleMutedPage`/`snoozeOneHour`/`Resume` all spread `prefs` straight into `setPrefs`; the store is only updated in the coordinator's stream callback (`setWatchNotificationPrefs`, coordinator line 206-208). Remote/relay environments make the echo latency real, not just theoretical.

**Impact**: Silently lost mute/snooze updates on every connected client — the very controls the popover exists for.

**Suggestion**: Optimistically write the merged prefs into the store (or a pending-prefs buffer) on `updatePrefs` so consecutive edits compose; alternatively disable toggles until the first prefs item lands and base each write on the newest local view.

### [SEVERITY: MEDIUM] Finding 5: Sidebar badge and screen resolve different environments — badge can hide live unread

**File**: apps/web/src/components/sidebar/SidebarChrome.tsx:201; apps/web/src/components/watch/WatchScreen.tsx:410-412

**Problem**: The sidebar Watch badge reads `useWatchUnreadCount(useActiveEnvironmentId())` — null when no environment is active → 0. `WatchScreen` resolves `activeEnvironmentId ?? primaryEnvironmentId`. When `activeEnvironmentId` is null (no thread/context selected yet), the bell inside `/watch` shows the primary env's unread while the sidebar badge shows nothing. Additionally, unread accrues for _every_ environment (the coordinator subscribes all catalog envs) but is only ever rendered for the active/resolved one — alerts on a secondary environment are invisible in both surfaces unless the user switches to it.

**Evidence**: Coordinator's `addWatchNotificationUnread(environmentId, ...)` is per-env; the only readers are `SidebarChrome` (active env) and the bell (resolved env). Nothing aggregates or indicates unread on non-active envs.

**Impact**: Missed notification signal in exactly the cases the badge exists for (working in env A while env B's connector dies).

**Suggestion**: Either sum unread across environments for the sidebar badge, or at minimum apply the same `active ?? primary` fallback used by `WatchScreen`.

### [SEVERITY: MEDIUM] Finding 6: Coordinator opens watch subscriptions on every catalog environment regardless of `watchScreen` support

**File**: apps/web/src/components/WatchNotificationCoordinator.tsx:129-136, 149-151, 194-197

**Problem**: `WatchEnvironmentNotifications` is mounted for every entry in `environmentIds` (all catalog environments) and unconditionally opens two always-on streams per env: `notifications.live` and `connectorsLive` (the latter just for toast label lookup). Environments whose `serverConfig.watchScreen !== true` — including older servers lacking these WS methods entirely — still get subscription attempts for the whole session.

**Evidence**: `environmentIdsAtom` (presentation.ts:117) is all catalog entries; no `watchScreen`/`serverConfig` gate exists anywhere in the coordinator. A missing RPC method surfaces as a failed stream/atom but still costs the subscribe call per env per mount.

**Impact**: Per-environment WS noise and failing RPCs on every client for every non-watch environment; on a fleet with several old servers this is permanent background churn for a feature those servers can't serve.

**Suggestion**: Gate `WatchEnvironmentNotifications` (or at least the `connectorsLive` label lookup) on the env's `serverConfig?.watchScreen === true`, mirroring `watchScreenSupportedAtom`'s predicate.

### [SEVERITY: MEDIUM] Finding 7: Dedupe sets and `pending` map grow unboundedly; OS-dismissed notifications are never pruned

**File**: apps/web/src/components/WatchNotificationCoordinator.tsx:54-56, 87-97, 321-333

**Problem**: `inAppDelivered`/`nativeDelivered` accumulate one key per notification for the page session with no eviction bound. `pending` retains a live `Notification` object per native delivery until window focus, env removal, or tag reuse — the `Notification`'s own `close` event (OS auto-dismiss, swipe-away) is never listened to, so entries outlive their on-screen notification and keep inflating the badge source count. The same gap exists in `ThreadNotificationCoordinator`, so this is a copied pattern — but the watch variant additionally feeds `sessionChannels` growth.

**Evidence**: No `native.addEventListener("close", ...)`/`onclose` handler; removal paths are only focus/badgeClear/env-removal. `pending.current.get(tag)?.close()` handles only tag-replacement.

**Impact**: Dock/favicon badge counts notifications the OS already dismissed (over-count until next focus); Notification objects retained. Bounded by notification volume — small, but a long-lived unfocused desktop window accumulates indefinitely.

**Suggestion**: Register a `close` listener that removes the tag from `pending` and recomputes the badge; consider capping the delivered sets (FIFO eviction) or relying on the tag dedupe + server-side once-only emission.

### [SEVERITY: MEDIUM] Finding 8: `emitWatchUiAction` queues actions indefinitely — a stale intent can replay on a much later mount

**File**: apps/web/src/components/watch/watchUiBus.ts:17-34; apps/web/src/components/CommandPalette.tsx:2280-2287

**Problem**: `emitWatchUiAction` appends to `pending` whenever no listener is registered and never expires them. "New watch page from template" emits `open-gallery` right after `navigate({to:"/watch"})`; if the navigation redirects (`/pair` auth gate in `routes/watch.tsx:6-12`) or the screen never mounts, the action sits until the _next_ watch mount — potentially sessions later — then fires `setGalleryOpen(true)` with no user context. A user-remapped `watch.editPage` binding without the `watchPageOpen` `when` clause has the same stale-queue hazard.

**Evidence**: `pending.splice(0)` replays the entire backlog to the first registrant (`onWatchUiAction`, WatchScreen.tsx:771 registers unconditionally, even on the unsupported empty-state since the hook precedes the early return at line 782).

**Impact**: A gallery dialog or edit toggle materializing unprompted on a later visit — confusing, self-healing, but wrong.

**Suggestion**: Deliver-then-drop: if no listener exists after the navigation settles (e.g., queue keyed to route mount, or flush on `beforeUnload`/route change), discard rather than persist; or scope pending to one pending-navigation epoch.

### Summary

**Count: 8 findings — 0 CRITICAL, 0 HIGH, 8 MEDIUM.**

Core mechanics are sound: exactly one stream subscription per env session, `(notificationId, channel)` dedupe works because the server emits each notification once into a PubSub (prefs-first ordering guaranteed), the multi-source badge merge is clean, capability gating hides the sidebar/palette entries, and `/watch` auto-code-splits with a graceful unsupported state. The clustered issues are lifecycle hygiene (Findings 1, 7, 8 — leaks/stale queues keyed to env removal, OS dismiss, and deferred UI intents), delivery-surface gaps (Findings 2, 3, 5 — dead badge under defaults, missing sound channel, env-resolution mismatch), one lost-update race on server-global prefs (Finding 4), and unconditional per-env watch subscriptions on unsupported servers (Finding 6).
