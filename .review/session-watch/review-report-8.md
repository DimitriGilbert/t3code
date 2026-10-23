# Review Report — Cluster 8: Widget transpile pipeline + packaging

Scope: `apps/server/src/watch/WidgetTranspileService.ts` (+ `.test.ts`), `apps/server/package.json`,
`scripts/lib/cli-external-packages.ts` (+ `.test.ts`), `scripts/build-desktop-artifact.ts` (+ `.test.ts`).
Cross-checked: `packages/client-runtime/src/watchAppBridge.ts` (prelude JSX/CSP contract),
`apps/server/src/config.ts`, `ws.ts`, `mcp/toolkits/watch/{tools,handlers}.ts`,
`auth/RpcAuthorization.ts`, `orchestration-v2/runtimeLayer.ts`, `scripts/build-cli-archive.ts`,
`apps/server/vite.config.ts`. Empirically verified esbuild 0.28.2 output for every import vector
using the exact `widgetBuildOptions`.

## Verified solid

- **Import rejection (literal forms):** static `import`/`export from`, literal `import("x")`
  (incl. `data:`/URL specifiers), `require("x")`, `require.resolve` — all reach
  `noImportsPlugin.onResolve` and fail the build → `transpileFailed` record. Verified live.
- **Top-level await** → esbuild errors under `format: "iife"` → `failed` record. TLA cannot escape.
- **`eval`/`new Function`** are emitted verbatim but CSP has no `'unsafe-eval'`; `new Worker(blob:)`
  is covered by `worker-src → script-src` fallback (hash-only). No code-gen escape.
- **JSX contract matches the prelude:** esbuild `jsx: "transform"` + `jsxFactory: "T3.h"` /
  `jsxFragment: "T3.Fragment"` emits `T3.h(type, props, ...children)`; prelude `h` slices args
  from index 2, recurses arrays in `append`, maps `type === Fragment` (string `"t3-watch-fragment"`)
  to a `DocumentFragment`, and `T3.render` accepts element-or-component. Byte-level output checked.
- **Hash chain is correct:** `artifactHash = sha256(canonicalManifestJson + "\0" + source)` binds
  inputs (JSON escapes `\0`, so concatenation is unambiguous); `scriptHash = sha256Base64(emitted
bundle)` binds the bytes actually served, so a post-publish `.js` tamper fails CSP closed (dead
  widget, not injection). `artifactHash` is schema-hex before any `path.join` — planted meta test
  confirms no traversal. Cache poisoning needs a sha256 collision or FS write (out of scope).
- **`transpileFailed` cannot be conflated:** non-ready records return `bundle: null` and
  `scriptHash: null`; a `ready` meta whose `.js` vanished degrades on both `get` and republish;
  `watchAppContentSecurityPolicy` throws on a non-base64 hash, so a failed record can never
  produce a document.
- **`</script>`/`<!--` inside the bundle** truncates its own script block → hash mismatch → dead
  widget (fail-safe, as documented in `buildWatchAppDocument`).
- **Limits fire before esbuild:** manifest-count → source-bytes → rate-limit → hash → cache —
  cheap checks first, esbuild last. Stamps array is bounded.
- **Packaging is correct:** `esbuild` + `@esbuild/` in `CLI_RUNTIME_EXTERNAL_PREFIXES`;
  `vite.config.ts` wires `neverBundle`/`alwaysBundle`; `selectCliRuntimeExternalDependencies`
  picks `esbuild` for both the desktop sidecar and the CLI archive's hoisted `node_modules`;
  stage `supportedArchitectures` lands the _target's_ `@esbuild/<os>-<arch>` while
  `allowBuilds: {esbuild:false}` suppresses only the host postinstall — safe because the binary
  ships via the optional dep, and the postinstall is merely a validator/fallback downloader.
  Repo `pnpm-workspace.yaml` keeps `esbuild: true` for dev. Emitted-artifact scans
  (`findInlinedExternalPackages`, `findEsmImportsOfExternalPackages`) cover both directions.
- `createRequire(import.meta.url)` is the right SEA-safe load; `import type * as Esbuild` is
  erased so no file-backed specifier reaches the exe-import scan.
- `Effect.cached` caches the `loadEsbuild` _failure_ too (vendored effect caches `Exit`), and
  `makeTranspile` latches it — intended fast-fail.
- `subscribe` acquires before `loadRecord` (no missed publish); tombstones carry `sourceId`.

## Findings

### [SEVERITY: MEDIUM] Finding 1: Non-literal `import()` bypasses the build-time import ban — CSP is the only backstop

**File**: apps/server/src/watch/WidgetTranspileService.ts:140-156 (plugin), :45-50 (overstated docstring)
**Problem**: `noImportsPlugin` only sees imports esbuild _resolves_. A non-literal dynamic import —
`import(someVar)` — is not resolvable, so esbuild emits it verbatim into the IIFE. Verified:
`const m = import(globalThis.X)` compiles to `var m = import(globalThis.X)` inside the artifact.
Dynamic `import()` is legal in classic scripts, so the artifact is `status: "ready"` yet performs
a live module-specifier fetch at runtime.
**Evidence**: Same class of silent "ready-but-broken" outcomes, all under `logLevel: "silent"`
which swallows the explaining warnings: `import.meta` → esbuild substitutes `var import_meta = {}`
(warning suppressed); `require(expr)` → emitted `__require` shim that throws at call time;
top-level `export` → silently dropped. The docstring ("imports of any kind are rejected at build
time, so a source can never … defer to modules that do not exist") is false for these paths.
**Impact**: Not a sandbox escape _today_ — hash-only `script-src` blocks every URL the import could
resolve to (`https:`, `data:`, `blob:`), so it degrades to a rejected promise. But the stated
security invariant is actually provided by the CSP layer, not the build: any consumer that ever
serves the artifact under a weaker policy (a WebView ignoring meta CSP, a future `script-src`
relaxation) inherits a live egress primitive in hash-authorized code.
**Suggestion**: `supported: { "dynamic-import": false }` — verified: esbuild then lowers
`import(expr)` to `Promise.resolve().then(() => __toESM(__require(expr)))`, which throws
("Dynamic require of … is not supported") in the sandbox. Additionally consider failing the build
when the emitted output still contains `import(`/`import.meta`, or surfacing esbuild warnings into
the record (a `warnings` field or appended to `failure.detail` only when status flips).

### [SEVERITY: MEDIUM] Finding 2: `transpileTimeoutMs` bounds the caller's wait, not the esbuild work

**File**: apps/server/src/watch/WidgetTranspileService.ts:435-449
**Problem**: `Effect.timeoutOrElse` wraps `transpiler.transpile`, which is `Effect.tryPromise` over
`esbuild.build(...)`. Interrupting the fiber abandons the promise but cannot cancel the build —
esbuild's Go-side child-process work keeps running to completion (or forever) after the 10 s
deadline. There is no canceler, no `context().cancel()`, and no service teardown.
**Impact**: A pathological ≤256 KB source that hangs or pathologically slows esbuild consumes real
CPU/memory well past its timeout; at 30 publishes/minute sustained, leaked in-flight builds
accumulate inside the shared esbuild service process with no bound — a slow server-side resource
leak the "10 s limit" claim does not actually prevent.
**Suggestion**: Use `esbuild.context(buildOptions)` inside `Effect.acquireRelease` /
`tryPromise` with a canceler calling `ctx.cancel()` (esbuild supports build cancellation), so the
timeout actually stops the work; or on timeout, tear down and latch the transpiler unavailable
(rather than letting a wedged service process accumulate requests forever).

### [SEVERITY: MEDIUM] Finding 3: The `unavailable` latch over-classifies — one transient esbuild error disables transpiles until restart

**File**: apps/server/src/watch/WidgetTranspileService.ts:120-137, 219-230
**Problem**: The latch's premise is "a missing/mismatched platform binary cannot appear
mid-process". But the classifier maps _every_ non-diagnostic `build()` rejection to
`reason: "unavailable"` (line 227-230) — that includes transient causes: `EMFILE`/`EAGAIN` on
service spawn under fd pressure, OOM in the esbuild service child, an esbuild panic on a
pathological input, or a one-off wedged service. `makeTranspile` then latches the detail string
forever; every later publish of _any_ source fast-fails `transpileFailed`/`unavailable` for the
life of the server process.
**Impact**: A single transient resource failure permanently disables widget publishing
(MCP + WS) until server restart, and the stored detail misattributes the cause ("The esbuild
platform binary could not run") — hard to diagnose from the record.
**Suggestion**: Only latch verifiably-permanent failures — the `require("esbuild")` throw and a
missing-binary signature (ENOENT against the resolved `@esbuild/*` path). Treat other
non-diagnostic build errors as `failed` (per-source), or bound the latch with a re-probe
(e.g. `cachedInvalidateWithTTL`-style retry on the next publish after a cooldown).

### [SEVERITY: MEDIUM] Finding 4: Artifact store growth is unbounded and agent-published sources have no removal path

**File**: apps/server/src/watch/WidgetTranspileService.ts:412-418, :471-477; apps/server/src/ws.ts:604-607,732-737; apps/server/src/mcp/toolkits/watch/tools.ts:138-144
**Problem**: Every distinct `{manifest, source}` pair writes a permanent `<hash>.js` plus a
`<hash>.json` meta that re-embeds the full source (~0.5 MB worst case per publish, since
`TrimmedNonEmptyString` manifest names carry no length cap either). `remove` exists but is
reachable only from connector-pack purge (`ConnectorService.ts:1778-1782`) — no RPC method and no
MCP tool exposes it, so anything an agent (or user client) ever `publish`es is retained forever,
in `widgetArtifactsDir` and in the in-memory `records` map. The 30/minute cap throttles rate, not
total: ~15–30 MB/minute sustained, indefinitely.
**Impact**: Slow disk exhaustion of the server state dir plus unbounded growth of the `records`
Map — a hostile or merely enthusiastic agent accumulates garbage with no way back (the "reverse
states" rule: publish has no unpublish for agent-authored sources).
**Suggestion**: Bound the artifact dir — e.g. LRU/byte cap evicting oldest `*.js`+`*.json` pairs
(the code already tolerates missing files: `get` degrades, `publish` rebuilds) — and expose
`remove` (or hook it to widget-row deletion) for agent-authored sources so there is a way out.

### [SEVERITY: LOW] Finding 5: One global publish budget — a churning agent starves every publisher, and cache hits burn budget

**File**: apps/server/src/watch/WidgetTranspileService.ts:390-408, :420-430
**Problem**: `publishStamps` is a single process-wide window shared by the MCP tool and the
`watchWidgetSource.publish` WS RPC (operate scope). One agent publishing 30 widgets/minute denies
the tool to all other agents _and_ to user-driven publishes for the whole window. Additionally the
stamp is consumed before the cache lookup, so republishing an already-cached `{source, manifest}`
(a pure `loadRecord` hit, no transpile) still spends budget — a retry/polling loop exhausts the
cap doing no work at all.
**Impact**: Cross-caller availability DoS; benign retries can self-lock an agent out.
**Suggestion**: Key the bucket per caller identity (or at least separate agent vs. client budgets),
and move the admission check after the `ready`-cache-hit early return so cache hits are free.

## Notes (checked, no finding)

- Navigation/exfiltration through the sandbox (`location.href`, `<meta refresh>`, `<a>` clicks)
  is a real residual but is owned by Cluster 9's report (`review-report-9.md` Finding 1, HIGH) —
  not duplicated here.
- `artifactHash` does not include the transpiler version or `widgetBuildOptions`: after an esbuild
  upgrade, previously published sources keep serving artifacts emitted by the old compiler
  (self-consistent — `scriptHash` always matches the stored file). Cosmetic staleness; consider a
  transpiler-version salt in the hash if artifact bytes must track the compiler.
- `writeFileAtomic` uses a fixed `<target>.tmp` name; concurrent publishes of the same input can
  collide on the temp file — harmless because identical inputs yield identical bytes.
- `remove` vs. concurrent `publish` of the same sourceId can leave an orphan `.js` or a record
  whose files were deleted — the `get`/`publish` rebuild paths already converge it; low-value race.
- `publishTrusted` bypasses the rate cap as documented and is never exposed over RPC/MCP — only
  `ConnectorService` pack install calls it (`ConnectorService.ts:1021`).
- Subscribe buffers use `PubSub.unbounded`; a stalled subscriber accumulates full records
  (~256 KB each) — bounded by the 30/min publish cap in practice.
