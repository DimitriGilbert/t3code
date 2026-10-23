# Review — Cluster 11: Server wiring (ws, MCP, auth, config, layers)

Branch `feat/watch-screen`, diff base `3feae3a9`.

## Coverage verification (all clean)

- **Group split**: `WS_METHODS.watch*` in contracts = 40 tags; `WS_WATCH_METHOD_TAGS` omit list in `ws.ts` = same 40, no dupes, no extras; `ServerWsWatchRpcGroup.of({...})` handlers = same 40. Verified mechanically (1:1:1). `WsWatchRpcGroup` carries `RpcScopeAuthorization` middleware itself (`rpc.ts:2558`), and `ServerWsWatchRpcGroup` adds `RpcInstrumentation`, so auth+tracing apply to the split layer identically to core. `RpcServer.make` still targets the full `ServerWsRpcGroup`; merged handler layers resolve per-tag.
- **Scopes**: `RPC_REQUIRED_SCOPES` covers all 40 (also `satisfies`-enforced). `confirmInstall`/`confirmUpgrade`/`purgeInstanceData` at `AuthEnvironmentMaintainScope` and in `CLIENT_GUARDED_RPC_SCOPES`; `clientRpcRequiredScopes` returns the guarded scope before the static map.
- **MCP toolkit**: 12 tools; no prepare/confirm/purge tool (test-enforced, `tools.test.ts:25`). Handlers are thin decode→service→`unavailable` wrappers using the same contract input schemas as WS. `list` returns `configuredSecretKeys` (names only) — no secret values. `requestInstall` strips a request-supplied `allowLocalUrl` (`ConnectorService.ts:511`) and defers private-resolving https origins to the human-acked prepare. Install-request schema has no token field, so `t3_watch_connectors_list` can't leak minted tokens.
- **Layers**: `layerWatchToolkit` deps (UserNotificationService, WidgetTranspileService, ConnectorService, ThreadManagementService) resolve ambiently via `provideMerge(layerOrchestrationApplication)` → `layerProduction`. `WatchPageService.layer` needs `SqlClient`/`Crypto` — ambient. `layerUserNotificationsProvided`/`layerWidgetTranspileProvided` are reused by reference inside `layerConnectorsProvided`/`layerConnectorPollerProvided`, so memoization yields single instances.
- **Handlers**: `ws.ts` watch handlers are thin delegates with span annotations only; no business logic.

## Findings

### [SEVERITY: MEDIUM] Finding 1: "Human-only" prepare/token-mint RPCs are reachable by any operate-scope client, and `allowLocalUrl` is self-asserted

**File**: apps/server/src/auth/RpcAuthorization.ts:152,162

**Problem**: `watchConnectorsPrepareInstallConfirm` and `watchConnectorsPreparePurge` are scoped `AuthOrchestrationOperateScope`. The contracts and service comments claim these are "minted only for a UI client" / "the human-acked prepare step", but nothing at the auth layer distinguishes a UI human from any other `orchestration:operate` token holder. Concretely, for a `localUrl` (private-resolving) install request, `prepareInstallConfirm` performs the deferred private-range fetch gated only on `input.allowLocalUrl === true` (ConnectorService.ts:1210-1222) — a boolean the caller sets on its own request.

**Evidence**: `RPC_REQUIRED_SCOPES[WS_METHODS.watchConnectorsPrepareInstallConfirm] = AuthOrchestrationOperateScope` (line 152); contract doc on `WsWatchConnectorsPrepareInstallConfirmRpc`: "Minted only for a UI client … an agent can never reach the token" (rpc.ts:2187-2191).

**Impact**: An agent genuinely cannot reach this (no MCP tool, MCP is the only agent surface), and consumption still requires `environment:maintain`, so the install/purge itself is safe. What a non-admin operate-scope WS client _can_ do: mint single-use confirmation tokens and force the server to fetch an internal/loopback URL it declared in its own request — bypassing the documented "only the human may fetch" invariant. Bounded in practice: operate scope already implies server-side code execution via agent threads/terminal, so this is defense-in-depth drift, not a new boundary.

**Suggestion**: Either scope the two prepare methods to `AuthEnvironmentMaintainScope` (the human confirm already needs maintain, so no legitimate flow is blocked) and drop them from the "standard-scope" carve-out, or rewrite the comments to state the real invariant: any operate-scope caller may ack `allowLocalUrl`; the boundary that matters is `environment:maintain` on consume.

### [SEVERITY: MEDIUM] Finding 2: Agent-reachable `t3_watch_notifications_prefs_update` can mute the server's notification types, including ones surfacing its own install requests

**File**: apps/server/src/mcp/toolkits/watch/tools.ts:54-60; apps/server/src/mcp/toolkits/watch/handlers.ts:16-20

**Problem**: The prefs tool replaces server-wide `WatchNotificationPrefs` — mute/unmute event types and watch pages, set snooze horizons — and is a `McpToolAccess.writes` tool callable by any live agent thread. The tool description confirms prefs gate delivery to all clients.

**Evidence**: `WatchNotificationsSetPrefsTool` "Replace this server's notification delivery prefs: mute or unmute event types and watch pages, or set a snooze horizon."; handler calls `notifications.setPrefs(prefs)` unconditionally.

**Impact**: An agent that opens a connector install/upgrade request can mute the notification types that would draw a human's attention to it (or snooze all delivery), reducing oversight of its own actions. Mitigations: notification _history_ always records, and the human confirm path is driven by the pending-request list (`watchConnectors.listInstances`), not by notifications — so approval can't be silently bypassed, only made less visible.

**Suggestion**: Consider excluding security-significant event types (install-request/connector lifecycle) from agent-mutable prefs, or recording a notification-history entry whenever prefs change so the muting itself is auditable (if not already emitted). If deliberate, a comment noting that history is the tamper-evident record would close the loop.

## Notes (not findings)

- `watchConnectorSubscribe` at read scope lets read-only clients drive connector poll loops (executing approved pack code with resolved secrets, up to the 1000ms `MIN_POLL_FLOOR_MS` floor). This is the intended subscriber-driven design for dashboards; egress is manifest-pinned to approved `egressHosts`.
- `t3_watch_connector_request_install`/`request_upgrade` fetch public https and local-path origins at request time — intended; private resolution defers correctly, and agent host == server host so local-path read is not an escalation.
- `t3_watch_connector_instance_delete` removes stored secret values (destructive, annotated); `uninstall`/`rollback` agent-reachable per documented design (reversible / re-pins approved code only).
- `tools.test.ts` asserts no prepare/confirm/purge tool exists — good regression guard.
