# Verify — review-report-14 (web notifications + app-shell integration)

## Terse summary

| #   | Sev    | Verdict                     | Note                                                                                                                                                                                                                                                   |
| --- | ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | MEDIUM | VERIFIED-DEFECT             | `sessionChannels.delete` is nested inside the `pending` loop — envs with no open native notification keep their channel forever. Store `unread`/`thresholdAlerts`/`prefs` have no env-removal eviction at all.                                         |
| 2   | MEDIUM | VERIFIED-DEFECT             | Defaults confirmed off (`settings.ts:322-325`); badge accrual is gated on the surface flags, so a stock install shows zero watch signal. Contradicts DESIGN.md §10 and docs/user/watch-screen.md.                                                      |
| 3   | MEDIUM | VERIFIED-DEFECT             | No `hasNotificationSound`/`playNotificationSound` anywhere in the watch coordinator; "sound"-only unattended events are consumed by dedupe then produce nothing.                                                                                       |
| 4   | MEDIUM | VERIFIED-DEFECT             | Full-replace `setPrefs` on a server-global singleton (`UserNotificationService.ts:431-442`), based on the last echoed snapshot with no optimistic buffer — real lost-update race.                                                                      |
| 5   | MEDIUM | VERIFIED-DEFECT             | Sidebar badge reads `useActiveEnvironmentId()` (null→0), screen resolves `?? primaryEnvironmentId`; unread accrues per-env for all catalog envs with no aggregation.                                                                                   |
| 6   | MEDIUM | VERIFIED-DEFECT             | No `watchScreen` gate on either subscription; impact qualifier: failures don't hot-loop (no `retryExpectedFailureAfter` is passed), but each session/reconnect fires a doomed subscribe per non-watch env.                                             |
| 7   | MEDIUM | VERIFIED-DEFECT             | No `close` handler; `pending` only prunes on focus/badge-clear/env-removal/tag-replace. Copied gap from `ThreadNotificationCoordinator` (same defect exists there).                                                                                    |
| 8   | MEDIUM | VERIFIED-DEFECT (DUPLICATE) | **Duplicate of review-report-12 Finding 4** — same file/lines (`watchUiBus.ts:17-34`), same root cause. r14 adds two vectors r12 missed: the `/pair` redirect queue case and unconditional listener registration at `WatchScreen.tsx:771`. Track once. |

Counts: 8 VERIFIED-DEFECT / 0 VERIFIED-INTENTIONAL / 0 REJECTED. (One is a confirmed duplicate.)

## Finding 1 — VERIFIED-DEFECT

- `sessionChannels.delete(environmentId)` sits inside `for (const [tag, {environmentId}] of pending.current)` gated on `!activeIds.has(environmentId)` (`WatchNotificationCoordinator.tsx:102-107`) — reached only when the removed env has an open native `Notification` at that moment. Envs removed with zero pending natives keep their `SessionChannel` (incl. every delivered-id `Set`) for the page session.
- `watchNotificationStore.ts` has no env-removal eviction: `unread` (:18), `thresholdAlerts` (:20), `prefs` (:22) keyed by env id persist until explicitly cleared by the bell/widget (`clearWatchNotificationUnread`, `acknowledgeWatchThresholdAlert`) — which a removed env can never trigger.
- Comment at :47-50 says channels survive remounts deliberately — but env _removal_ is not a remount; nothing distinguishes the two.
- Fix direction: sweep `sessionChannels` + store entries against `activeIds` unconditionally in the `environmentIds` effect (or a store `evictEnvironment(environmentId)`), not just envs with pending notifications.

## Finding 2 — VERIFIED-DEFECT

- Defaults verified: `notificationMode` → `"off"`, `inAppNotificationsEnabled` → `false` (`packages/contracts/src/settings.ts:322-325`).
- `deliverNotification` accrues `addWatchNotificationUnread` only inside `delivery.inApp && settings.inAppNotificationsEnabled` (:289-290) or `delivery.desktopNative && hasDesktopNotifications(mode)` (:319-320). With stock settings every deliverable event is dedupe-marked (:246-258) then produces no toast, no native, no badge increment. Threshold alerts do accrue (`addWatchThresholdAlert`, :217-220) — widget-header badges only, not the sidebar/bell count.
- Intent check: no plan text sanctions gating the badge on surface toggles. DESIGN.md §10 lists the badge as a first-class surface ("sidebar Watch item and the header bell each get an unread count"); docs/user/watch-screen.md:54-55 promises badges unconditionally. The code docstring (:287-288) admits "nothing accrues" — a local design choice that contradicts shipped docs and makes the feature's only ambient signal dead-by-default.
- Fix direction: accrue `unread` whenever `resolveWatchNotificationDelivery` returns a deliverable channel (the badge is the lowest-intrusion surface), or explicitly reconcile docs to say badges require enabling a notification surface.

## Finding 3 — VERIFIED-DEFECT

- `WatchNotificationCoordinator.tsx` imports only `hasDesktopNotifications` (:30); `hasNotificationSound`/`playNotificationSound`/`unlockNotificationAudio` never appear. Confirmed by grep — the only watch-side hit is none; audio unlock exists only in `ThreadNotificationCoordinator` (:70-78) and `NotificationSettings`.
- Sound-only drop confirmed: `resolveWatchNotificationDelivery` picks `desktopNative` when `!windowAttended` (`watchNotifications.ts:161-169`); `hasDesktopNotifications("sound")` is false (`threadNotifications.ts:18-20`), so the event is marked delivered on the native channel (:251-258) and surfaces nothing. In `"notifications-and-sound"` the native fires `silent: true` (:326) — still no sound.
- Thread precedent: `ThreadNotificationCoordinator.tsx:167-171` plays `playNotificationSound(kind)` under `hasNotificationSound(mode)`; PullRequestGuideRunCoordinator:92-94 does the same. Watch diverges with no documented reason; no plan doc mentions sound for watch at all.
- Fix direction: add a `hasNotificationSound(settings.notificationMode)` branch in `deliverNotification` (map `presentation.toastType` → `completion`/`input`, or play on any delivery decision), plus an audio-unlock listener effect mirroring the thread coordinator.

## Finding 4 — VERIFIED-DEFECT

- `updatePrefs` sends `{...prefs, ...}` where `prefs = storedPrefs ?? EMPTY_PREFS` (`WatchNotificationBell.tsx:77, 97-117`); the store is written only by the coordinator's stream echo (`setWatchNotificationPrefs`, coordinator :205-208). No optimistic update, no pending buffer.
- Server confirms the hazard shape: `setPrefs` is a documented "Full prefs replace" on `WHERE singleton = 1` (`UserNotificationService.ts:57, 431-442`) and re-publishes `{type:"prefs"}` into the PubSub — the echo the store waits for. Prefs are global across all clients of the environment.
- Two toggles inside one echo window compose against the same snapshot → second write drops the first. Cross-client: any concurrent client's write can be clobbered by this client's stale-based full replace. Pre-first-echo edits write `EMPTY_PREFS`-derived state and wipe server mutes/snooze.
- Fix direction: optimistic local write on `updatePrefs` (or a pending-write merge so consecutive edits compose), or disable toggles until first prefs item lands. Longer-term, a `patchPrefs`-style RPC would remove the read-modify-write entirely.

## Finding 5 — VERIFIED-DEFECT

- `SidebarChrome.tsx:202`: `useWatchUnreadCount(useActiveEnvironmentId())`; `useActiveEnvironmentId` returns the atom's `EnvironmentId | null` (`entities.ts:53-60`, default null, set only on bootstrap/env-selection at `__root.tsx:398,533,612`). `useWatchUnreadCount(null)` → 0.
- `WatchScreen.tsx:410-412`: `activeEnvironmentId ?? primaryEnvironmentId` — so on /watch with no active env, the header bell shows the primary env's unread while the sidebar badge shows nothing.
- Broader half verified: the coordinator subscribes _every_ catalog env (:129-135) and `addWatchNotificationUnread` is keyed per env; the only readers resolve a single env. Unread on a non-active env is invisible in both surfaces until env switch.
- Fix direction: apply the same `active ?? primary` fallback in `SidebarUtilityMenu` (cheap parity), and consider summing `unread` across envs for the sidebar badge since the badge's job is "something happened somewhere".

## Finding 6 — VERIFIED-DEFECT (impact qualifier)

- `environmentIdsAtom` = all catalog entries (`presentation.ts:117-125`); `WatchEnvironmentNotifications` mounts per entry with no `serverConfig.watchScreen` check (coordinator :129-135) and opens `notifications.live` (:194-197) + `connectorsLive` (:149-151, label lookup only).
- Qualifier on "churn": `createEnvironmentRpcSubscriptionAtomFamily` → `subscribe(tag, input)` is called with **no options**, so `retryExpectedFailureAfter` is unset (`client.ts:434-444`, retry only when option present at :366-386). A doomed subscribe fails once into a `Failure` atom; it re-attempts on session change/reconnect (switchMap at `client.ts:287-291`) and on remount, not in a hot loop. So: one failing RPC per unsupported env per session + a permanently failed atom + resubscribe-per-reconnect — bounded waste, not "permanent churn". The missing gate is still real and trivially cheap (`watchScreenSupportedAtom` already exists per-env, `presentation.ts:214-219`).
- Fix direction: gate `WatchEnvironmentNotifications` (and especially the label-only `connectorsLive`) on `environment.serverConfig?.watchScreen === true`.

## Finding 7 — VERIFIED-DEFECT

- No `close`/`onclose` listener on the native `Notification` — removal paths are only focus-clear (:113-127), `desktopBridge.onNotificationBadgeClear` (:120), env-removal (:102-107), and tag-replacement (:92). OS-dismissed entries keep counting into `setNotificationBadgeForSource` (:94,109).
- `inAppDelivered`/`nativeDelivered` sets grow unbounded for the page session (no eviction bound anywhere).
- Copied pattern confirmed: `ThreadNotificationCoordinator.tsx` has the identical gap (no close handler; same pending-map lifecycle). Acknowledged in the report.
- Fix direction: `native.addEventListener("close", ...)` removing the tag from `pending` and recomputing the badge (fix both coordinators); optionally cap delivered sets FIFO — though server-side once-only emission + tag dedupe already bound their growth to real volume.

## Finding 8 — VERIFIED-DEFECT (DUPLICATE of review-report-12 Finding 4)

- Same root cause at the same site: `emitWatchUiAction` queues with no listener (`watchUiBus.ts:19-25`), `onWatchUiAction` flushes the entire backlog to the first registrant (:28-31). No TTL, cap, or epoch.
- r14's additional vectors check out:
  - `/pair` redirect: `routes/watch.tsx:6-12` throws `redirect({to:"/pair"})` on unauthenticated load; the palette emits `open-gallery` after `navigate` (`CommandPalette.tsx:2280-2284`), so the action survives a failed navigation and detonates on the next successful /watch mount.
  - Unconditional registration: `WatchScreen.tsx:771` `useEffect(() => onWatchUiAction(handleUiAction))` runs before the `!watchSupported` early return at :782, so even the unsupported empty-state consumes and replays the queue (`setGalleryOpen(true)` on an env that can't serve it).
  - Custom keybinding hazard confirmed: `watch.editPage` → `emitWatchUiAction("toggle-edit")` (`CommandPalette.tsx:490-495`); default binding carries `when: "watchPageOpen && !editableFocus"` (`keybindings.ts:212`) but a remapped binding without `when` queues stale intent.
- Fix direction (consistent with r12): bound the queue — TTL, last-action-wins, or deliver-once scoped to a pending navigation. Track and fix once under r12-f4; this report is the confirming duplicate.
