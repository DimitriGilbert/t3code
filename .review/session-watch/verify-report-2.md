# Verification Report — Review Report 2 (Persistence migrations cluster)

Verified each finding against source in `apps/server/src/watch/connectors/ConnectorService.ts`,
`PackModule.ts`, `apps/server/src/mcp/toolkits/watch/{tools,handlers}.ts`,
`apps/server/src/notifications/UserNotificationService.ts`, migrations 063–066,
`packages/contracts/src/watch.ts`, and `.plans/welcome-screen/{PRD,PLAN,DESIGN}.md`.

## Verdict counts

- VERIFIED-DEFECT: 5 (one is a cross-report duplicate)
- VERIFIED-INTENTIONAL: 0
- REJECTED: 0
- Severity changes: Finding 3 MEDIUM → LOW. Finding 5 is a duplicate of report 5
  Finding 2 — merge at report 5's HIGH. Finding 1 also duplicates report 5 Finding 6
  (MEDIUM there) — keep HIGH, reasoning below.

Migration registration double-checked independently: ids 63–66 sequential and in order
(`apps/server/src/persistence/Migrations.ts:159-162`, imports :79-82). Report's
"DDL clean" claim stands.

---

### Finding 1 — VERIFIED-DEFECT, HIGH retained (duplicate of report 5 Finding 6, MEDIUM there)

Every claim traces:

- `runConfigMigration` (ConnectorService.ts:1044-1085) evaluates pack code
  (`PackModule.evalConnectorModule`, :1049), resolves **real plaintext secret values**
  (`resolveSecrets`, :1052 → :860-884 reads the file-backed store, intersecting
  `configuredSecretKeys` ∩ `manifest.secretKeys`), and hands them to pack code via
  `ctx.secrets` (:1055 → `makeSecretsAccessor`, PackModule.ts:105-115 returns
  `resolved[key]` verbatim).
- The arbitrary return object is checked only by `validateConfigAgainstManifest`
  (:1077 → :411-446), which tests `required`/`additionalProperties` — and does nothing
  at all when the (pack-authored) `authSchema` is absent or open. It never strips
  declared secret keys or compares values to resolved secrets.
- Output lands verbatim in `config_json`: `COALESCE(encodeConfigJson(migratedConfig), …)`
  at :1447 (upgrade confirm) and `encodeConfigJson(migratedConfig ?? instance.config)`
  at :1547 (`repinInstance`, rollback).
- `config_json` → `instance.config` → `WatchConnectorsListResult.instances[].config` →
  all RPC clients and agents via `t3_watch_connectors_list` (tools.ts:66-74,
  handlers.ts:26). Documented invariant broken: service docstring :107
  ("Secret values never reach the instance row or a client"), migration
  065_WatchConnectors.ts:24 ("Instance config never holds secret values"),
  contract watch.ts:494-496, PRD.md:155 ("never in page/widget config, never sent
  to clients").

Stronger than the report states: **rollback is agent-reachable**
(`t3_watch_connector_rollback`, tools.ts:122-128, handlers.ts:61-63). Once ≥2
approved versions exist, an agent can invoke the pack's `migrateConfig` on demand
(rollback → `repinInstance` → `runConfigMigration`) and then read the laundered
value back through `t3_watch_connectors_list` — a complete exfil chain with no
human step and zero egressHosts needed (a `file`-transport pack has no `ctx.fetch`
at all). The vm realm strips ambient power precisely because packs are treated as
untrusted-after-approval (PackModule.ts:26-29), so "requires a hostile pack" is
in-scope, not mitigating.

**Fix direction**: (a) remove `ctx.secrets` from the migrate context entirely —
migrateConfig only transforms config (report 5's suggestion, cleanest); or
(b) strip `bundle.manifest.secretKeys` from the migrated object before write and
drop any string value equal to a resolved secret. Apply the same scrub in
`repinInstance` and the upgrade re-pin.

### Finding 2 — VERIFIED-DEFECT, MEDIUM retained

`input.config` is written verbatim (`encodeConfigJson(config)` :736,
`SET config_json = encodeConfigJson(input.config)` :840). Only `secrets` and
`clearSecretKeys` go through `undeclaredSecretKey` (:720, :825-827); `config` keys
are never checked against `manifest.secretKeys`. A declared secret key carrying a
plaintext value in `config` persists in client/agent-visible `config_json` —
contract documents config as secret-free (watch.ts:494) but nothing enforces it.
Enforcement gap is real whenever `authSchema` is absent or not closed
(`additionalProperties !== false` or the key listed in `properties`). Note the
caller already knows the value it wrote — harm is broadcast to _other_ readers
(clients, other agents) plus divergence: `resolveSecrets` reads the store value
while clients see the config value under the same key, and `secret_keys_json`
bookkeeping becomes ambiguous. MEDIUM is fair.

**Fix direction**: reject `config` keys ∩ `manifest.secretKeys` (`configInvalid`)
in `createInstance` and `setInstanceConfig`, next to the existing checks.

### Finding 3 — VERIFIED-DEFECT, downgrade MEDIUM → LOW

Mechanics confirmed: `clearSecretKeys` is validated against the _pinned_ manifest
(:826-827); re-pins (:1444-1453, :1543-1550) touch only
`schema_version`/`content_hash`/`origin_json`/`config_json` — never
`secret_keys_json` or the store. After a re-pin to a manifest that dropped key K,
`configuredSecretKeys` still advertises K, the value stays in the file-backed
store, and `clearSecretKeys: ["K"]` is refused (`secretKeyUndeclared`).

Why LOW not MEDIUM: the orphaned value is inert at runtime (`resolveSecrets`
intersects declared∩configured, :867), and removal paths exist (`deleteInstance`
removes all `configuredSecretKeys`, :790; purge likewise :1773-1775). The real
residual issues are narrower than reported: un-clearable stale bookkeeping
advertised to clients, and a stale value _silently reactivating_ if a future
manifest version re-declares the key — no fresh human consent to the old value.

**Fix direction**: validate `clearSecretKeys` against
`instance.configuredSecretKeys` (union with declared, or just configured) so stale
keys remain revocable; optionally prune `secret_keys_json`+store entries on re-pin
to the new manifest's declared set.

### Finding 4 — VERIFIED-DEFECT, MEDIUM retained

`watch_notifications` is append-only by design (064_WatchNotifications.ts:7-8,
10-17); `DELETE FROM watch_notifications` exists nowhere — only INSERT
(UserNotificationService.ts:179) and SELECT (:406, `LIMIT ≤500`). No retention
job touches it (grep over `apps/server/src` confirms). Comparison points are
exact: `orchestration_events` pruned at ProjectionMaintenance.ts:315, outbox
`pruneSettled` at EffectOutbox.ts:666.

Keeping MEDIUM over LOW: emit volume is mostly edge-triggered (health transitions
emit once, ConnectorPoller.ts:489-498; run events once per transition), **but**
threshold rules re-arm when the condition stops holding and re-fire on the next
crossing (ConnectorPoller.ts:406-422) — a flapping signal emits on every rising
edge, i.e. up to once per poll interval. Unbounded growth is realistic, not just
theoretical, and the repo's own convention is to prune append-only tables.

**Fix direction**: retention prune by age and/or max row count (both serviceable
by `idx_watch_notifications_recorded`), run alongside ProjectionMaintenance.

### Finding 5 — VERIFIED-DEFECT, duplicate of report 5 Finding 2 (merge; HIGH at merge)

Confirmed verbatim: the `approved_max` ordering guard runs only for
`expectedKind === "upgrade"` (:1378-1392); the install leg's
`INSERT … ON CONFLICT (pack_id, schema_version) DO UPDATE` (:1393-1411) replaces
`manifest_json`/`manifest_hash`/`origin_json`/`content_hash` and clears
`archived_at` on an already-approved live row; `diffBase` is populated only for
upgrades (:1267-1274) so the confirm dialog cannot signal "existing approved
version being replaced". `requestInstall` is agent-reachable
(tools.ts:106-112, handlers.ts:53) with no installed-pack check.

Report 5 Finding 2 describes the same root cause with the sharper consequence:
existing instances keep `content_hash` A (their on-disk pin, loaded by
`loadInstalled`) while the pack row now serves manifest B — `loadRuntime`
(:896-907) pairs B's `egressHosts`/`secretKeys`/`authSchema` with A's code.
Approved-version immutability — the invariant the token+hash confirm design rests
on — is violated. Human confirm still gates it, but without the diff context the
upgrade leg provides.

**Recommendation**: one merged defect at HIGH (report 5's framing subsumes report
2's). Fix: in the write transaction, when a non-archived `(pack_id,
schema_version)` row exists, allow only identical `content_hash`/`manifest_hash`
(true re-approval/archived-revive); else reject (`versionAlreadyApproved`) —
different content requires a new `schemaVersion`.

---

## Overlap notes (as flagged)

- Findings 1 & 2 both concern secrets reaching `config_json`; Finding 1
  additionally duplicates **report 5 Finding 6** (same code, MEDIUM there).
  Recommend merging as one defect at HIGH — report 2's agent-triggerable
  rollback→list chain is the stronger justification for HIGH.
- Finding 5 duplicates **report 5 Finding 2** (approved-version pin overwrite,
  HIGH there). Merge at HIGH.
- Finding 3 is unique to this report. Finding 4 is unique (retention gap; no
  other cluster flagged it in reports read here).

## Citation accuracy

All cited line numbers verified accurate. One drift: report cites
`ProjectionMaintenance.ts:315` without the `orchestration-v2/` directory — the
prune is at `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:315`.
Substance unaffected.
