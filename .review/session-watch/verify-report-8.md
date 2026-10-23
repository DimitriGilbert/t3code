# Verify Report — Review Report 8: Widget transpile pipeline + packaging

Scope verified against `apps/server/src/watch/WidgetTranspileService.ts` (r/w), esbuild
0.28.2 run live with the exact `widgetBuildOptions`, `packages/client-runtime/src/
watchAppBridge.ts`, `apps/server/src/ws.ts`, `mcp/toolkits/watch/{tools,handlers}.ts`,
`watch/connectors/ConnectorService.ts`, `watch/WatchPageService.ts`, `config.ts`, and
`.plans/welcome-screen/{PRD,PLAN,DESIGN}.md`.

## Verdict counts

- VERIFIED-DEFECT: 5 (Findings 1-5)
- VERIFIED-INTENTIONAL: 0
- REJECTED: 0

## Finding 1 — VERIFIED-DEFECT (MEDIUM): non-literal `import(expr)` survives into the IIFE

Reproduced live with esbuild 0.28.2 + exact `widgetBuildOptions`
(WidgetTranspileService.ts:158-176):

- `const m = import(globalThis.X)` → build OK, emits `var m = import(globalThis.X)`
  verbatim inside the IIFE. `noImportsPlugin.onResolve` (:140-156) never fires —
  non-literal specifiers are never resolved. Record reports `status: "ready"`.
- `supported` is **not** set in `widgetBuildOptions`. The suggested fix
  `supported: { "dynamic-import": false }` is confirmed working: esbuild then lowers
  `import(expr)` to `__toESM(__require(expr))` which throws
  `Dynamic require of "..." is not supported` inside the sandbox.
- `import.meta` → `var import_meta = {}`; `require(expr)` → `__require` shim throwing
  at call time; top-level `export` → silently dropped. All yield `ready` records.
- Precision note: `logLevel: "silent"` suppresses stderr echo only; the
  `import.meta` warning is still returned in `result.warnings` — the code simply
  never inspects it (:219-239). Same silent-degrade outcome.
- CSP backstop confirmed: `watchAppContentSecurityPolicy` (watchAppBridge.ts:497-501)
  emits hash-only `script-src` plus `connect-src 'none'`, so the escaped `import()`
  degrades to a rejected promise today. The :45-50 docstring ("imports of any kind
  are rejected at build time") is false for this path.

Fix direction: add `supported: { "dynamic-import": false }`; optionally also fail the
build when `result.warnings` is non-empty or when emitted output still contains
`import(`/`import.meta`/`__require`; fix the docstring.

## Finding 2 — VERIFIED-DEFECT (MEDIUM): `transpileTimeoutMs` bounds the wait, not the work

`Effect.timeoutOrElse` (:437-448) interrupts the waiting fiber. `Effect.tryPromise`
does hand `try` an `AbortSignal` (effect-smol Effect.ts:966-971), but the call site
ignores it (`try: () => esbuild.build(...)`, :220) and `esbuild.build()` accepts no
signal — cancellation requires `esbuild.context().cancel()`, which is not used. A
timed-out or hung build keeps consuming CPU/memory in the esbuild service child with
no bound; at the 30/min cap leaked builds accumulate.

Nuance: the :432-434 comment ("the timeout bounds only a hung transpile") shows the
author knew the timeout bounds the wait; the leaked-work consequence is unaddressed
and the PRD's "transpile timeout" publish limit does not actually stop the work —
still a defect.

Fix direction: `esbuild.context()` inside `Effect.acquireRelease`, calling
`ctx.cancel()` on interruption/timeout; or latch-unavailable on timeout.

## Finding 3 — VERIFIED-DEFECT (MEDIUM): `unavailable` latch over-classifies

Confirmed: the `catch` at :221-230 maps **every** non-diagnostics `build()` rejection
to `reason: "unavailable"`; `makeTranspile` (:120-137) latches the detail permanently
— all subsequent publishes of any source fast-fail `unavailable` for the process
lifetime. Transient causes (spawn `EMFILE`/`EAGAIN`/`ENOMEM` under fd/memory
pressure, "service was stopped", esbuild panic on a pathological ≤256 KB input)
permanently disable publishing until restart, with a misattributed detail string.
The latch rationale comment (:114-118) only justifies the missing/mismatched-binary
case; the test (:113-151) covers only that intended case.

Fix direction: only latch `loadEsbuild` failure and a missing-binary signature
(ENOENT on the resolved `@esbuild/*` path); map other non-diagnostic rejections to
`failed`, or add a cooldown re-probe.

## Finding 4 — VERIFIED-DEFECT (MEDIUM): unbounded artifact store, no removal path for agent sources

Confirmed:

- `remove` (:503-538) has exactly one caller: `ConnectorService.ts:1778-1782`, inside
  human-confirmed pack purge.
- Not exposed over WS: `WS_WATCH_METHOD_TAGS` (ws.ts:604-607) and the handler group
  (:732-737) wire only `watchWidgetSourcePublish/Get/Subscribe`.
- Not exposed over MCP: `tools.ts:138-144` defines only `t3_watch_widget_source_publish`;
  `handlers.ts:21-23` calls `service.publish`.
- `WatchPageService.removeWidget` (:1053-1087) deletes the `watch_widgets` row only —
  the source record, `.js`, and `.json` persist. DESIGN.md's "Remove" affordance is
  widget-row removal, not source removal.
- No eviction/GC anywhere: `widgetArtifactsDir` (config.ts:173) is write-only; each
  publish writes `<hash>.js` plus a `<hash>.json` meta that re-embeds the full source
  (:454,:463) — up to ~0.5 MB per publish. The `records` Map (:316) also grows
  unboundedly. The 30/min cap throttles rate, not total (~15 MB/min sustained worst
  case).

Fix direction: LRU/byte-cap eviction of `*.js`+`*.json` pairs (`get`/`publish` already
tolerate missing files) and/or expose `remove` keyed to widget-source deletion.

## Finding 5 — VERIFIED-DEFECT (LOW): single global publish budget; cache hits burn it

Confirmed: `publishStamps` (:323) is one process-wide window; both the MCP handler
(handlers.ts:21-23) and the WS RPC (ws.ts:732) hit the same `publish` leg. The stamp
is appended at :390-408 **before** the `loadRecord` ready-cache-hit early return at
:420-430, so republishing a cached `{source, manifest}` — pure `loadRecord` hit, no
transpile — still spends budget. A churning agent starves all other publishers; a
retry loop self-locks doing no work.

The shared single bucket itself is arguably a deliberate simplicity choice ("bounds
agent-authored churn", :388-389); the cache-hit-burns-budget ordering is not
documented anywhere and reads as an oversight.

Fix direction: move the admission check after the ready-cache-hit early return; if
cross-caller fairness matters, key the bucket per caller identity (agent vs. client).
