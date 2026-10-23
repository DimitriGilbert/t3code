# Verify Report 11 — Server wiring (ws, MCP, auth, config, layers)

Re-checked against `apps/server/src/auth/RpcAuthorization.ts`,
`packages/contracts/src/{rpc.ts,watch.ts,auth.ts,clientRpcPermissions.ts}`,
`apps/server/src/watch/connectors/ConnectorService.ts`,
`apps/server/src/notifications/UserNotificationService.ts`,
`apps/server/src/mcp/toolkits/watch/{tools,handlers,tools.test}.ts`,
`apps/server/src/auth/{SessionStore,EnvironmentAuth}.ts`, `apps/server/src/ws.ts:3381-3404`,
and intent docs `.plans/welcome-screen/{PLAN,PRD}.md`.

Verdict counts: **1 VERIFIED-DEFECT, 1 VERIFIED-INTENTIONAL, 0 REJECTED.**

---

### F1 — prepare/token-mint RPCs at operate scope, `allowLocalUrl` self-asserted — VERIFIED-DEFECT (LOW; scope choice itself VERIFIED-INTENTIONAL)

All mechanics confirmed:

- `watchConnectorsPrepareInstallConfirm`/`watchConnectorsPreparePurge` are
  `AuthOrchestrationOperateScope` (RpcAuthorization.ts:152,162), _not_ in
  `CLIENT_GUARDED_RPC_SCOPES` (clientRpcPermissions.ts:14-59 guards only confirm×2 +
  purge), so `clientRpcRequiredScopes` falls through to the static map → operate.
- `prepareInstallConfirm` performs the deferred private-range fetch gated solely on
  `input.allowLocalUrl === true` on the same call (ConnectorService.ts:1210-1222).
- No MCP tool exists for prepare/confirm/purge (tools.test.ts:25-36 asserts by regex).
- Consumption is safe: `confirmInstall`/`confirmUpgrade`/`purgeInstanceData` require
  `environment:maintain` + a bound single-use token (RpcAuthorization.ts:153-154,163).

**Intent cross-check: the operate scope is deliberate.** PLAN.md:367-370 pins exactly
this ("`prepareInstallConfirm` … standard scope but **not in MCP toolkit**");
RpcAuthorization.ts:150-151,160-161 and ConnectorService.ts:74-78 comment it as a
"standard-scope call" whose security boundary is maintain-on-consume. The self-asserted
`allowLocalUrl` is the same design verifier-5 already called VERIFIED-INTENTIONAL
(verify-report-5 F4b) — the request leg strips it (ConnectorService.ts:507-512);
the ack lives on the human-driven prepare leg by design.

**What remains a defect is the contract doc**, not the scope. `rpc.ts:2187-2190` and
`rpc.ts:2239-2242` say "Minted **only for a UI client**" — false: nothing distinguishes
a UI client from any other `orchestration:operate` session. The operative claim
("an agent can never reach the token") holds under the MCP-only agent surface, but the
comment asserts a stronger invariant than is enforced, exactly where a future maintainer
would look. (Context that further weakens "UI-only": `AuthStandardClientScopes` already
contains `environment:maintain`, auth.ts:205-219, so every standard paired client can
confirm anyway — the operate/maintain split only binds reduced-grant tokens.)

Severity: downgrade to **LOW**. The finding's own bound is right — operate implies
code execution (`launchThread`/`dispatchCommand` are operate, RpcAuthorization.ts:47,58)
— and the scope was deliberate, so this is doc drift + optional hardening, not a MEDIUM.

**Fix directions** (either, cheap):

- Reword the two doc comments (rpc.ts:2187-2191, 2239-2242; watch.ts:822) to the real
  invariant: minting is any-operate-scope; `allowLocalUrl` is caller-asserted; the
  enforced boundary is `environment:maintain` on consume + MCP absence.
- Or harden per the suggestion: scope both prepare RPCs to `AuthEnvironmentMaintainScope`.
  Safe — standard clients already hold maintain, and it would make "only maintain
  holders ack `allowLocalUrl`" actually enforced for reduced-scope tokens.

### F2 — agent-reachable `t3_watch_notifications_prefs_update` — VERIFIED-INTENTIONAL (with one overstated claim)

Confirmed mechanics:

- Tool is in `WatchToolkit` (tools.ts:54-60), wrapped `McpToolAccess.writes`
  (handlers.ts:16-20) → callable by any live agent thread.
- `setPrefs` replaces the server-wide singleton `watch_notification_prefs` row
  unconditionally and broadcasts a `prefs` stream item (UserNotificationService.ts:431-447).
  `mutedEventTypes` accepts every `WatchNotificationEventType`; `snoozedUntil` suppresses
  all delivery; delivery filtering is client-side off these shared prefs
  (UserNotificationService.ts:42-45).

**Intent: explicitly spec'd agent-callable.** PRD.md:178 service table:
"notification prefs (mute/snooze/history) | standard | **yes**"; PLAN.md:317-320
mandates the MCP entries "agent-callable per PRD table".

**One claim in the finding is wrong**: "mute/snooze types surfacing its own install
requests" — no install-request notification type exists. The union is only
`thread.{completed,failed,awaitingInput}`, `connector.{unhealthy,authExpired,rolledBack}`,
`widget.threshold` (watch.ts:948-956); `requestInstall` emits nothing (the only
ConnectorService emit is `connector.rolledBack`, :1618). Pending requests surface via
`watchConnectors.listInstances`, which prefs cannot hide — the finding itself concedes
approval can't be bypassed.

**Residual real behavior**: an agent _can_ mute `connector.rolledBack` delivery —
the notification covering a genuinely agent-reachable action (rollback tool exists) —
and can snooze all delivery for every client server-wide. Mitigations confirmed:
history is append-only and always records (`ON CONFLICT DO NOTHING`,
UserNotificationService.ts:178-197); the tool description states "history always
records"; a live `prefs` stream item does reach subscribers. **Not confirmed:**
no durable audit entry for the prefs change itself — `setPrefs` writes the row and
publishes the stream item only, so a muted-then-restored window leaves no trace in
history that muting happened.

**Fix directions** (hardening, optional): emit a notification-history entry on
`setPrefs` (the tamper-evident record the design already relies on), or exclude
`connector.*` types from agent-mutable `mutedEventTypes`. If neither lands, a comment
in tools.ts noting "history is the audit record; delivery suppression is accepted" closes
the loop. LOW either way.

---

## Notes

- Same-host-agent caveat (general, not a new finding): `VerifiedSession.scopes` come
  from the _signed claims_, not the session row (SessionStore.ts:858), and the signing
  secret lives in the T3 secret store readable by same-UID processes — so WS scopes
  are not a boundary against an agent with filesystem access to `T3CODE_HOME`. This
  applies to every RPC equally (confirms included) and doesn't change either verdict:
  it makes F1's "defense-in-depth" framing _more_ accurate, not less.
- `watchConnectorsCancelInstallRequest` is operate-scope (RpcAuthorization.ts:155) with
  no MCP tool — consistent; PRD:175 marks cancel "admin, human UI only" but that is not
  among this report's findings. Worth a glance if F1's scope raise lands.
