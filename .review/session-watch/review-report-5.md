# Review Report 5 — ConnectorService + ConfirmationTokens (feat/watch-screen)

Scope: `apps/server/src/watch/connectors/{ConnectorService,ConfirmationTokens}.ts`, cross-checked
`PackStore.ts`, `PackModule.ts`, `apps/server/src/mcp/toolkits/watch/{tools,handlers}.ts`,
`apps/server/src/auth/RpcAuthorization.ts`, `packages/contracts/src/{watch,auth,clientRpcPermissions}.ts`,
migration `065_WatchConnectors.ts`.

## Verified sound (no findings)

- **Token store**: `Ref.modify` makes consume atomic; tokens are 192-bit random, single-use,
  bound to `(requestId, manifestHash)`, 5-min TTL, memory-only. Wrong-binding/expiry/reuse all burn
  the token in the same step — replay/race across requests is correctly impossible.
- **Confirm pin**: `confirmRequest` re-hashes `manifest_json`, consumes the token, re-fetches the
  origin, requires `contentHash === row.content_hash` before materializing — approved bytes are the
  installed bytes. Agent-supplied `allowLocalUrl` is stripped before storage/fetch.
- **Upgrade ordering**: the `approved_max` recheck _is_ inside the write transaction
  (ConnectorService.ts:1378-1391) and precedes both the pack insert and the instance re-pin — a stale
  request cannot re-pin over a newer approved version. Covered by test at ConnectorService.test.ts:500.
- **SSRF**: DNS-pinned sockets (`ConnectorPackFetch.lookup`), per-redirect-hop https + private-range
  re-check, IP-literal/embedded-IPv4 (NAT64, 6to4, mapped) handling, 2MB cap — solid.
- **Agent reachability** (verified in `handlers.ts`): agents get list/create/update/delete/
  setInstanceConfig/requestInstall/requestUpgrade/rollback/uninstall — _no_ prepare/confirm/purge
  tools. MCP errors are scrubbed to a generic message via `unavailable`.
- **Secrets**: only manifest-declared keys may be written (`undeclaredSecretKey`), values go to the
  file-backed store namespaced per instance, never into `config_json` or responses; `resolveSecrets`
  intersects declared∩configured; `makeSecretsAccessor` throws on undeclared keys.
- **Purge token**: binds to a recomputed descriptor (versions + instance ids + widget source ids);
  any state change between prepare and purge invalidates it. Destructive ops are ordered
  off-DB-first so a failure leaves rows restorable.

## Findings

### [SEVERITY: HIGH] Finding 1: `packDirName` does not neutralize `.`/`..` — a crafted manifest `id` escapes `connectorsDir`, and purge deletes the entire T3 state directory

**File**: apps/server/src/watch/connectors/PackStore.ts:603 (sanitizer), 605-609 (`installedPackDir`), 688-702 (`removeInstalled`)
**Problem**: `packDirName` replaces `[^A-Za-z0-9._-]` — `.` is allowed, so a manifest `id` of `..`
survives verbatim. `installedPackDir` then resolves `<connectorsDir>/../<contentHash>` = a sibling
of `connectorsDir` inside `stateDir`. `removeInstalled("..")` resolves `<connectorsDir>/..` =
**`stateDir` itself** and `fs.remove(..., {recursive: true})` deletes the whole state dir: SQLite DB,
`secrets/`, logs — everything (`connectorsDir = join(stateDir, "connectors")`, config.ts:172).
`id: "."` maps to `connectorsDir` itself → purge wipes all packs.
**Evidence**: `WatchConnectorPackManifest.id` is only `TrimmedNonEmptyString` (watch.ts:436 →
baseSchemas.ts:310) — `..` is schema-valid and agent-controlled via `requestInstall`. Nothing else
validates pack ids before they reach fs paths. Materialization at confirm writes the bundle outside
`connectorsDir` (`<stateDir>/<hash>/`); `loadInstalled` likewise reads outside.
**Impact**: Full destruction of server state (DB + all secrets) via the human-confirmed
install→uninstall→purge chain on a pack whose only anomaly is `id: ".."` — easy to miss in a confirm
dialog. Write-outside-sandbox at confirm alone is already an integrity break.
**Suggestion**: Reject `.`/`..`/dot-only names (or any id not matching e.g.
`^[A-Za-z0-9][A-Za-z0-9._-]*$` with a `^[.]+$` exclusion) at bundle decode in PackStore, and/or hash
the pack id for the directory name instead of sanitizing.

### [SEVERITY: HIGH] Finding 2: `confirmInstall` silently overwrites an already-approved `(packId, schemaVersion)` row with different content — approved-version pins are not immutable

**File**: apps/server/src/watch/connectors/ConnectorService.ts:1393-1411
**Problem**: The pack insert is `ON CONFLICT (pack_id, schema_version) DO UPDATE` with no equality
check. Unlike upgrades (guarded by the `approved_max` recheck), an _install_ request for an
already-approved version carrying a different `content_hash`/`manifest_hash` silently replaces the
approved manifest+hash for that version.
**Evidence**: Agent runs `requestInstall` on a bundle with `id = <installed pack>`, same
`schemaVersion`, different code/manifest; human confirms (no `diffBase` is produced for installs —
ConnectorService.ts:1267-1274 — so nothing signals "version already approved"). Result: existing
instances keep `content_hash` A (their on-disk pin, loaded by `loadInstalled`) while the pack row now
serves manifest B — `loadRuntime` pairs B's `egressHosts`/`secretKeys`/`authSchema` with A's code
(ConnectorService.ts:896-907, ConnectorPoller.ts:337-344,368). Same version = two different approved
bundles; rollback pins become ambiguous.
**Impact**: Egress/secret-key policy approved for version N can be retroactively widened onto code
that was approved under a different manifest; the "version = approved bytes" invariant the whole
token+hash design rests on is violated.
**Suggestion**: In the write transaction, when a non-archived row for `(packId, schemaVersion)`
exists, permit the write only if `content_hash` and `manifest_hash` are identical (true re-approval /
archived-revive); otherwise reject (`versionAlreadyApproved`) — different content requires a new
`schemaVersion`.

### [SEVERITY: MEDIUM] Finding 3: `confirmRequest` never re-checks `status='pending'` inside the write transaction — a racing cancel/uninstall is silently overridden

**File**: apps/server/src/watch/connectors/ConnectorService.ts:1294 (check), 1373-1467 (transaction),
1500-1523 (cancel), 1662-1666 (uninstall's pending-cancel)
**Problem**: The pending check runs before a fetch that can take up to 30s plus widget transpile and
`migrateConfig`. In that window `cancelInstallRequest` or `uninstall` (which cancels pending
requests) can mark the row resolved — the confirm proceeds regardless, and the final
`SET status='confirmed' WHERE request_id=?` (1462-1466) unconditionally flips a `cancelled` request
back to `confirmed`. For uninstall the racing confirm's `ON CONFLICT … archived_at = NULL` revives a
pack version the user just archived.
**Impact**: A user's explicit cancel/uninstall loses to an in-flight confirm; the code they rejected
installs anyway (it was token-authorized earlier, but the user withdrew that approval). Same race
lets a confirm resurrect a pack mid-`purgeInstanceData`.
**Suggestion**: Inside the transaction, make the status update conditional —
`SET status='confirmed', resolved_at=? WHERE request_id=? AND status='pending'` — and fail with
`requestNotPending` when 0 rows change.

### [SEVERITY: MEDIUM] Finding 4: the deferred `localUrl` fetch result becomes agent-readable after prepare, and the private-fetch gate is a caller-supplied boolean

**File**: apps/server/src/watch/connectors/ConnectorService.ts:1202-1264 (prepare), 551-557
(`selectPendingRequestRows`); RpcAuthorization.ts:152
**Problem**: (a) After `prepareInstallConfirm` fills a deferred row, the fetched `manifest`,
`pack_id`, `content_hash`, and the acked `origin` sit in a still-`pending` row returned by `list` —
readable at `orchestration:read` and by agents via `t3_watch_connectors_list`. An agent can plant the
private-URL request and, once any client prepares it, read the internal endpoint's manifest. (b) The
"human acknowledgement" is `input.allowLocalUrl === true` — a plain parameter on an
`orchestration:operate` RPC; nothing server-side ties it to a human gesture (agents are excluded only
by toolkit absence). (c) The acked flag is persisted into `origin_json` (1245-1253), so the confirm
re-fetch — and the stored pack/instance origin forever after — honors `allowLocalUrl` on _every_
redirect hop, letting an acked private URL redirect to other private hosts (content-pin still limits
what can install, but the GET side-effects reach anywhere internal).
**Impact**: Internal-network response content (manifest) disclosed to agents post-ack; ack scope
creeps from "this URL is local" to "anywhere this URL redirects".
**Suggestion**: Consider gating the deferred fetch on `environment:maintain` (matching confirm),
avoid persisting `allowLocalUrl` into `origin_json` (re-apply it in the confirm leg instead, or
restrict redirects to same-origin hosts when acked), and be deliberate about pending-row manifest
visibility to read-scope/MCP callers.

### [SEVERITY: MEDIUM] Finding 5: `recordHealth`'s "poller is the only writer" invariant is false — health writes are racy and can erase `lastRollback`

**File**: apps/server/src/watch/connectors/ConnectorService.ts:928-961 (claim + read-modify-write),
1473-1479 (confirm's post-commit write), 1603-1629 (rollback's post-commit write)
**Problem**: The comment at 930-931 asserts single-writer, but `rollback` and `confirmRequest` also
call `recordHealth`, each spreading a _stale_ health snapshot (`repinTarget.health` /
`instance.health` read before the transaction). A poller write between that read and the post-commit
write is clobbered (status/lastError/lastFetchAt/consecutiveFailures reset). Worse, `lastRollback` is
only sticky if the _poller's_ read saw it: a poller read predating the rollback write produces merged
health with no `lastRollback` and overwrites it — the audit record the comments promise is lost.
**Impact**: Transient health regressions and silent loss of the `lastRollback` audit trail under
routine poller concurrency; notifications still record the rollback, so partial mitigation exists.
**Suggestion**: Do the merge in SQL against the current `health_json` (json_set/merge of
`lastRollback`, `status`, `lastError`) or wrap read-modify-write in a transaction; drop the
single-writer assumption.

### [SEVERITY: MEDIUM] Finding 6: `migrateConfig` output is persisted verbatim into client-visible `config_json` while `ctx.secrets` hands real values to pack code — secret laundering into the instance row

**File**: apps/server/src/watch/connectors/ConnectorService.ts:1044-1085 (`runConfigMigration`),
1447 (upgrade re-pin `COALESCE`), 1547 (rollback `config_json` write); docstring claim at 105-108.
**Problem**: The migrator receives `ctx.secrets` populated with real values, and its return value is
validated only for `required`/`additionalProperties` — then written to `config_json`, which `list`
returns to every read-scope client and to agents via `t3_watch_connectors_list`.
`migrateConfig: () => ({k: ctx.secrets.get("apiKey")})` persists a secret into the row — contradicting
"Secret values never reach the instance row or a client". The migrator has no `ctx.fetch` egress, so
`config_json` is _the_ exfil channel — and `rollback` is agent-reachable (handlers.ts:61-65), so an
agent can trigger the migrator on demand.
**Impact**: A malicious (or buggy) approved pack can copy secrets into durable, agent-readable
instance config — a quieter channel than snapshot egress (which is at least transport-shaped).
Requires a pack that ships a hostile `migrateConfig`; still, the documented invariant is false.
**Suggestion**: At minimum fix the docstring (secrets are pack-visible; `config` is pack-writable).
Better: scan migrated config for values equal to resolved secrets, or run the migrator without the
secrets accessor (it only transforms config), or require re-entry of secrets on version change.

### [SEVERITY: MEDIUM] Finding 7: `uninstall`/`purge` miss deferred `pack_id IS NULL` requests; prepare's deferred UPDATE doesn't guard status

**File**: apps/server/src/watch/connectors/ConnectorService.ts:1662-1666 (uninstall cancel),
1795-1797 (purge request delete), 1246-1254 (prepare UPDATE), 963-991 (insertRequest)
**Problem**: Deferred `local_url` install requests are stored with `pack_id = NULL`, so
`uninstall`'s `WHERE pack_id=? AND status='pending'` cancel and purge's request-history delete skip
them. A surviving request can later be prepared (which fills `pack_id` from the fetched manifest) and
confirmed — reinstalling a pack the purge's contract claims to erase ("deletes … request history").
Also, the prepare UPDATE rewriting the deferred row has no `status='pending'` predicate, so a request
cancelled during the private fetch still gets its fields mutated (status stays resolved — cosmetic,
but sloppy). Additionally: pending requests have no cap/dedupe/expiry — an agent can spam
`requestInstall` (each performing an outbound fetch + durable row) for unbounded DB growth.
**Impact**: Orphaned pending rows outlive uninstall/purge; deferred requests are invisible to
pack-scoped cancellation. Request spam is a low-grade DoS (fetch amplification + table growth feeding
`list`).
**Suggestion**: When archiving/purging, also cancel pending rows whose `pack_id IS NULL` deferred
origin could resolve to the pack (or stamp deferred rows differently); add `AND status='pending'` to
the prepare UPDATE; consider a pending-request cap.

## Minor (below threshold, noted for completeness)

- `confirmUpgrade` with `upgrade_instance_id` fails the _entire_ confirmed install if the instance
  vanished between request and confirm (`repinned.length===0` → transaction fails after token burn;
  materialized dir + widget artifacts orphaned). Consider approving the pack and skipping the re-pin.
- A request whose public URL's DNS later resolves private can never be confirmed (`urlBlocked` at
  refetch) and can't be re-acked since `manifest_hash` is already set — fail-closed but stuck
  forever.
- `secretStoreName` sanitization allows key collisions (`"a/b"` vs `"a_b"`) — pack-declared keys only,
  self-inflicted; not exploitable across instances.
