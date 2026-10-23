# Verify Report 6 — Pack runtime: PackStore / PackModule / HttpTransport / FileTransport (feat/watch-screen)

Each finding of `review-report-6.md` re-checked against the sources, plus
`ConnectorPoller.ts`, `ConnectorService.ts`, `apps/server/src/config.ts`,
`packages/contracts/src/{watch,baseSchemas}.ts`, `mcp/toolkits/watch/tools.ts`,
and intent docs `.plans/welcome-screen/{PRD,PLAN,DESIGN}.md`. Escapes and
matchers were reproduced live under Node v24.21.0.

Verdict counts: **5 VERIFIED-DEFECT, 1 VERIFIED-DEFECT-but-documented-risk (F1), 0 REJECTED.**
Duplicate: F3 = report-5 F1 (already verified; independently re-confirmed below).

---

### F1 — `node:vm` realm escape via host-realm objects — VERIFIED-DEFECT, CRITICAL (but a documented non-goal; the defect is the overclaim, not the absence of an isolate)

Reproduced live with the exact `evalConnectorModule` construction
(PackModule.ts:136-144):

```
module.constructor.constructor("return process")()  → real process (v24.21.0, env readable)
console.log.constructor("return process.env.HOME")() → /home/didi
<f:any host fn in ctx>.constructor.constructor(...) → same escape
```

Injection surface is real: `module`, `exports`, `console` are host-realm values
(PackModule.ts:137-141), and at call time `ctx` is entirely host values —
`config`, `secrets.get`, `failAuthExpired`, `fetch`, `files`
(ConnectorPoller.ts:342-373). `ctx.config.__proto__` is host
`Object.prototype` → pollution of host intrinsics is also reachable.

**Threat-model check.** `.plans/welcome-screen/PRD.md:60-62` explicitly lists
"a real server-side sandbox for connector transform code (worker/isolate)" as
a v1 **non-goal**, mitigation = "declared egress allowlist + declared secret
keys + human install confirmation". PackModule.ts:27-29 repeats this. So the
_absence of an isolate_ is intentional. The defect is that the escape defeats
the named mitigations too — an approved-but-hostile pack gets `process.env`
(provider API keys; the server forwards env to agent CLIs), unrestricted
network (egress allowlist void), and host FS (`~/.t3/userdata`, secrets store),
while comments still claim "the only capabilities it sees are the ones the
runtime injects" (PackModule.ts:2-3) and "the pack's own code can never reach
an undeclared host" (HttpTransport.ts:7-9). Those claims are false. The
security model effectively reduces to "pack code is trusted once a human
clicks confirm" — the confirm dialog shows the manifest, not audited code, so
a hostile URL-installed pack reaching approval is plausible.

**Feasibility of fixes:**

- **worker_threads + structuredClone boundary** — feasible, correct fix,
  ~1-2 days. The ctx surface is small: `config`/`files` are already data
  (structured-clone them in); `secrets` resolves to declared keys — resolve
  eagerly to a Record before invocation, or make the accessor async;
  `ctx.fetch` is already async → MessagePort RPC returning serialized
  Response fields; `failAuthExpired` → return a tagged sentinel the host
  recognizes post-return. `worker.terminate()` also fixes F6's sync-spin DoS
  and makes callback timeouts real. No native deps.
- **isolated-vm** — works (true isolate, sync marshaling) but adds a native
  dependency; worker_threads is strictly better here.
- **Freeze intrinsics / membrane (SES-style)** — does NOT work. Any host
  value in the realm leaks host `Function` via `.constructor`, and every
  host-side return value (`Response` from `ctx.fetch`) re-leaks. Would
  require wrapping every crossing in realm-local proxies — fragile, reject.
- **Data-only realm in same process** — dead end: `module`/`exports`/`console`
  must be injected and leak; async fetch can't cross realms without a host
  callback (leak) or Atomics.wait hacks; sync spin is unpreemptable on the
  same thread regardless.
- **Disclaim + human-trust model** — honest minimum: rewrite the comments and
  PRD mitigation language to state plainly that approved pack code runs with
  server-user privileges; then F2/F4 become UX-reviewer aids only.

Verdict stays CRITICAL _if_ packs are meant to be semi-untrusted (the entire
egress/secret/confinement machinery implies they are). If maintainers affirm
"packs are trusted by approval", downgrade to docs-defect; the code comments
still must be fixed either way.

### F2 — runtime `ctx.fetch` egress has no resolved-IP check — VERIFIED-DEFECT, HIGH

`isHostAllowed` (HttpTransport.ts:35-46) is pure string matching;
`makeEgressFetch` (:59-91) passes the checked URL straight to `fetchImpl`
(default global `fetch`, :62/:79). No DNS resolution, no `isLocalAddress`, no
pinned `lookup`. The install path in the same codebase does full
resolve→`isLocalAddress`→`pinnedGet` (PackStore.ts:379-453, 486-497) — the
runtime path deliberately defers it ("any future DNS-pinning layer",
HttpTransport.ts:20-22). A declared host under pack-author DNS →
169.254.169.254/127.0.0.1/10.x, or post-approval rebind. Carries
manifest-declared secrets to attacker IP space behind an innocuous hostname.
Stands independently of F1: matters for benign packs whose declared host is
hijacked, and for the human-approval signal itself. Fix: reuse
`ConnectorPackFetch`'s resolve→check→pin pipeline for runtime egress.

### F3 — `packDirName` keeps `.` — `id:".."` escapes `connectorsDir` — VERIFIED-DEFECT, HIGH (dup of report-5 F1)

Re-confirmed live: `"..".replace(/[^A-Za-z0-9._-]/g,"_")` === `".."`.
`WatchConnectorPackId` is branded `TrimmedNonEmptyString` (baseSchemas.ts:310-312,
412; watch.ts:436) — `".."` decodes. `connectorsDir = join(stateDir,"connectors")`
(config.ts:172), so `installedPackDir("..")` → `stateDir/<hash>` writes at
confirm (materializeBundle PackStore.ts:630, via ConnectorService.ts:503), and
`removeInstalled("..")` → `fs.remove(stateDir, {recursive,force})` — deletes
statev2.sqlite, secrets/, settings (PackStore.ts:694-696, called from
purgeInstanceData ConnectorService.ts:1783). `id:"."` wipes `connectorsDir`.
`requestInstall` stores `bundle.manifest.id` unchecked
(ConnectorService.ts:1100). Fix as report-5 F1: reject dot-only/non-slug ids
at bundle acceptance + resolve-and-confine assert on the dir path.

### F4 — `egressHosts: ["*."]` is a disguised allow-all — VERIFIED-DEFECT, MEDIUM

Live: `isHostAllowed("evil.example.", ["*."])` === `true`;
`new URL("https://evil.example./").hostname` preserves the trailing dot, and
trailing-dot names resolve/connect normally. `"*."` is schema-valid
(`TrimmedNonEmptyString`, watch.ts:441). Same class of bug: `*.com` /
`*.co.uk` are public-suffix wildcards granting a whole TLD. Fix: validate
`egressHosts` at manifest decode — reject empty wildcard suffix
(`"*"`, `"*."`), require plausible hostname entries, flag public-suffix
wildcards; normalize a trailing dot off `url.hostname` before matching so the
allowlist can't be bypassed by `host.` spelling.

### F5 — file-transport `watch.roots` agent-writable, no human gate — VERIFIED-DEFECT, MEDIUM

`parseFileWatchConfig` (FileTransport.ts:62-72) accepts any non-empty strings
as roots — `/`, `~/.t3/userdata`, `/proc`, `~/.ssh` all pass; `path.resolve`
only absolutizes. Confinement (FileTransport.ts:203-213) blocks symlink
escapes _out of_ a root, never the root itself. `config_set` is an
agent-reachable MCP tool (tools.ts:98-104, registered :154) and
`setInstanceConfig` (ConnectorService.ts:798-853) has no human-confirm leg —
PRD's own service table marks instance config "standard / agent yes".
Default glob `["**"]` matches dotfiles (`*` → `[^/]*`, globToRegExp :113-141).
procfs-style files report `stat.size === 0` → evade the 256KB cap at :231.
Delta over "the agent can read files anyway": contents flow into durable
snapshot rows and publish to every subscribed surface incl. remote/tunnel
clients, and the agent's own FS tools may be project-scoped while the server
is not. Fix: gate `watch.roots` changes behind human confirm (or a manifest
root allowlist); denylist `/proc`,`/sys`,`/dev`, stateDir; read with a byte
cap instead of trusting `stat.size`.

### F6 — pack callbacks untimed; `migrateConfig` can wedge confirm — VERIFIED-DEFECT, MEDIUM

`invokePackFunction` is a bare `Effect.tryPromise` (PackModule.ts:210-212;
comment admits untimed). `runConfigMigration` invokes it with only
`Effect.result` — no timeout (ConnectorService.ts:1058-1060): a never-settling
`migrateConfig` suspends the confirm/rollback fiber forever. In the poller,
`Effect.timeout(RUN_TIMEOUT)` (ConnectorPoller.ts:385) bounds the wait but
leaves the pack promise running detached; piled-up runs accumulate. Worst
case — synchronous `while(1){}` inside an `async` callback — freezes the
event loop; no timeout preempts running JS. Unfixable without F1's isolate
(worker.terminate()); interim: wrap `runConfigMigration` in `Effect.timeout`
→ `kind:"failed"`, document callbacks as unbounded.

## Minor notes spot-check

- `materializeBundle` write-side symlink-follow (PackStore.ts:647-653) and the
  realPath→stat→read TOCTOU (FileTransport.ts:203-237, PackStore.ts:157-196)
  confirmed as written — real but require local FS-write in the tree; minor.
- `__proto__` bundle-file wedge confirmed by reading `hashPackFiles`
  (PackStore.ts:68-77) vs `readLocalBundle`'s `files[entry] = content`
  assignment (:217) — proto setter drops non-object values; installed pack
  then fails re-hash forever. Minor, self-DoS only.
- No byte cap on `ctx.fetch` responses confirmed (HttpTransport.ts:79-90 —
  signal + redirect only). Minor.

## Summary for primary agent

| #                             | Verdict         | Severity                                                                                                                                                        |
| ----------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 vm escape                  | VERIFIED-DEFECT | CRITICAL (isolation itself is a documented v1 non-goal — PRD.md:60-62; defect = overclaimed mitigations/comments; real fix = worker_threads, feasible in-scope) |
| F2 egress no-IP-check         | VERIFIED-DEFECT | HIGH                                                                                                                                                            |
| F3 packDirName `..`           | VERIFIED-DEFECT | HIGH (dup report-5 F1)                                                                                                                                          |
| F4 `"*."` allow-all           | VERIFIED-DEFECT | MEDIUM                                                                                                                                                          |
| F5 agent-writable watch roots | VERIFIED-DEFECT | MEDIUM                                                                                                                                                          |
| F6 untimed callbacks          | VERIFIED-DEFECT | MEDIUM                                                                                                                                                          |
