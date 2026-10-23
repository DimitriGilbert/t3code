# Review Report — Cluster 2: Persistence migrations (feat/watch-screen)

Scope: `apps/server/src/persistence/Migrations/063–066`, `Migrations.ts` registration, cross-checked
against `packages/contracts/src/watch.ts` and the services that read/write the tables
(`WatchPageService.ts`, `UserNotificationService.ts`, `ConnectorService.ts`, `ConnectorPoller.ts`).

Migration files themselves are clean on their own terms: registration ids 63–66 are sequential and
in order, column shapes match the contract schemas, every NOT NULL column is supplied by all insert
sites, PK/index choices cover the actual query patterns (pages by `order_key`, widgets by `page_id`,
notifications by `recorded_at DESC, notification_id DESC`, packs by `(pack_id, schema_version)`,
install requests by `status`, instances by `pack_id`, widget sources by PK prefix join). No foreign
keys are declared, but no migration in this repo declares one — referential integrity is handled in
transactions in the services, so that is convention, not a defect.

The findings below are real secret-safety / data-integrity gaps the DDL cross-check surfaced in the
code that owns these columns.

---

### [SEVERITY: HIGH] Finding 1: Pack `migrateConfig` output lands verbatim in `config_json` — pack code can smuggle resolved secret values into a client- and agent-visible column

**File**: apps/server/src/watch/connectors/ConnectorService.ts:1447, :1547 (writes), :1044–1085 (`runConfigMigration`), :1052–1056 (`ctx.secrets` accessor)

**Problem**: `runConfigMigration` executes pack code (`migrateConfig`) with `ctx.secrets.get(key)`
returning _plaintext resolved secret values_ for every manifest-declared key, then writes the pack's
arbitrary return object into `config_json` after only `validateConfigAgainstManifest` — a check
against the pack's _own_ `authSchema` (ConnectorService.ts:411–446), which verifies required fields
and `additionalProperties` but never strips declared secret keys or values. `config_json` is served
to every client via `WatchConnectorInstance.config` in `list`/`subscribeList`, and — critically —
to agents via the MCP tool `t3_watch_connectors_list` (apps/server/src/mcp/toolkits/watch/tools.ts:66–74),
whose toolkit docs promise "secret values are never returned" (tools.ts:101).

**Evidence**: `config_json = COALESCE(${encodeConfigJson(migratedConfig)}, config_json)` at
ConnectorService.ts:1447 (confirm-upgrade re-pin) and `config_json = ${encodeConfigJson(migratedConfig ?? instance.config)}`
at :1547 (`repinInstance`, used by rollback). `makeSecretsAccessor` (PackModule.ts:105–115) returns
`resolved[key]` in plaintext for declared keys; `resolveSecrets` (:860–884) loads real store values.

**Impact**: A pack (human-approved but prompt/code-supplied) can do `return { ...ctx.config, leaked: ctx.secrets.get("apiKey") }`
on any upgrade/rollback, and the secret value lands in a row column that is broadcast to all clients
_and readable by agents through MCP_. This bypasses the `egressHosts` allowlist — even a
`file`-transport pack with zero declared egress gets an exfiltration channel. It breaks the
documented invariant that secret values "never reach the instance row, never a client".

**Suggestion**: After `migrateConfig` returns (and before persisting), strip any keys present in
`bundle.manifest.secretKeys` from the migrated config, and optionally diff remaining string values
against `resolvedSecrets` to drop literal secret values. Same scrub should apply to client-supplied
config (Finding 2).

### [SEVERITY: MEDIUM] Finding 2: Client-supplied `config` keys are never rejected against `manifest.secretKeys` — a plaintext value under a declared secret key persists in `config_json`

**File**: apps/server/src/watch/connectors/ConnectorService.ts:716–736 (`createInstance`), :821–844 (`setInstanceConfig`)

**Problem**: `input.config` is written verbatim into `config_json`. `undeclaredSecretKey` validates
`input.secrets`/`clearSecretKeys` against `manifest.secretKeys`, but nothing prevents `config` from
containing the _same_ declared secret keys with plaintext values. The contract documents `config` as
"User/agent-written instance config (no secrets — those live in the secret store by key)"
(packages/contracts/src/watch.ts:494–495), and `secret_keys_json` is meant to record "which
manifest-declared keys have a value in the secret store" (065_WatchConnectors.ts:24–25) — a key
present in both places makes that bookkeeping ambiguous and the secret plaintext lands in a column
echoed to all clients and MCP agents.

**Evidence**: `config_json: encodeConfigJson(config)` at :736 and `SET config_json = ${encodeConfigJson(input.config)}`
at :840 with no key-overlap check; `t3_watch_connector_instance_config_set` is agent-reachable
(tools.ts:98–104).

**Impact**: Secret material in `config_json` is served to every connected client and to agents via
`t3_watch_connectors_list`, silently violating the never-returned-secrets invariant whenever a caller
puts a credential into config instead of `secrets`.

**Suggestion**: Reject (or strip) `config` keys that intersect `manifest.secretKeys` in both
`createInstance` and `setInstanceConfig`, alongside the existing `secretKeyUndeclared` check.

### [SEVERITY: MEDIUM] Finding 3: `clearSecretKeys` validated against the pinned manifest — secrets for keys dropped by a re-pin become orphaned with no removal path

**File**: apps/server/src/watch/connectors/ConnectorService.ts:826–827 (`undeclaredSecretKey(manifest, clearKeys)`), :1442–1453 and :1542–1550 (re-pins)

**Problem**: `setInstanceConfig` rejects `clearSecretKeys` entries not declared by the _currently
pinned_ manifest (`secretKeyUndeclared`). But `repinInstance` and the upgrade confirm path re-pin
`schema_version` without touching `secret_keys_json` or pruning stored secrets. After an
upgrade/rollback to a manifest that no longer declares key K, `configuredSecretKeys` still lists K
(reported to clients as configured), the secret value remains in the file-backed secret store, and
`clearSecretKeys: ["K"]` is refused — the only ways to remove it are `deleteInstance` or pack purge.

**Evidence**: `undeclaredSecretKey(manifest, clearKeys)` at :827 validates against the new manifest;
the re-pin UPDATEs (:1444–1449, :1543–1550) set `schema_version`/`content_hash`/`config_json` only.
`resolveSecrets` (:867) intersects with declared keys, so the orphaned value is inert at runtime but
still stored and still advertised in `configuredSecretKeys`.

**Impact**: Secret values outlive the manifest version that declared them, cannot be revoked through
the documented `clearSecretKeys` API, and `secret_keys_json` misreports stale keys to clients — a
secret-lifecycle data-integrity gap directly on the `secret_keys_json` column's contract.

**Suggestion**: Validate `clearSecretKeys` against `instance.configuredSecretKeys` (what exists)
rather than `manifest.secretKeys`, and/or on re-pin either prune `secret_keys_json`+stored secrets to
the new manifest's declared set or keep them but still allow clearing.

### [SEVERITY: MEDIUM] Finding 4: `watch_notifications` is append-only with no retention — unbounded table growth

**File**: apps/server/src/persistence/Migrations/064_WatchNotifications.ts:10–17, apps/server/src/notifications/UserNotificationService.ts

**Problem**: The migration creates an append-only history table and nothing ever deletes from it.
`recordNotification` INSERTs one row per emitted event (every thread completion/failure/
awaitingInput, connector health transition, threshold crossing, rollback); reads are capped
(`LIMIT 500`) but storage is not. Other append-only tables in this codebase have pruning:
`orchestration_events` is pruned in ProjectionMaintenance.ts:315 and the effect outbox has
`pruneSettled` (EffectOutbox.ts:666–691). `watch_notifications` has neither — no `DELETE FROM
watch_notifications` exists anywhere in the tree.

**Evidence**: grep for `DELETE FROM watch_notifications` returns nothing; UserNotificationService.ts
contains only INSERT/SELECT against the table.

**Impact**: On a long-lived busy server the table (and its `idx_watch_notifications_recorded` index)
grows forever, degrading insert/write cost and DB size — the classic append-only-without-retention
defect this cluster exists to catch.

**Suggestion**: Add a retention prune (e.g. rows older than N days or beyond a max row count, both
serviced by the existing `recorded_at` index), run alongside the existing maintenance passes.

### [SEVERITY: MEDIUM] Finding 5: `install` confirm upserts over an already-approved live `(pack_id, schema_version)` — no ordering check, no diff base

**File**: apps/server/src/watch/connectors/ConnectorService.ts:1378–1411 (confirm transaction), :1267–1274 (`diffBase` null for installs)

**Problem**: The version-ordering guard (`downgradeRejected` against `MAX(schema_version)`) runs only
when `expectedKind === "upgrade"`. For `expectedKind === "install"`, the `INSERT INTO
watch_connector_packs ... ON CONFLICT (pack_id, schema_version) DO UPDATE` unconditionally replaces
`manifest_json`/`manifest_hash`/`origin_json`/`content_hash` and resets `archived_at = NULL` on an
_already-approved, non-archived_ version row, and re-registers that version's widget sources
(:1414–1429). `requestInstall` is agent-reachable (tools.ts:106–112) and performs no installed-pack
check, so an agent can open a pending request for an origin serving the same `pack_id`+`schemaVersion`
with different content. The human confirm still gates it — but unlike the upgrade leg, `diffBase` is
null, so the confirm dialog cannot show that live approved content is being replaced.

**Evidence**: `if (expectedKind === "upgrade")` guard at :1378; `ON CONFLICT ... DO UPDATE SET
manifest_json = excluded.manifest_json, ...` at :1404–1410; `diffBase` populated only for
`row.kind === "upgrade"` at :1268.

**Impact**: A same-(pack_id, schema_version) replacement of approved manifest/content hash through a
path with no diff and no version check. Rollback (`findPackRow` → `loadInstalled` on
`packRow.content_hash` at :1589) would then load the replaced bytes for that version, and existing
instances' config is re-validated against the replaced manifest. Human confirmation remains the last
line of defense, but it lacks the context the upgrade leg provides.

**Suggestion**: In the confirm transaction, when `expectedKind === "install"` and a non-archived row
already exists for `(pack_id, schema_version)`, reject (or require the request to go through the
upgrade leg so ordering + diff apply); alternatively surface a diff base for installs onto an
existing pack.

---

## Summary

- **5 findings**: 1 HIGH, 4 MEDIUM.
- Migration DDL/registration: clean — ids, ordering, columns, NOT NULLs, and index coverage all check out.
- The HIGH finding is the secret-invariant break: `config_json` (a client- and MCP-agent-visible
  column) accepts pack `migrateConfig` output verbatim while pack code holds plaintext secret values —
  `watch_connector_instances` has no schema-level way to stop this, so it must be scrubbed at write.
- The MEDIUMs are all secret-lifecycle/integrity edges on the new columns: config/secretKey overlap,
  orphaned secrets after re-pin, unbounded `watch_notifications` retention, and an install-confirm
  upsert that can overwrite a live approved version without ordering or diff.
