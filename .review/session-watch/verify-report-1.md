# Verification — review-report-1 (Contracts & permissions, feat/watch-screen)

Method: re-read every cited file:line plus surrounding context, cross-checked against
`PRD.md`/`PLAN.md` intent, the MCP watch toolkit, the vendored `RpcClient` stream-decode
path, and the granular-scope auth model.

**Verdict counts: 5 VERIFIED-DEFECT, 0 VERIFIED-INTENTIONAL, 0 REJECTED.**
Severity adjustments: F1 keep MEDIUM, F2 keep MEDIUM, F3 MEDIUM→LOW, F4 MEDIUM→LOW, F5 MEDIUM→LOW.

## Finding 1 — `watchConnector.subscribe` read-scoped but carries write-effect payload — VERIFIED-DEFECT (MEDIUM)

Code verified:

- `RpcAuthorization.ts:164` — `AuthOrchestrationReadScope`. Confirmed.
- `watch.ts:604-617` — `refreshPolicy`, `widgetId`, `thresholds` all optional on the
  subscribe payload. Confirmed.
- `ConnectorPoller.ts:774-784` — caller's `widgetId`/`thresholds`/`intervalMs` are
  registered verbatim in `Subscriber`; no widget lookup or binding check anywhere in
  `subscribe` (742-802).
- `ConnectorPoller.ts:401-426` — false→true crossing calls `emitNotification` with the
  caller-chosen `widgetId`; `UserNotificationService.emit` → `recordNotification` →
  `INSERT INTO watch_notifications` + PubSub broadcast (`UserNotificationService.ts:178-197`,
  `448-449`). Durable write + cross-client delivery. Confirmed.
- `ConnectorPoller.ts:306-316` — `refreshPolicy.intervalMs` feeds min-of-subscribers
  interval (floor ≥1s); `:792` — first subscriber with no cache/in-flight run forces a
  fetch via `wake(rt, true)`. Confirmed.
- Granular `orchestration:read` grants are real (`auth.ts:123-128` grant scopes, OAuth
  `dpop-access-token` sessions) — a read-only session can exist.

Design-intent check strengthens it: `PLAN.md:417-419` states threshold alerts are
evaluated from "subscriber widgets' `threshold` config" and "**no client/agent RPC can
raise one**". Shipping `thresholds`+`widgetId` on a read-scoped wire payload contradicts
that: any read token can register arbitrary rules attributed to arbitrary widgetIds and
mint durable `widget.threshold` history rows. (Amplifier: report 7 finding 2 shows the
per-subscriber latch resets on resubscribe and `notificationId` embeds a timestamp, so
repeated subscribe cycles can re-fire the same crossing into new rows; report 2 finding 4
notes the history table is unbounded.)

The `refreshPolicy` cadence part is documented intent ("min of subscriber requests" per
PRD:118-120) — inherent to a live-data subscription. The defect is `thresholds`/`widgetId`
on the read path.

**Fix direction**: minimum viable — server-side, when `widgetId`/`thresholds` are
present, require the named widget row to exist and bind `input.instanceId` (reject
otherwise); better, matching plan intent — drop `thresholds` from the subscribe payload
and read rules from the widget's stored `config.settings` at subscribe time. Scope bump
of the whole method to operate is viable too (no shipped client sends the fields today —
the web bridge feed passes only `instanceId`/`widgetId`/`refreshPolicy`,
`WatchAppFrame.tsx:61-69`) but sacrifices read-only dashboard use.

Overlap: adjacent to report 7 finding 2 (threshold latch/dedupe) — same code, different
defect class; and report 11 finding 1 (scope-model theme on prepare endpoints — different
methods).

## Finding 2 — declared secret keys storable cleartext in `config` — VERIFIED-DEFECT (MEDIUM)

Code verified:

- `createInstance` (`ConnectorService.ts:706-754`) and `setInstanceConfig` (798-853):
  `validateConfigAgainstManifest` checks `required` + `additionalProperties:false` against
  `authSchema` (411-446); `undeclaredSecretKey` (449-463) checks only `secrets`/
  `clearSecretKeys` keys ⊆ `manifest.secretKeys`. No `config`∩`secretKeys` intersection
  check anywhere. Confirmed.
- `config` is persisted to `config_json` (736, 840) and returned in
  `WatchConnectorInstance.config` (decodeInstanceRow 323-338) → broadcast by read-scoped
  `listInstances`/`subscribeInstances` and exposed to agents via `t3_watch_connectors_list`
  (`mcp/toolkits/watch/tools.ts:66-74`); write path reachable via
  `t3_watch_connector_instance_config_set` (tools.ts:98-104). Confirmed.
- Contract doc itself asserts the boundary ("no secrets — those live in the secret store
  by key", watch.ts:494) and PRD:155-156 requires "never sent to clients". Unenforced.

Not self-inflicted-only: a pack reading `ctx.config` (passed to pack code at
`ConnectorPoller.ts:343`) silently works with a key in `config`, so the leak is a natural
mistake, and it becomes an egress channel outside the `egressHosts` allowlist — any
connected read-scope client or agent sees the value.

**Fix direction**: reject (fail `configInvalid` naming `field`) `config` keys intersecting
`manifest.secretKeys` in both `createInstance` and `setInstanceConfig` — reuse
`undeclaredSecretKey` inverted.

Overlap: **exact duplicate of report 2 finding 2** (same lines, same fix). Report 2
finding 1 (`migrateConfig` output lands verbatim in `config_json`) is the sibling
pack-side hole — fix both together.

## Finding 3 — caller-settable `pack:` provenance unverified — VERIFIED-DEFECT (LOW, downgraded)

Code verified:

- `WatchPageService.ts:362-368` — `provenanceForAdd` accepts any `pack:<id>` on
  `agent:` kinds; no pack existence/registration check. `addWidget` stores it
  (999-1034). Confirmed.
- The marker is a real trust signal: `WatchProvenanceMarker.tsx` renders "Pack —
  Installed by connector pack X" vs "Agent — authored by an agent"; PRD:202-205 makes the
  provenance chrome a hard security requirement. Confirmed.
- Client flow verified: `buildWatchWidgetAddPackInput` (client-runtime
  `watchPages.ts:706-725`) supplies `pack:<packId>` — so the RPC must accept the field;
  the missing piece is purely server verification.
- Scope check: `watchWidgetsAdd` is `orchestration:operate` and is **not** in the MCP
  watch toolkit (tools.ts:146-159 — no widget-add tool), so agents cannot reach it
  directly; the actor is an operate-scope WS client. Sandbox posture is kind/manifest
  driven, unaffected by the string (contract comment watch.ts:63-65 confirms intent).

Downgrade rationale: forging requires operate scope on a client that can already add
arbitrary `agent:` widgets; the only delta is which badge text renders. Real but
marker-only → LOW.

**Fix direction**: when `provenance` is `pack:<id>`, look up
`watch_pack_widget_sources` for `(packId, sourceId)` matching the kind's
`agent:<sourceId>` and reject `WatchPageError` otherwise. The lookup can join through
`ConnectorService`'s `selectWidgetSourceRows` query pattern.

## Finding 4 — stream envelopes + `WatchWidgetErrorState` not forward-compatible — VERIFIED-DEFECT (LOW, downgraded)

Code verified:

- `WatchNotificationStreamItem` (watch.ts:986-996), `WatchConnectorStreamItem`
  (1152-1162), `WatchWidgetErrorState` (1112-1149, 7 `cause` members) are plain
  `Schema.Union`; `WatchNotificationEvent` uses `ForwardCompatibleUnion` with the
  "newer server may add event types" rationale (930-945). Confirmed.
- Failure mode confirmed end-to-end: both envelopes are stream `success` schemas
  (rpc.ts:2110-2115, 2267-2272); vendored `RpcClient.ts:739-751` turns a chunk decode
  failure into a defect `Exit` ending that request; client-runtime
  `subscribeDynamicMapped` (`rpc/client.ts:337-387`) treats `Die` causes as fatal — no
  resubscribe. One undecodable item kills the subscription for the session, exactly as
  claimed.
- Inconsistency with stated intent: PLAN:193 asks for forward-compatible decoding
  broadly; the file's own comment justifies FC for pinned mobile clients. A new widget
  `cause` (e.g. surfacing `egressBlocked`/`watchLimitExceeded` granularly — today all
  collapse to `configMismatch`, `ConnectorPoller.ts:151-165`) is a plausible additive
  change that would kill every older client's connector stream while it persists.

Downgrade rationale: latent — no incorrect behavior today; it converts a future additive
schema change from graceful-degradation into broken subscriptions. Real design-consistency
defect, cheap fix → LOW.

**Fix direction**: wrap `WatchWidgetErrorState` in `ForwardCompatibleUnion(members,
"cause")` — it is data, highest value; optionally wrap both envelopes in
`ForwardCompatibleUnion(members, "type")`. Callers must handle `UnknownUnionMember`
(`isUnknownUnionMember` exists in baseSchemas.ts:256).

## Finding 5 — `WatchPage` doc promises revision-guarded rename/reorder — VERIFIED-DEFECT (LOW, downgraded)

Code verified:

- `WatchPageRenameInput`/`WatchPageReorderInput` carry no `expectedRevision`
  (watch.ts:243-254). Confirmed.
- `rename` (`WatchPageService.ts:603-634`) bumps `revision` unconditionally — LWW;
  `reorder` (636-707) rewrites `order_key`/`updated_at`, touching no revision. Confirmed.
- The contract doc (watch.ts:28-30) claims `revision` guards "layout, membership,
  rename/reorder" — an overstatement vs both code and PRD:87-91, which scopes revision
  checks to layout + membership only. The comment is the outlier; LWW for name/order is
  itself a reasonable choice.

Doc-level misstatement of the concurrency contract, not a logic bug → LOW.

**Fix direction**: correct the comment — "`revision` guards layout and membership writes;
rename/reorder are last-writer-wins (rename still bumps `revision`, invalidating in-flight
layout writes)". No `expectedRevision` needed on reorder — it bumps nothing and guards
nothing.

Overlap: **exact duplicate of report 3 finding 4** (same lines, same fix options).

## Notes for the integrator

- F2 and F5 are claimed by two reports each; dedupe at integration (report-1 ↔ report-2
  F2; report-1 ↔ report-3 F4).
- F1 pairs naturally with report 7 finding 2: fixing subscribe-side `widgetId`/threshold
  validation and the resubscribe latch/dedupe issue in one pass avoids shipping a
  validation fix that still lets resubscribes re-emit.
- No finding here is exploitable from an unauthenticated position; all require a granted
  token (read for F1, operate for F2/F3). F2 has the worst blast radius (cleartext
  secret broadcast).
