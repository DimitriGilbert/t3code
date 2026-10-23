# Review Report 6 — Pack runtime: store, module sandbox, transports (feat/watch-screen)

Scope: `apps/server/src/watch/connectors/{PackStore,PackModule,HttpTransport,FileTransport}.ts`,
cross-checked `packages/contracts/src/{watch,baseSchemas}.ts`, `ConnectorPoller.ts`,
`ConnectorService.ts`, `mcp/toolkits/watch/tools.ts`. Two escapes were verified by executing the
actual code paths under Node 24.

## Verified sound (no findings)

- **URL install fetch**: DNS pinning is real — `pinnedGet` installs a `lookup` override returning
  exactly the range-checked address list, so the socket connects to the IPs that were vetted (no
  resolve→connect TOCTOU). Every redirect hop re-parses, requires `https:`, re-resolves, and
  re-checks private ranges; hop cap enforced; body capped at 2MB mid-stream. WHATWG parsing
  normalizes decimal/octal/hex IPv4 literals and IPv4-embedded forms; mapped/NAT64/6to4
  extraction and recursive re-check of the embedded IPv4 is correct; own-interface addresses are
  also blocked. IPv6 literals in URLs carry `[…]` brackets so `isIP` fails → DNS fails →
  fail-closed.
- **Redirect model for `ctx.fetch`**: `redirect: "manual"` is applied _after_ `...init`, so pack
  code cannot re-enable auto-follow; pack-driven hops are re-gated per call.
- **Pack file paths**: `isSafePackPath` rejects `/`, `\`, `..`, empty segments, drive letters,
  NUL; `manifest.json` in a URL bundle is refused so it cannot shadow the synthesized canonical
  manifest; per-file/bundle/count caps enforced during collection.
- **Storage**: re-hash on every `loadInstalled` refuses tampered bytes (fail closed); pack
  symlinks escaping the pack dir are rejected via `realPath` prefix check; `contentHash` is never
  a client-supplied RPC field, so `installedPackDir`'s unvalidated hash segment isn't directly
  injectable.
- **Secrets accessor**: undeclared keys throw before any value is touched.
- **Poll loop**: run-level `Effect.timeout(60s)` bounds pipeline wait; file caps/depth enforced
  mid-walk (iterative stack, realpath confinement fails the whole run closed); watcher failures
  are non-fatal and interval polling still applies.

## Findings

### [SEVERITY: CRITICAL] Finding 1: the `node:vm` realm is escaped by a one-liner — injected host objects hand pack code `process`, collapsing every mitigation

**File**: apps/server/src/watch/connectors/PackModule.ts:134-145 (sandbox), 136-141 (`module`/`exports`/`console` are host objects), ConnectorPoller.ts:342-373 (`ctx` host functions/objects)
**Problem**: The sandbox globals `module`, `exports`, and `console` are created in the _host_
realm. Any host object reachable inside the vm leaks host-realm `Function` via
`.constructor`, which compiles code in the host realm with full globals. Verified live:
`module.constructor.constructor("return process")()` returns the server's real `process`;
`console.log.constructor(...)` works identically. The same applies at call time:
`ctx.secrets.get`, `ctx.fetch`, `ctx.failAuthExpired`, `ctx.config`, `ctx.files` are all host
values, so even a hypothetical empty global object is escaped.
**Evidence**: `node -e` repro of the exact `evalConnectorModule` construction yields
`{ viaModule: 'v24.21.0', envLeak: '/home/didi' }`. Once out: `process.env` (provider API keys —
the server forwards its env to agent CLIs), `process.binding("fs")`/other bindings (arbitrary FS
read/write incl. `~/.t3/userdata` sqlite + file-backed secret store), `process.kill`,
`process.exit`, and unrestricted networking — bypassing the egress allowlist, declared-secret
scoping, file confinement, and all size caps simultaneously. Pack code can also pollute host
`Object.prototype` through `ctx.config.__proto__`, corrupting unrelated server code. A callback
that spins synchronously (`while(1){}`) freezes the entire event loop — `EVAL_TIMEOUT_MS` covers
only module eval, and `Effect.timeout` cannot preempt running JS.
**Impact**: A human-approved-but-hostile pack executes arbitrary code as the server user. The
file's own comment — "there is deliberately no `require`, `process`, `fetch`" and the PRD's
"declared egress allowlist" mitigation — is false: every capability the design claims to withhold
is reachable in one line. This is the boundary the whole connector security model rests on.
**Suggestion**: Either treat pack code as trusted-by-approval and remove the sandbox claims
(honest but weak), or run packs in a real isolate — `worker_threads` with a structured-clone
boundary or `isolated-vm` — where `ctx` crosses as serialized data and host functions never
enter the realm. Wrapping host functions inside the realm does not fix it (returned host objects
like `Response` re-leak constructors); only a data-only boundary does.

### [SEVERITY: HIGH] Finding 2: `ctx.fetch` egress gate checks only the hostname string — a declared host resolving to a private/link-local IP reaches internal services

**File**: apps/server/src/watch/connectors/HttpTransport.ts:35-46 (`isHostAllowed`), 59-91
(`makeEgressFetch` passes the checked URL straight to `fetchImpl`)
**Problem**: The egress gate validates `url.hostname` against `egressHosts` and then calls global
`fetch` — no DNS resolution check, no private-range blocklist, no IP pinning. `PackStore`'s
`isLocalAddress`/pinned-`lookup` machinery guards _install_ URLs but is not applied to _runtime_
egress. A pack declares `egressHosts: ["svc.example.com"]`; the pack author controls that DNS and
points it at `169.254.169.254` (cloud metadata), `127.0.0.1`, or `10.x` — or flips it post-approval
(DNS rebinding). The request sails through the allowlist.
**Evidence**: `makeEgressFetch` contains no address logic at all; `isHostAllowed` is pure string
matching (HttpTransport.ts:76-90). The comment at HttpTransport.ts:20-22 defers this explicitly:
"any future DNS-pinning layer".
**Impact**: SSRF to loopback/private/link-local/cloud-metadata endpoints under a fully normal,
human-approved manifest — the runtime counterpart of the install-time SSRF the same codebase
defends with a DNS-pinned blocklist. Worse than install-time: egress requests can carry
manifest-declared secrets (`ctx.secrets.get`) to attacker-chosen IP space behind an
innocent-looking hostname.
**Suggestion**: Reuse `ConnectorPackFetch`'s resolve→`isLocalAddress`→pinned-connect pipeline for
runtime egress (an `allowLocal` carve-out is unnecessary — no legit reason for connector egress to
loopback), or at minimum resolve once per request, block `isLocalAddress` hits, and pin the
connection to the checked addresses.

### [SEVERITY: HIGH] Finding 3: `packDirName` does not neutralize `.`/`..` — manifest `id` escapes `connectorsDir`; purge deletes the state directory

**File**: apps/server/src/watch/connectors/PackStore.ts:603 (sanitizer), 605-609
(`installedPackDir`), 631-654 (`materializeBundle` writes), 688-702 (`removeInstalled`)
**Problem**: `packId.replace(/[^A-Za-z0-9._-]/g, "_")` keeps `.` — `id: ".."` survives verbatim and
`id` is only `TrimmedNonEmptyString` (watch.ts:436, baseSchemas.ts:310). `materializeBundle` then
writes pack files under `<connectorsDir>/../<hash>/` = a sibling inside `stateDir`;
`removeInstalled("..")` recursively deletes `stateDir` (sqlite, `secrets/`, everything);
`loadInstalled` reads outside. (Independently reported by cluster 5 — included here since the
sanitizer and all three sink sites are in this file's scope.)
**Impact**: Arbitrary write outside `connectorsDir` at confirm time; full server-state destruction
on the human-confirmed uninstall→purge path.
**Suggestion**: Reject ids not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` plus a `^[.]+$` exclusion at
bundle decode — or hash the id for the directory name and drop sanitization entirely.

### [SEVERITY: MEDIUM] Finding 4: `egressHosts: ["*."]` is a disguised allow-all — bare wildcard-dot matches every trailing-dot hostname

**File**: apps/server/src/watch/connectors/HttpTransport.ts:40-43
**Problem**: `rule.startsWith("*.")` → `suffix = rule.slice(2)`; for the entry `"*."` the suffix is
`""`, so the test degrades to `host.endsWith(".")`. WHATWG URL parsing preserves a trailing dot on
domain hostnames (`new URL("https://evil.example./").hostname === "evil.example."` — verified), and
trailing-dot names resolve and connect normally. `egressHosts` is `Schema.Array
(TrimmedNonEmptyString)` — `"*."` is schema-valid. A manifest burying `"*."` in a long egress list
grants the pack egress to _every_ host while the confirm dialog shows an innocuous two-character
entry.
**Evidence**: `isHostAllowed("evil.example.", ["*."]) === true` (verified); `isHostAllowed
("example.com", ["*."]) === false`, so the bypass needs the trailing-dot form — which is exactly
what makes it deceptive.
**Impact**: Allowlist semantics silently become allow-all; defeats the human-approval signal for
the highest-risk manifest field.
**Suggestion**: Validate `egressHosts` entries at manifest decode — require each entry to be a
plausible hostname (no bare `*.` or empty suffix; reject/flag public-suffix wildcards like
`*.com`); or reject `suffix.length === 0` and treat trailing-dot hostnames as normalized.

### [SEVERITY: MEDIUM] Finding 5: file-transport `watch.roots` are agent-controlled with no human gate — the "allowlisted roots" boundary isn't one

**File**: apps/server/src/watch/connectors/FileTransport.ts:53-106 (`parseFileWatchConfig` accepts
any absolute paths), 159-247 (collection confined only to _resolved_ roots);
apps/server/src/mcp/toolkits/watch/tools.ts:98-104 (`t3_watch_connector_instance_config_set` is
agent-reachable)
**Problem**: The human approves `transport: "file"` in the manifest, but the _roots_ — the actual
allowlist — live in instance config, which agents write via `setInstanceConfig`/`config_set` with
no confirmation. An agent can repoint an approved file connector at `/`, `~/.t3/userdata`
(file-backed secret store + sqlite), `~/.ssh`, or `/proc`/`/sys`. Confinement only prevents
symlink escapes _out of_ the declared root — the root itself is unrestricted, and globs default to
`**` (dotfiles included: `*` is `[^/]*`). Virtual fs files report `size 0`, so `/proc` entries
(e.g. `environ`) evade the per-file byte cap at stat time.
**Impact**: The connector becomes an arbitrary-file-read-into-snapshot pipeline: collected
contents reach pack `transform` and the persisted/widget-published snapshot. A local agent can
read these files directly anyway, but the channel puts raw secrets/keys into durable instance
data and onto every connected surface (remote/tunnel clients included) — a real disclosure
widening, and the docstring's "allowlisted roots" framing overstates the boundary.
**Suggestion**: Gate `watch.roots` changes on the same human-confirm path as install (or at least
a one-time root allowlist in the manifest); reject `/proc`, `/sys`, `/dev`, and the server's own
`stateDir`; read with a byte cap rather than trusting `stat.size` (stream + cut at
`MAX_WATCH_FILE_BYTES`).

### [SEVERITY: MEDIUM] Finding 6: pack callbacks run untimed — `migrateConfig` can hang confirm forever and any callback can freeze the event loop

**File**: apps/server/src/watch/connectors/PackModule.ts:210-212 (`invokePackFunction` — no
timeout; comment admits "async pack calls are untimed"), ConnectorService.ts:1058-1060
(`runConfigMigration` invokes it bare), ConnectorPoller.ts:385 (`runPipeline` caps at 60s but
can't kill the underlying promise)
**Problem**: `invokePackFunction` is a bare `tryPromise`. In the poller the 60s
`Effect.timeout` fails the _run_ but the pack's promise keeps executing (and repeated runs pile
up detached promises). In `runConfigMigration` there is no timeout at all — a `migrateConfig`
that never settles wedges the confirm/rollback indefinitely. Worst case is a _synchronous_ spin
inside an `async` callback: it executes as a host microtask, `EVAL_TIMEOUT_MS` doesn't apply
(eval already returned), and no timeout can preempt running JS — the whole server stalls.
**Impact**: Permanent pipeline/confirm hang or full event-loop DoS from an approved pack; note
this is unfixable without Finding 1's real isolate — the finding is that the code's timeout
claims ("Bounds synchronous module evaluation") don't extend to callbacks where all the work
happens.
**Suggestion**: Document that pack callbacks are unbounded pending an isolate; at minimum wrap
`runConfigMigration` in a timeout so a hung migrator fails the migration (`failed`) instead of
the request; keep run bookkeeping consistent about detached promises.

## Minor (below threshold, noted for completeness)

- `materializeBundle` (PackStore.ts:647-653) writes with `writeFileString`, which follows a
  pre-planted symlink inside `<connectorsDir>/<id>/<hash>/` → pack file bytes land outside
  (write-side not self-confined; only read-side re-hash catches it after the damage). Write via
  temp-file + rename or `O_NOFOLLOW`; also re-assert `isSafePackPath` on names defensively.
- realPath→stat→read TOCTOU in `collectWatchedFiles` (FileTransport.ts:203-237) and
  `readLocalBundle` (PackStore.ts:157-196): an adversary who can rename an ancestor dir inside the
  root to a symlink between `realPath` and `readFileString` escapes confinement. Requires local
  FS-write in the watched tree; same caveat applies to `fs.watch` watching the _declared_ path
  while collection uses `realRoot` (retargeted symlink silently re-scopes the watch).
- File size is checked via `stat.size` before read (FileTransport.ts:231): a file growing between
  stat and read exceeds `MAX_WATCH_FILE_BYTES`; procfs-style files report 0 and evade it entirely.
- URL-install wedge: a bundle file named `__proto__` survives `{...wire.files}` as an own property
  (included in `contentHash`) but `readLocalBundle`'s `files[entry] = content` assignment drops it
  (proto setter ignores non-objects) → `loadInstalled` fails `hashMismatch` forever; the pack
  installs but can never run.
- `packDirName` collisions: `a/b` and `a_b` share a directory; `removeInstalled` on one deletes
  the other's pinned versions → `hashMismatch`/`packNotFound` wedge until reinstall.
- `ctx.fetch` responses have a timeout but no byte cap — a declared host can stream unbounded
  data into a pack `Response.text()`; only the post-transform snapshot is capped. Same for
  `ctx.files` total (512 × 256KB ≈ 128MB held per run; no aggregate cap).
- `isLocalAddress` doesn't extract ISATAP (`::200:5efe:w.x.y.z`)-style embedded IPv4 — obscure;
  needs local ISATAP routing to matter.
