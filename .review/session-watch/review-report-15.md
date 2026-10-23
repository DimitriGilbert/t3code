# Cluster 15 Review — Mobile watch follower + entry points

Scope: `apps/mobile/src/features/watch/*`, `apps/mobile/src/state/watch.ts`, route + entry-point diffs in `Stack.tsx`, `features/home/HomeHeader*`, `HomeRouteScreen`, `MaterialThreadListToolbar`, `features/workspace/WorkspaceRootScreen`, `WorkspaceToolbar.ios.tsx`.

## Verified clean (review-focus checklist)

- **Kill-switch coverage.** `watchAgentWidgetsMobileSupported` fails closed (`=== true`, `watchMobile.ts:21-25`). Render path filtered via `watchMobileVisibleWidgets` (`WatchScreen.tsx:122-125`); edit-mode hidden list excludes capability-hidden agent widgets (`WatchScreen.tsx:128-134`); the projection builder treats them as move-inert in both directions (`watchPages.ts:230-243`). Mount seats cannot be taken without a render (`useWatchAppMounts.ts:78-94` reports only from mounted `WatchAppWidget`s), and `useWatchAppMounts` performs no data subscriptions. All connector-data subscriptions (`connectorsLive` via `needsConnectors` on `visibleWidgets` only — `WatchScreen.tsx:148-158`; `connectorStream`/`widgetSourceLive`/`getWidgetSource` inside mounted widget bodies) are unreachable for capability-hidden widgets. No picker exists on mobile.
- **Projection-only writes.** `WatchWidgetSetMobileProjectionInput` structurally permits only `pageId`, `expectedMobileRevision`, and `{widgetId, mobileOrder, mobileHidden}` patches (`contracts/watch.ts:359-374`). No `setLayout`/placement write exists anywhere in `apps/mobile`.
- **WebView posture.** Deny-all-but-`about:blank` JS gate, `setSupportMultipleWindows=false`, `domStorageEnabled=false`, `allowFileAccess=false`, `allowUniversalAccessFromFileURLs=false` all present. `originWhitelist={["*"]}` verified intentional and correct: in `react-native-webview` the `Linking.openURL` exfil path runs only on whitelist _rejection_ (`WebViewShared.tsx:44-56`), so `"*"` routes every request to the JS callback, which denies without OS handoff.
- **Bridge parity.** `makeWatchAppHost` is shared — manifest enforcement, 256KB message cap, 16 pending-request cap, and the never-trust-frame-supplied-instanceId rule are identical to web (`watchAppBridge.ts`). Mobile passes no `actions`, so every `t3.watch/action` is refused — same as web today.
- **Entry points.** All four sites (iOS/Android Home headers, iOS/Android workspace toolbars) hide entirely on `useWatchEntryEnvironmentId() === null`; deep link to an unsupported env renders "not available" (`WatchScreen.tsx:295-313`).
- **Move inert-target fix.** `moveState` derives affordances from the capability-filtered `visibleWidgets` (`WatchScreen.tsx:139-145`), matching `isMoveInert` in the builder — neighbour skipping and target rejection agree.

## Findings

### [SEVERITY: MEDIUM] Finding 1: Widget self-navigation to `about:blank` escapes the left-page detection web enforces

**File**: `apps/mobile/src/features/watch/WatchAppWebView.tsx:205-211, 250-251`
**Problem**: Web's `WatchAppFrame` treats _any second document load_ as navigated-away: `onFrameLoad` counts loads per srcdoc and stops the widget on count > 1 (`WatchAppFrame.tsx:149-161`), also reporting `onViolation({code: "navigatedAway"})`. Mobile's `stopIfNavigated` only inspects the URL and _accepts_ `about:blank`/`""` unconditionally — so a widget bundle that runs `location.href = "about:blank"` (or reloads into a blank doc) replaces the generated document with an empty page and is never detected. `onNavigationStateChange` fires with `about:blank`, the early return lets it through, the WebView keeps a permanently blank dead document, and the bridge host stays alive.
**Evidence**: `stopIfNavigated` (`WatchAppWebView.tsx:207-211`) returns early on `url === "about:blank"`; the only other guard is the JS load gate, which _permits_ `about:blank` (`:250`). No load counter exists (no `onLoadStart`/`onLoad` counting, no second-load check). Contrast web `WatchAppFrame.tsx:149-161`.
**Impact**: A buggy or hostile widget can blank itself out while holding its mount-registry seat and all open `connectorStream` subscriptions; the screen shows an empty card with no error, where web shows "left its page and was stopped" plus the violation badge. Not a data-exfil channel (the blank page has no `__t3WatchAppReceive`), but a containment/detection parity hole.
**Suggestion**: Mirror the web contract — count `onLoadStart`/`onLoadEnd` events per document (`sessionDocument`), and on any main-frame load after the first call `stopIfNavigated`-equivalent: dispose the host, set `navigatedAway`, and fire `onViolation({code: "navigatedAway", ...})` for badge parity. Alternatively key on `navState.loading`/navigation type if the RN event distinguishes the initial `loadDataWithBaseURL` load from a JS-triggered reload.

### [SEVERITY: MEDIUM] Finding 2: Crash path never disposes the host — connector streams keep flowing to a dead widget

**File**: `apps/mobile/src/features/watch/WatchAppWebView.tsx:218-226, 252-253, 274-288`
**Problem**: `onContentProcessDidTerminate`/`onRenderProcessGone`/`onError`/`onHttpError` set `crashed`, which swaps the WebView for the error view — but nothing calls `hostRef.current?.dispose()` or clears `subscriptions`. Feeds render on `{host === null ? null : subscriptions.map(...)}` (`:274`), which is _not_ gated on `crashed`, so each `WatchAppConnectorFeed` keeps its `connectorStream` RPC subscription alive and keeps invoking `host.deliver` → `injectJavaScript` on an unmounted WebView (harmless no-op client-side, but the server subscription stays hot).
**Evidence**: `stopIfNavigated` disposes on navigation (`:209`), but the crash handlers (`:252-253`) only `setCrashed(true)`; `dispose` is otherwise reached only via the `[html]`-keyed host effect cleanup (`:186-191`).
**Impact**: For every crashed widget, its bridge-opened connector subscriptions stream snapshots indefinitely (battery/data/server-side polling cost) until the page is left or the widget unmounts; the widget also keeps its mount seat despite being permanently dead. A widget that crashes repeatedly under memory pressure can hold up to `WATCH_APP_MOUNT_LIMIT` seats of dead streams.
**Suggestion**: In the crash handler path do what `stopIfNavigated` does — `hostRef.current?.dispose()` (which closes open subscriptions through `closeName`) before `setCrashed(true)`, or gate feed rendering on `!crashed && !navigatedAway`.

## Notes (not findings)

- `WatchAppWidget.mobileWidgetHeight` (`WatchAppWidget.tsx:54-56`) reads `widget.placement.h` — a desktop layout field — as the only available height hint. Harmless reuse and read-only, but it technically contradicts `WatchScreen.tsx`'s "Desktop placement is never read" header claim; consider softening the comment.
- The web `navigatedAway` violation badge has no mobile equivalent beyond the swapped error view (subsumed under Finding 1's suggestion).
- `WatchScreen.tsx` edit affordance shows on pages whose entire stack is capability-hidden (`selectedWidgets.length > 0` is unfiltered); entering edit mode on such a page shows an empty stack. Cosmetic.
