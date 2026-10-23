# Verify Report — Review Report 9: Shared sandbox host (bridge + web frames)

Scope verified against `packages/client-runtime/src/watchAppBridge.ts` (r/w),
`apps/web/src/components/watch/{WatchAppFrame,WatchAppWidget,WatchWidgetBody,WatchScreen,useWatchAppMounts,WatchAppTapToLoad}.ts(x)`,
`apps/mobile/src/features/watch/{WatchAppWebView,WatchAppWidget}.tsx`,
`packages/client-runtime/src/state/watchMounts.ts`,
`apps/server/src/watch/WatchPageService.ts` + `WidgetTranspileService.ts`,
`apps/desktop/src/electron/ElectronProtocol.ts`, `apps/server/src/http.ts`, and
`.plans/welcome-screen/{PRD,PLAN,DESIGN}.md`.

## Verdict counts

- VERIFIED-DEFECT: 7 (Findings 1, 2, 3, 4, 5, 6, 8, 9 — counting the two LOWs)
- REJECTED: 1 (Finding 7a; 7b verified as a separate LOW defect)
- VERIFIED-INTENTIONAL: 0

Recount: 1 HIGH, 5 MEDIUM, 2 LOW verified; Finding 7 split (7a REJECTED, 7b LOW defect).

## Finding 1 — VERIFIED-DEFECT (HIGH): self-navigation exfiltrates despite `connect-src 'none'`

Confirmed technically:

- `sandbox="allow-scripts"` (`WatchAppFrame.tsx:240`) has no token that blocks a
  frame from navigating **itself** — `allow-top-navigation*` governs navigating
  the _parent_, which is correctly absent but irrelevant to self-navigation.
- CSP governs fetches, not browsing-context navigations: `connect-src 'none'`
  doesn't apply to `location.href` assignment, dynamically-inserted
  `<meta http-equiv="refresh">`, or `<a target="_self">`. `form-action 'none'`
  covers only form submission. `navigate-to` was dropped from CSP3 and is
  unimplemented — confirmed absent from `watchAppContentSecurityPolicy`
  (watchAppBridge.ts:501) anyway.
- The `</script>`-splice vector is real and slightly worse than reported: a
  bundle containing literal `</script><meta http-equiv="refresh" …>` truncates
  the script element (CSP hash then mismatches → script blocked → **zero code
  runs**) yet the tail parses as live markup — exfil with no script execution.
- Detection is post-mortem: `onFrameLoad` (WatchAppFrame.tsx:150-161) fires on
  `load`, after the GET request has left. The `:142-148` comment acknowledges
  the postMessage window ("a bounded window no frame API closes earlier") but
  presents navigation enforcement as working; it does **not** disclose that the
  navigation request itself carries data out, so the "zero network" claim
  (:32-34, :493) is misleading.
- Gap-window attack verified: `event.source === target()` (:204) still holds
  for a hostile destination document (iframe keeps its `contentWindow` across
  navigation), so a navigated page can call subscribe and receive `deliver`
  posts until `load` fires and disposes the host.
- Mobile parity gap confirmed: `onShouldStartLoadWithRequest` denies all but
  `about:blank` (WatchAppWebView.tsx:250); web has no equivalent interception
  point.

Residual documentation: **not recorded** — PRD.md:192-208 and PLAN.md:518-568
assert "no network" / "zero network" with no self-navigation caveat.

Exfil surface: subscribed connector snapshots (arbitrary connector data — the
sensitive payload), plus `hostContext` (theme variables only today —
`WatchWidgetBody.tsx:134-144` passes no `hostContext`). One-shot: the
navigation destroys the widget.

Feasible mitigations, honestly assessed:

- **No web-platform primitive fully blocks self-navigation** in a srcdoc
  iframe. `navigate-to` is dead; sandbox tokens only gate top-navigation. A
  parent-side `frame-src` CSP does not reliably help: the embedded-web CSP
  path (`apps/server/src/http.ts:590-649`) sets **no CSP at all** on served
  app HTML, and desktop's `frame-src 'self' blob: http: https:`
  (`ElectronProtocol.ts:101`) permits http(s) navigations anyway.
- Realistic fixes: (a) fix the misleading "zero network" comments and record
  the residual in the plan/security docs; (b) prelude installs a
  `pagehide`/`beforeunload` listener that posts a "navigating" notice so the
  host disposes before the request completes (closes the deliver-spoof gap,
  doesn't stop the request); (c) sanitize/split `</script>` in emitted bundles
  (removes the script-free meta-refresh vector); (d) data minimization —
  document that `deliver`/`hostContext` payloads are exfiltratable and keep
  secrets out.
- Keep severity HIGH: the sandbox's whole job is containing untrusted
  agent-authored code, and a silent information-outflow hole defeats it; but
  the honest verdict is "defect with no complete fix available — document +
  mitigate."

## Finding 2 — VERIFIED-DEFECT (MEDIUM): `opening` leak on pending-cap refusal

Confirmed (watchAppBridge.ts:203-228): `opening.add(name)` at :207 precedes
`answer(id, …)`; `answer`'s `pending >= MAX_PENDING_REQUESTS` refusal
(:151-153) returns without removing `name`. The name is stranded in `opening`
until `dispose` — every later subscribe for it hits `open.has(name) ||
opening.has(name)` (:203) and fake-succeeds with `{}` while no feed was ever
opened and `deliver` (:300) silently drops.

Nuance the report missed: `t3.watch/unsubscribe` does `opening.delete(name)`
(:248), so the widget _could_ clear it — but it was told subscribe succeeded
and has no reason to unsubscribe, so the phantom state is effectively
permanent in practice. 16 pending is reachable via a burst of `T3.action`
calls (each `invokeAction` occupies a slot until resolved).

Fix direction: as suggested — check `pending` before `opening.add`, or pass an
`onRefuse` cleanup into `answer` (also covers Finding 3's leak).

## Finding 3 — VERIFIED-DEFECT (MEDIUM→LOW, latent): sync throw leaks `pending`, escapes `receive`

Confirmed: `void run().then(…)` (:156) — a synchronously-throwing `run()`
skips both `.then` callbacks, so `pending` is never decremented and the
exception propagates out of `receive` into the `message` listener
(`WatchAppFrame.tsx:204`). 16 such calls wedge the bridge permanently (and
leak `opening` the same way as Finding 2).

Latent as reported: all current host handlers are `async` fns
(WatchAppFrame.tsx:172-190) which cannot throw synchronously. Adjacent
unreported instance of the same class: `options.hostContext?.()` is invoked
synchronously at :237 and :307-308 — a caller-supplied sync `hostContext` that
throws escapes `receive`/`updateHostContext` identically (no `pending` leak
there, but an uncaught error in the listener).

Fix direction: `void Promise.resolve().then(run).then(ok, fail)`, and wrap
`hostContext()` calls in try/catch.

## Finding 4 — VERIFIED-DEFECT (MEDIUM): no rate limiting on synchronous bridge paths

Confirmed: nothing in `receive`/`handleRequest` (:284-297, :231-281) bounds
message rate. `ping`, `hostContext`, `unsubscribe`, unknown-method,
malformed-request, and every manifest-violation path each do synchronous host
work + a structured-clone `post` back per message; the 16-pending cap covers
only `subscribe`/`action`, the 256 KB cap bounds size not rate.

React-churn amplifier verified: `violate` → `onViolation` →
`latest.current.props.onViolation` (WatchAppFrame.tsx:191) →
`WatchAppArtifactBody.onViolation` (WatchAppWidget.tsx:280) → `setViolation`
(:107) — one React state update + re-render per undeclared-call message. A
widget spamming undeclared names sustains render churn on the host main
thread; same-process iframe postMessage dispatch makes this a real
host-thread DoS a legitimately hash-authorized artifact can mount.

Fix direction: token-bucket in `receive` (drop/ignore beyond N per window);
dedupe `onViolation` (last-wins per widget per code+name); short-circuit
`jsonBytes` for `typeof data === "string"`.

## Finding 5 — VERIFIED-DEFECT (MEDIUM): open feeds never re-authorized on rebind

Confirmed: `openSubscription` snapshots `bound` into `feed.instanceId`
(WatchAppFrame.tsx:172-179); `WatchAppConnectorFeed` streams
`props.feed.instanceId` (:60-89) for the feed's lifetime. A binding change
(`onConfigureSubmit` → new `widget.config.source.binding` → new
`boundInstance` at WatchAppWidget.tsx:286) only updates `latest.current.props`
— read live for _new_ subscribes. Open feeds keep streaming the old instance
indefinitely; `open.has(name)` (:203) makes a re-subscribe a no-op so the
widget can't even self-heal. Nothing watches `connectorInstanceId()` for
changes or closes open feeds on rebind; `subscriptions` only resets on host
dispose (srcdoc change) — not on binding change. Clearing the binding behaves
the same: old feed keeps streaming while new subscribes correctly refuse.

Severity: same-class breach the `foreignInstance` check exists to prevent, on
a slower timescale — MEDIUM as filed.

Fix direction: key `subscriptions` entries by `(name, instanceId)`; or watch
the bound value in `WatchAppFrame` and `closeSubscription` all open feeds when
it changes.

## Finding 6 — VERIFIED-DEFECT (LOW, latent): action args carry frame-controlled `instanceId`

Confirmed: `t3.watch/action` validates name + `Predicate.isObject` (:253-272)
then hands `params.arguments` verbatim to `invokeAction` (:273-275) — no
`instanceId` rewriting or rejection. The "frame-supplied instance id is never
trusted" guarantee (:189-191, header :19-22) covers subscribe only.

Latent confirmed on **both** surfaces: `WatchWidgetBody.tsx:134-144` passes no
`actions` to `WatchAppWidget`, and `WatchAppWidget.tsx:255-267` (mobile)
passes none to `WatchAppWebView` — every declared action currently falls
through `latest.current.props.actions?.[name] === undefined` → refusal. No
reachable hole today, but the bridge contract and the docstring's
authorization story silently exclude action args; the first handler that
trusts an id-shaped arg reopens the containment hole.

Fix direction: strip/forbid `instanceId` keys in action `arguments` at the
bridge (symmetric with subscribe), or explicitly document on
`WatchAppHostHandlers.invokeAction` that arguments are fully frame-controlled
and handlers must authorize against the widget binding. Downgraded to LOW:
no wired handlers, one-line doc/strip fix.

## Finding 7 — SPLIT: 7a REJECTED, 7b VERIFIED-DEFECT (LOW)

**7a (registryKey reset strands visible widgets) — REJECTED as described.**
The mechanism is real — `useWatchAppMounts` swaps in a fresh registry +
`states = {}` on `registryKey` change (`useWatchAppMounts.ts:32-38`), and the
`IntersectionObserver` effect deps `[widget.id]` (WatchAppWidget.tsx:136) mean
a surviving instance won't re-report. But the required precondition — _the
same `widget.id` persisting across a `registryKey` change_ — is unreachable:
`registryKey = ${environmentId}:${page.id}` (WatchScreen.tsx:183), widget ids
are `watch-widget:<uuid>` rows permanently bound to one `page_id`
(`WatchPageService.ts` — no `SET page_id` path exists; widgets can't move
pages keeping ids), so a page switch yields an all-new id set → new component
instances → fresh observers → initial entries re-report. An environment
switch changes both key halves; same page.id + widget.id in a different
environment would require a uuid collision. The hook's comment promise
("fresh visibility reports reseat widgets") holds only incidentally — worth a
comment-level note, not a defect.

**7b (`requestMount` seats invisible widgets) — VERIFIED-DEFECT (LOW).**
`requestMount` (watchMounts.ts:119-129) mounts any agent id with no visibility
check — it can't distinguish "visible standby" from "already unmounted"
(`setHidden` erases all knowledge). Only caller is the placeholder tap
(`WatchWidgetBody.tsx:141` → `WatchAppTapToLoad` onLoad). Race window is
narrow (tap landing between `setHidden` on the registry and the React flush
that removes the placeholder), and an evicted visible widget still has a live
seat-holder, but the missing guard is real and the fix is one line: only
`mount` when the id is in `standbyIds` (or tracked-visible), else no-op.

## Finding 8 — VERIFIED-DEFECT (LOW): byte cap enforced after full stringify

Confirmed (watchAppBridge.ts:112-118, :286): `jsonBytes` runs
`JSON.stringify` + `TextEncoder.encode` over the whole payload before the
256 KB drop — O(n) allocation+copy per oversized message, repeatable forever.
Cheap fix as suggested: early-exit on `typeof data === "string"` (measure
`data.length` directly) and/or iterate-measure with a cap.

## Finding 9 — VERIFIED-DEFECT (LOW): no cap on open subscriptions; churn restarts streams

Confirmed: up to 64 declared subscriptions per manifest
(`WidgetTranspileService.ts:253,261,374-379` — `maxBridgeDeclarations: 64` per
array) may each hold a live `WatchAppConnectorFeed` RPC stream
(`WatchAppFrame.tsx:60-89`); ×6 mounted frames ≈ 384 worst-case streams.
`unsubscribe` is free and instant (not pending-counted), so
subscribe→unsubscribe→subscribe cycles tear down/recreate server-side
`connectorStream` subscriptions at widget round-trip rate — no debounce, no
open cap beyond manifest declarations. Same for action throughput (16
concurrent, unbounded rate). Bounded blast radius as stated — LOW stands.

Fix direction: cap concurrently-open feeds below the manifest ceiling (e.g.
refuse beyond N with a violation), debounce/coalesce re-open of the same name,
and count unsubscribes/opens toward the Finding-4 rate budget.
