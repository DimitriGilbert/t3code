# Verify Report 15 — Mobile watch follower + entry points

Verdicts: 2 × VERIFIED-DEFECT, 0 × VERIFIED-INTENTIONAL, 0 × REJECTED.
Key verified-clean claims re-checked: kill-switch coverage (CONFIRMED), `originWhitelist={["*"]}` (CONFIRMED correct, verified against installed lib source), bridge parity (CONFIRMED), projection-only writes (CONFIRMED).

## Finding 1 — `about:blank` self-navigation escapes left-page detection — VERIFIED-DEFECT (MEDIUM)

**File**: `apps/mobile/src/features/watch/WatchAppWebView.tsx:205-211, 250-251`

Confirmed line-by-line:

- `stopIfNavigated` (:207-211) early-returns on `url === "about:blank" || url === ""`. A widget running `location.href = "about:blank"` passes the JS gate (`onShouldStartLoadWithRequest` returns `request.url === "about:blank"`, :250), `onNavigationStateChange` fires with `about:blank`, the early return lets it through. Result: permanently blank dead document — no prelude, no `T3`, no `__t3WatchAppReceive` — while the host, its `open` subscription set, the `subscriptions` state, and the mount-registry seat all survive. The card renders an empty transparent WebView, not the error view (`navigatedAway`/`crashed` both false).
- No load counter exists — `onLoadEnd` only sets `loaded` (:254); no `onLoadStart`/second-load check anywhere.
- Web parity confirmed: `WatchAppFrame.tsx:149-161` counts `load` events per `srcdoc`; count > 1 → `dispose()` + `setNavigatedAway` + `onViolation({code: "navigatedAway"})`. Mobile additionally never fires `onViolation` even on the navigation path it _does_ catch (`stopIfNavigated` has no violation call — worse than reported but same fix).
- Impact bounded correctly by the report: the blank document has no scripts and no CSP-inheriting escape hatch (the JS gate still denies every non-`about:blank` URL; CSP blocks subframes), so it's a containment/detection hole and resource hold, not exfil. The file's own comment (:243-245) claims "the generated page loads exactly once" — that contract is stated but unenforced on mobile. Genuine defect, MEDIUM is fair.

**Fix direction**: Mirror the web contract. Keep a per-`sessionDocument` load count (e.g. a ref incremented in `onLoadStart`/`onLoadEnd`, reset alongside `setSessionDocument` at :138-144); on any second main-frame load call a shared `stopSession()` (see Finding 2) and fire `onViolation({code: "navigatedAway", ...})` for badge parity — also add that `onViolation` call to the existing `stopIfNavigated` path. Alternative or complement: tighten the JS gate to permit `about:blank` only until the first load completes (`loadedRef`), so later `about:blank` requests are denied rather than merely undetected. Gate tightening alone doesn't cover `location.reload()`-style reloads that bypass the callback, so the load counter is the web-equivalent enforcement.

## Finding 2 — Crash path never disposes the host — VERIFIED-DEFECT (MEDIUM)

**File**: `apps/mobile/src/features/watch/WatchAppWebView.tsx:218-226, 252-256, 274-288`

Confirmed:

- All four terminal handlers (`onContentProcessDidTerminate`, `onRenderProcessGone`, `onError`, `onHttpError`, :252-256) do only `setCrashed(true)`. The crashed ternary (:218) unmounts the WebView, but `hostRef.current?.dispose()` is never called on this path.
- The feed block (:274-288) renders `subscriptions` gated only on `host === null` — `host` state is only nulled in the `[html]`-keyed effect cleanup (:186-191). So each `WatchAppConnectorFeed` keeps its `watchEnvironment.connectorStream` atom subscription hot; each snapshot still runs `host.deliver` → `notify` → `post` → `webView.current?.injectJavaScript` (null-guarded no-op client-side), but the server-side stream stays alive until the widget unmounts or a new `html` arrives. `crashed` is sticky — reset only in the `sessionDocument` render-adjust (:138-144).
- Cleanup mechanism verified: `dispose()` (`packages/client-runtime/src/watchAppBridge.ts:310-316`) iterates `open` → `closeName` → `options.closeSubscription` → `setSubscriptions(filter)` → feeds unmount → atom unsubscribe. `stopIfNavigated` uses exactly this (:209) and is the established pattern the crash path should follow.
- Mount seat confirmed held: `WatchAppWidget`'s visibility report fires only on its own mount/unmount (`WatchAppWidget.tsx:102-105`); a crashed `WatchAppWebView` keeps the wrapper mounted, so the seat is held until the row leaves the screen. A repeatedly-crashing widget can occupy `WATCH_APP_MOUNT_LIMIT` seats of dead streams.

**Fix direction**: Extract a `stopSession()` that calls `hostRef.current?.dispose()` (subscription teardown rides `closeName`) and optionally `setHost(null)` for clarity; call it from all four crash/error handlers before `setCrashed(true)` and reuse it inside `stopIfNavigated`. Belt-and-suspenders: gate the feed block on `!crashed && !navigatedAway` in addition to `host !== null`, since `host` state isn't nulled by the stop path today.

## Sanity checks on verified-clean claims

- **Kill switch — CONFIRMED.** `watchAgentWidgetsMobileSupported` fails closed (`=== true`, `watchMobile.ts:21-25`). Render filter `watchMobileVisibleWidgets` drops `agent:*` kinds when disabled (`watchMobile.ts:28-34`, applied `WatchScreen.tsx:122-125`); edit-mode hidden list re-excludes them (:128-134); the projection builder treats them as move-inert in both directions (`watchPages.ts:230-243` — `isMoveInert` covers `mobileHidden` and capability-hidden agent kinds, and `moveState` affordances derive from the filtered `visibleWidgets`, `WatchScreen.tsx:139-145`). No connector-data feed reaches a capability-hidden widget: `needsConnectors` is computed over `visibleWidgets` only (:148-153), and `connectorStream`/`widgetSourceLive`/`getWidgetSource` all live inside mounted bodies (`WatchAppWebView.tsx:53-61`, `WatchAppWidget.tsx:172-213`) that only render for `visibleWidgets` rows. Mount seats: `useWatchAppMounts` performs no data subscriptions and ignores reports for non-agent kinds (:78-94); a capability-hidden agent widget can be _tracked_ (unfiltered `widgets` input at `WatchScreen.tsx:169-172`) but tracking claims no seat — only a mounted `WatchAppWidget`'s visibility effect reports, and it can't mount when filtered out. Verified clean, including the connector-subscription angle.
- **`originWhitelist={["*"]}` — CONFIRMED correct and intentional.** Verified against installed `react-native-webview@14.0.1` source (`node_modules/.pnpm/react-native-webview@14.0.1_patch_hash=81caa279.../src/WebViewShared.tsx:38-65`): `createOnShouldStartLoadWithRequest` calls `Linking.canOpenURL`/`Linking.openURL` — the OS-browser handoff — **only on whitelist rejection** (:47-59), and the JS `onShouldStartLoadWithRequest` callback runs only on the pass branch (:60-61). So `*` routes every request through the JS gate (`request.url === "about:blank"` deny-all-else); a restrictive whitelist would bypass the JS gate entirely and hand rejected URLs to `Linking` — an exfil channel the web sandbox lacks. `compileWhitelist` also always prepends `about:blank` (:36). The in-code comment (:233-237) is accurate.
- **Bridge parity — CONFIRMED.** `makeWatchAppHost` is shared (`watchAppBridge.ts`); manifest checks, 256KB cap, 16-pending cap, and the never-trust-frame-supplied-instanceId rule (:187-201) apply identically. `WatchAppWidget` passes no `actions`, so `invokeAction` throws `WatchAppHostRefusal` for every `t3.watch/action` — same posture as web.
- **Projection-only writes — CONFIRMED.** `WatchWidgetSetMobileProjectionInput` permits only `pageId`/`expectedMobileRevision`/`{widgetId, mobileOrder, mobileHidden}` (`contracts/watch.ts:359-374`); no `setLayout`/placement write exists in `apps/mobile/src`.
- **Minor notes verified**: `mobileWidgetHeight` (`WatchAppWidget.tsx:54-56`) does read `widget.placement.h`, technically contradicting the `WatchScreen.tsx:74` "Desktop placement is never read" comment — cosmetic comment nit, read-only, no functional issue. Edit affordance on fully capability-hidden pages — cosmetic, confirmed.

## Recommendation

Land both fixes together in `WatchAppWebView.tsx` — they share the same `stopSession()` teardown and the same per-document lifecycle state. Suggest a focused test (`WatchAppWebView.test.tsx` already exists) asserting that a second `onNavigationStateChange`/`onLoadStart` and each crash handler close subscriptions.
