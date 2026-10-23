# Verify Report 5 — ConnectorService + ConfirmationTokens (feat/watch-screen)

Each finding of `review-report-5.md` re-checked against
`apps/server/src/watch/connectors/{ConnectorService,ConfirmationTokens,PackStore,PackModule,ConnectorPoller}.ts`,
`packages/contracts/src/{watch,baseSchemas,clientRpcPermissions}.ts`, `apps/server/src/config.ts`,
`apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/mcp/toolkits/watch/handlers.ts`,
migration `065_WatchConnectors.ts`, and intent docs `.plans/welcome-screen/{PLAN,DESIGN}.md`.

Verdict counts: **7 VERIFIED-DEFECT, 0 VERIFIED-INTENTIONAL, 0 REJECTED.**
Duplicates: F1 = report-6 F3 (independently reported); F4(b) = report-11 F1; F6 = report-2 F1.

---

### F1 — path traversal via `manifest.id` — VERIFIED-DEFECT, HIGH (dup of report-6 F3)

Confirmed end to end:

- `packDirName` (PackStore.ts:603) is `packId.replace(/[^A-Za-z0-9._-]/g, "_")` — `.` survives, so
  `".."` and `"."` pass verbatim. No `.`/`..`/slash-segment rejection.
- `WatchConnectorPackId` is `makeEntityId` = branded `TrimmedNonEmptyString` (baseSchemas.ts:310-312,
  412; watch.ts:436). `".."` decodes fine. No charset/pattern check exists anywhere — no
  `CHECK` in `065_WatchConnectors.ts` either (pack_id is bare `TEXT`).
- Sinks confirmed: `installedPackDir` (PackStore.ts:605-609) → `materializeBundle` (:630, called at
  ConnectorService.ts:1346 on confirm) writes `<connectorsDir>/../<hash>` = `stateDir/<hash>/`
  (connectorsDir = join(stateDir,"connectors"), config.ts:172) — write-outside-sandbox at the
  first human confirm. `loadInstalled` (:663-682; poller ConnectorPoller.ts:337-340, rollback
  ConnectorService.ts:1589) reads outside. `removeInstalled` (:688-702, called only by
  purgeInstanceData at :1783) resolves `path.join(connectorsDir, "..")` = `stateDir` and
  `fs.remove(recursive, force)` deletes the whole T3 state dir — SQLite DB, `secrets/`, logs.
  `id:"."` → `removeInstalled` wipes `connectorsDir` itself (all packs).
- Reachability: `requestInstall` stores `bundle.manifest.id` as pack_id (:1100) with no validation;
  `confirmRequest` only checks refetched `manifest.id === row.pack_id` (:1332). Full chain needs two
  human confirmations (install + purge) but the id anomaly is a single `".."` in a confirm dialog —
  easy to miss. The materialize write-escape alone needs only the install confirm.

Fix: reject `.`/`..` (any dot-only name, or non-`^[A-Za-z0-9][A-Za-z0-9._-]*$`) at manifest decode /
bundle acceptance in PackStore; defense-in-depth: assert `path.resolve(installedPackDir)` stays
under `connectorsDir` before write/remove. Hashing the id for the dir name also works.

### F2 — approved-version pin mutable via `ON CONFLICT DO UPDATE` — VERIFIED-DEFECT, HIGH

Confirmed: ConnectorService.ts:1393-1411 upserts `(pack_id, schema_version)` overwriting
`manifest_json`, `manifest_hash`, `origin_json`, `content_hash` with no equality check. The
`approved_max` ordering recheck (:1378-1391) only runs for `upgrade`; `install` of an already-approved
version with different content silently replaces the approved row. No signal to the confirmer —
installs get no `diffBase` (:1267-1274 only fills it for upgrades).

Consequence confirmed: instances keep pinning their original `content_hash`; the poller's
`loadInstalled(info.instance.packId, info.instance.contentHash)` (ConnectorPoller.ts:337) loads the
old bytes while `loadRuntime` serves the _new_ manifest's `egressHosts`/`secretKeys`/`authSchema`
(ConnectorService.ts:896-906 → ConnectorPoller.ts:344,368-371). Code approved under policy A runs
under policy B — retroactive egress/secret widening nobody approved for those bytes. Rollback pins
(`findPackRow` + `loadInstalled` by version, :1576-1592) become ambiguous since one version now
means two different approved bundles.

Revive-after-archive via the same upsert IS intentional (test "reinstalling an archived version
revives its archived instances", ConnectorService.test.ts:743; comment :1431-1432) — the defect is
the missing equality guard: overwrite should be permitted only when `content_hash`/`manifest_hash`
match (true re-approval/revive of identical bytes), else reject `versionAlreadyApproved`.

Fix: in the write txn, when a row exists for `(pack_id, schema_version)`, compare hashes; reject on
mismatch (different content requires a new `schemaVersion`). Optionally surface existing-version
state in the install `diffBase` so the dialog can warn.

### F3 — confirm never re-checks `status='pending'` in the write txn — VERIFIED-DEFECT, MEDIUM

Confirmed: `pendingRequestRow` check at :1294 precedes token consume, a fetch with a 30s timeout
(PackStore.ts FETCH_TIMEOUT), materialize, widget transpile, and `runConfigMigration` — a wide
window. The final `UPDATE ... SET status='confirmed' WHERE request_id=?` (:1462-1466) has no status
predicate. `cancelInstallRequest` (:1503-1507) and `uninstall`'s pending-cancel (:1662-1666) both
write `status='cancelled'` in that window; the in-flight confirm then flips `cancelled→confirmed`
unconditionally, and its `ON CONFLICT ... archived_at = NULL` (:1410) plus instance-revive
(:1433-1439) un-archives a pack the user just uninstalled. RPC handlers are thin (ws.ts:699-729) —
no serialization prevents interleaving.

Fix: exactly as suggested — `SET status='confirmed', resolved_at=? WHERE request_id=? AND
status='pending'` inside the transaction, failing `requestNotPending` when 0 rows change.

### F4 — deferred `localUrl` result agent-visible; `allowLocalUrl` scope — VERIFIED-DEFECT, MEDIUM

#### (split verdicts on sub-parts)

- **(a) Post-prepare manifest disclosure — VERIFIED-DEFECT, MEDIUM (LOW defensible).**
  After `prepareInstallConfirm` fills a deferred row (:1246-1262), the still-`pending` row is
  returned by `list` (`selectPendingRequestRows` :551-557; `installRequests` decode `manifest`,
  watch.ts:539) — readable at `orchestration:read` and by agents via `t3_watch_connectors_list`
  (handlers.ts:26-30). An agent plants the private-URL request; once any client acks+prepares it,
  the agent reads the internal endpoint's manifest. Bounded to the manifest body (files aren't
  stored), and gated by a human clicking prepare — but it does convert "agent can never trigger a
  private-range fetch" into "agent can observe the private fetch's declared manifest". Real
  information-flow gap.
- **(b) `allowLocalUrl` is a self-asserted boolean on an operate-scope RPC — VERIFIED-INTENTIONAL
  (dup of report-11 F1).** `watchConnectorsPrepareInstallConfirm` is `AuthOrchestrationOperateScope`
  (RpcAuthorization.ts:152, comment at 150-151 states the intent), absent from the MCP toolkit
  (handlers.ts verified — only list/create/update/delete/config/requestInstall/requestUpgrade/
  rollback/uninstall), and consumption still requires `environment:maintain` + `CLIENT_GUARDED`
  - a bound token (clientRpcPermissions.ts:54-58). PLAN.md:368-371 pins this exact model. Report-11
    F1 already rates this MEDIUM as "defense-in-depth drift"; not a new finding here.
- **(c) persisted `allowLocalUrl` applies to every redirect hop forever — VERIFIED-DEFECT,
  MEDIUM.** The acked flag is written into `origin_json` (:1218-1253), so the confirm refetch
  (:1330-1331) and the stored pack/instance origin (:1399, :738, :1446) carry it indefinitely.
  In `fetchUrlBundle`, `allowLocal` skips the private-range check on _every_ hop (PackStore.ts:491),
  so an acked private URL may 302 to any other private https host — ack scope creeps from "this
  URL" to "anywhere it redirects" (https-only still enforced per hop, :480-485; content pin still
  bounds what installs, but the GET reaches arbitrary internal endpoints).

Fix: don't persist `allowLocalUrl` into stored `origin_json` (re-apply only in the confirm leg);
when acked, re-check each redirect hop or restrict redirects to the same host/acked address set;
consider gating deferred-fetch prepare on `environment:maintain`; decide deliberately whether the
filled manifest should be agent-visible while pending.

### F5 — `recordHealth` not single-writer; stale snapshots erase `lastRollback` — VERIFIED-DEFECT, MEDIUM

Confirmed: the :930-931 comment asserts "the poller is the only writer", but `rollback` (:1604) and
`confirmRequest` (:1474) also call it. Both spread snapshots read before their transactions
(`instance.health` at :1556, `repinTarget.health` at :1360). `recordHealth` merges only
`lastRollback` from stored state (:947-953) — a poller `recordHealth` (per poll run,
ConnectorPoller.ts:438-449, 478-489) landing between the snapshot read and the post-commit write is
clobbered (status/lastError/lastFetchAt/consecutiveFailures regress). And the stickiness itself is
racy: a poller whose read at :932-936 predates rollback's write merges without `lastRollback` and
overwrites it — silent loss of the audit record the comments promise. Partial mitigation: the
`connector.rolledBack` notification still lands (:1618-1628).

Fix: merge in SQL against current `health_json` (json_set/`json_patch`), wrap read-modify-write in
a transaction, or have rollback/confirm pass only delta fields. Drop the single-writer comment.

### F6 — secret laundering via `migrateConfig` into `config_json` — VERIFIED-DEFECT (DUPLICATE of report-2 F1), MEDIUM (report-2: HIGH)

Confirmed identical to report-2 finding 1, same lines: `runConfigMigration` builds
`ctx.secrets` with real resolved values (:1052-1056 via `resolveSecrets` + `makeSecretsAccessor`
which returns plaintext, PackModule.ts:105-115), the arbitrary return value passes only
`validateConfigAgainstManifest` (:1077-1083 — pack's own authSchema, required/additionalProperties
only) and is persisted verbatim into `config_json` (:1447 upgrade re-pin COALESCE, :1547
rollback repin). `config_json` reaches every read client and agents via `t3_watch_connectors_list`.
`migrateConfig` ctx has no `fetch` (:1053-1057), so `config_json` is the exfil channel — and
rollback is agent-reachable (handlers.ts:61-65), letting an agent trigger the migrator on demand.
Contradicts the docstring "Secret values never reach the instance row or a client" (:105-107).

Dedupe: keep one finding; report-2 rates HIGH. Severity debate: requires a hostile _approved_ pack,
but the channel bypasses `egressHosts` entirely (even a zero-egress file-transport pack can leak)
and makes secrets durable + agent-readable. MEDIUM-HIGH either way.

Fix: scrub migrated config — drop keys declared in `secretKeys` and/or values equal to resolved
secrets before persisting; or run the migrator without the secrets accessor; fix the docstring.

### F7 — `pack_id IS NULL` deferred requests escape cancel/purge; unguarded prepare UPDATE; unbounded pending — VERIFIED-DEFECT, MEDIUM

All three sub-points confirmed:

- Deferred `local_url` **install** rows store `pack_id = NULL` (:1100, `bundle?.manifest.id ?? null`;
  deferred _upgrades_ still record pack_id at :1165, so only installs are invisible).
  `uninstall`'s cancel `WHERE pack_id=? AND status='pending'` (:1662-1666) and purge's
  `DELETE ... WHERE pack_id=?` (:1795-1797) never match NULL — deferred rows survive both. A
  surviving request can be prepared later (fills pack_id from the fetched manifest, :1248) and
  confirmed, reinstalling a pack the purge docstring claims fully erases (:175-178 "request
  history"). Confirmed gap.
- Prepare's deferred UPDATE (:1246-1254) lacks `AND status='pending'` — `pendingRequestRow` (:1204)
  guards before the private fetch, but a cancel landing during the fetch leaves field mutations on
  a cancelled row; status stays resolved so confirm still refuses (:1192-1198). Cosmetic, as
  reported.
- No cap/dedupe/expiry on pending requests (:963-991, :1087-1114): each agent-reachable
  `requestInstall` performs an outbound fetch (public URLs after SSRF checks) and writes a durable
  row; pending rows feed every `list`. Real low-grade fetch-amplification + table-growth DoS.

Fix: cancel/delete deferred NULL-pack_id rows when their (later-resolved) pack is uninstalled or
purged — or refuse purge/prepare while such rows could still bind; add `AND status='pending'` to
the prepare UPDATE; add a pending-request cap per pack/environment.

---

## Verified-sound claims spot-checked

- ConfirmationTokens.ts is clean as reported: atomic `Ref.modify` consume (:95-100), 192-bit tokens,
  5-min TTL, memory-only, binding checked after burn. Purge token binds a recomputed descriptor
  (:1675-1720). Confirm re-hash + refetch + content pin (:1316-1345) is as described; agent-supplied
  `allowLocalUrl` stripped at request (:511-512).
- MCP toolkit genuinely lacks prepare/confirm/purge/cancel (handlers.ts enumerated); MCP errors
  scrubbed via `unavailable`.
- SSRF posture (DNS-pinned socket lookup, per-hop https + range check, 2MB cap) verified in
  PackStore.ts:344-570.
