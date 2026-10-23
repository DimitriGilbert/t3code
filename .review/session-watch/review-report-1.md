# Review — Cluster 1: Contracts & permissions (feat/watch-screen)

Scope: `packages/contracts/src/watch.ts`, `rpc.ts` (watch block/defs/group), `baseSchemas.ts`,
`server.ts` (watch flags), `clientRpcPermissions.ts`, `keybindings.ts` (contracts + shared),
`index.ts`. Cross-checked against `apps/server/src/auth/RpcAuthorization.ts`, `ws.ts` handler
wiring, `WatchPageService`, `ConnectorService`, `ConnectorPoller`, `ConfirmationTokens`,
`PackStore`, and the web `WatchAppFrame`/`watchAppBridge` host to validate contract claims.

Verified clean (no findings): all 40 `WS_METHODS.watch*` entries have `Rpc.make` defs and are
in `WsWatchRpcGroup` (rpc.ts:656-695 → 2517-2558); scope map in `RpcAuthorization.ts` is
complete and the confirm/purge = `environment:maintain` + client-guarded split is deliberate
and tested (RpcAuthorization.test.ts:210-241); branded ids in baseSchemas.ts are consistent;
`e`/`watch.editPage` when-clause is correctly gated by `watchPageOpen && !editableFocus` and
`watchPageOpen` is supplied in `CommandPalette.tsx:438`; server.ts flags are optional-boolean
kill switches; history `limit` is clamped server-side; confirmation tokens are single-use,
TTL'd, and bound to `(requestId, manifestHash)`; the sandbox host enforces manifest-declared
subscriptions/actions and connector-bound-only instance access.

## Findings

### [SEVERITY: MEDIUM] Finding 1: `watchConnector.subscribe` is read-scoped but carries write-effect payload

**File**: packages/contracts/src/watch.ts:604-617, apps/server/src/auth/RpcAuthorization.ts:164
**Problem**: `watchConnectorSubscribe` is declared `AuthOrchestrationReadScope`, yet
`WatchConnectorSubscribeInput` accepts `thresholds`, `widgetId`, and `refreshPolicy` — none of
which are read concerns. Server-side, `ConnectorPoller.subscribe` registers each rule and
evaluates it on every changed snapshot; a false→true crossing calls `notifications.emit`,
which writes a durable `watch_notifications` history row and delivers to all connected clients
(ConnectorPoller.ts:401-426, 778-781). The `widgetId` used for attribution is caller-chosen and
never validated against a real widget, so a read-only token can emit persisted, user-facing
`widget.threshold` notifications attributed to an arbitrary widget. `refreshPolicy` also feeds
the shared `min-of-subscribers` poll interval (floor-clamped), and the first subscriber forces
an upstream fetch (ConnectorPoller.ts:792).
**Evidence**: `thresholds: Schema.optionalKey(Schema.Array(WatchConnectorThresholdRule))` and
`widgetId: Schema.optionalKey(WatchWidgetId)` on the subscribe payload; scope entry
`[WS_METHODS.watchConnectorSubscribe]: AuthOrchestrationReadScope`.
**Impact**: A read-only token (e.g., a view-only grant) gains a durable write channel:
notification-history spam, fake threshold alerts pinned to any widgetId, and upstream fetch
triggering on every connector instance. Every other `subscribe*`/`list` method in the map is a
pure read.
**Suggestion**: Either (a) raise `watchConnector.subscribe` to `orchestration:operate` — the
subscription configures server behavior, so it is not a read — or (b) split the payload: keep
the bare snapshot stream read-scoped and move `thresholds`/`widgetId` registration into an
operate-scoped method; server-side, validate `widgetId` resolves to a real widget row before
attributing notifications to it.

### [SEVERITY: MEDIUM] Finding 2: Declared secret keys can be stored cleartext in instance `config`

**File**: packages/contracts/src/watch.ts:494-497, 699-706; enforcement gap at
apps/server/src/watch/connectors/ConnectorService.ts:411-446, 716-721, 820-828
**Problem**: The contract states `config` holds "no secrets — those live in the secret store
by key", but nothing enforces the disjointness. `undeclaredSecretKey` checks that `secrets`
keys ⊆ `manifest.secretKeys`, and `validateConfigAgainstManifest` only applies the pack's
`authSchema` — neither rejects a `config` key that is a manifest-declared secret key. A
`setInstanceConfig` (or `createInstance`) call carrying `config: { apiKey: "sk-…" }` where
`apiKey` is declared in `secretKeys` (and in `authSchema.properties`) stores the value
cleartext in `config_json` and returns it in `WatchConnectorInstance.config`, which is
broadcast by `watchConnectors.listInstances`/`subscribeInstances` to every
`orchestration:read` client and to agents via the MCP `t3_watch_connectors_list` tool.
**Evidence**: `config: Schema.Record(Schema.String, Schema.Unknown)` on the instance row and
inputs; `undeclaredSecretKey` iterates only the `secrets`/`clearSecretKeys` maps
(ConnectorService.ts:448-463); no `config`-vs-`secretKeys` intersection check.
**Impact**: Any credential that lands in `config` — via a UI bug, a careless pack `authSchema`,
or an agent calling `config_set` — is persisted in cleartext and readable by read-scoped
clients and agents, bypassing the secret-store boundary the contract advertises.
**Suggestion**: In `createInstance`/`setInstanceConfig`, reject (or strip) `config` keys that
appear in `manifest.secretKeys` — e.g., reuse `undeclaredSecretKey` inverted, or a
`configInvalid` failure naming the field. Consider the same rule for keys that _look_ secret
but are only in `authSchema` is out of scope; the declared-key intersection is the enforceable
invariant.

### [SEVERITY: MEDIUM] Finding 3: Caller-settable `pack:` provenance on `watchWidgets.add` is unverified

**File**: packages/contracts/src/watch.ts:309-324; apps/server/src/watch/WatchPageService.ts:353-367
**Problem**: `WatchWidgetAddInput.provenance` accepts any `pack:<packId>` template literal.
The server's only check is `kind.startsWith("agent:")` (`provenanceForAdd`); it never verifies
the named pack exists, is installed, or actually registered a widget source for that kind's
`sourceId`. Any `orchestration:operate` WS client can therefore stamp `pack:some.trusted.pack`
onto an arbitrary agent-published widget.
**Evidence**: `provenance: Schema.optionalKey(WatchWidgetPackProvenance)` on the add input;
`return kind.startsWith("agent:") ? provenance : "invalid";` in `provenanceForAdd`.
**Impact**: The provenance chrome marker — the user's only signal that widget code shipped in
a human-approved connector pack — can be forged. Confirmed marker-only (sandbox posture is
kind/manifest-driven, not provenance-driven; pack-uninstall degradation keys off
`widgetSources` registrations, not the provenance string), but it is a spoofable trust
indicator on the security boundary's label.
**Suggestion**: Server-side, when `provenance` is supplied, look up the pack widget-source
registration (`watch_connector_pack_widget_sources`) and accept only a `pack:<packId>` whose
registration produced the kind's `agent:<sourceId>`; otherwise reject with `WatchPageError`.
Alternative: remove `provenance` from the RPC payload and set it internally when the add is
dispatched by a confirmed pack install.

### [SEVERITY: MEDIUM] Finding 4: Stream envelopes and `WatchWidgetErrorState` are not forward-compatible

**File**: packages/contracts/src/watch.ts:986-996, 1112-1149, 1152-1162
**Problem**: `WatchNotificationEvent` deliberately uses `ForwardCompatibleUnion` so "a newer
server may add event types" without breaking older clients. But the two stream envelopes that
carry feature data — `WatchNotificationStreamItem` (`prefs`/`notification`) and
`WatchConnectorStreamItem` (`snapshot`/`error`) — and `WatchWidgetErrorState` (7 `cause`
members, embedded in the connector stream) are plain `Schema.Union`s. A newer server adding a
stream item type or a widget error cause (e.g., `rateLimited`, `egressBlocked`) produces an
element older clients cannot decode — which fails the RPC stream element and kills the whole
subscription rather than skipping one item.
**Evidence**: `export const WatchWidgetErrorState = Schema.Union([...])` (plain union);
`WatchConnectorStreamItem = Schema.Union([{type:"snapshot"...},{type:"error"...}])`;
`WatchNotificationStreamItem = Schema.Union([...])` — contrast `WatchNotificationEvent =
ForwardCompatibleUnion([...], "type")` at watch.ts:934.
**Impact**: The forward-compat guarantee the file explicitly designs for stops at the envelope
level: any additive notification-stream item or widget error cause severs live subscriptions
for every older client (including pinned mobile builds — the stated reason for the notification
union's design).
**Suggestion**: Wrap `WatchWidgetErrorState` in `ForwardCompatibleUnion(members, "cause")` and
both stream envelopes in `ForwardCompatibleUnion(members, "type")`, matching the notification
union. If envelopes are intentionally closed, document that and at minimum make
`WatchWidgetErrorState` forward-compatible since it is data, not protocol.

### [SEVERITY: MEDIUM] Finding 5: `WatchPage` doc promises revision-guarded rename/reorder; inputs have no `expectedRevision`

**File**: packages/contracts/src/watch.ts:28-31, 243-254; apps/server/src/watch/WatchPageService.ts:603-707
**Problem**: The `WatchPage` doc states "`revision` guards page-level writes (layout,
membership, rename/reorder)", but `WatchPageRenameInput` and `WatchPageReorderInput` carry no
revision field and the server applies them last-writer-wins: `rename` bumps `revision`
unconditionally, `reorder` rewrites `order_key` without touching any revision. Two clients
renaming/reordering concurrently silently clobber each other while the contract comment claims
conflict detection.
**Evidence**: `WatchPageRenameInput = { pageId, name }`; `WatchPageReorderInput = { pageId,
beforePageId }`; server `rename`/`reorder` do not read any expected revision.
**Impact**: Contract-level misstatement of the concurrency model — other client
implementations (mobile, third-party) reading the schema comment will expect
`WatchPageRevisionConflictError` behavior that rename/reorder never produce. (Not exploitable;
behavior itself is a reasonable LWW choice for name/order.)
**Suggestion**: Either correct the comment to scope `revision` to layout/membership (and note
rename/reorder are LWW), or add `expectedRevision` to both inputs to match the documented
guarantee. Note rename already bumps `revision`, which safely invalidates in-flight layout
edits; reorder does not bump anything and does not need to.
