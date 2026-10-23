# Exploration map — feat/watch-screen

Branch base: `3feae3a9` (merge-base with main). 142 files changed, ~29.4k insertions,
~21 deletions. 16 commits. The feature is a user-composable watch/dashboard surface:
SQL-backed page/widget store, notification feed, connector pack system (human-confirmed
install, http/file transports, poller, sandboxed pack modules, versioning/rollback),
server-side esbuild widget transpilation, a hardened srcdoc/WebView sandbox host for
agent-authored widgets, a web dashboard UI, and a mobile follower UI.

## Structure overview

```
packages/contracts/src/watch.ts          All wire schemas + errors (pages, widgets, connectors,
                                         notifications, widget sources, gallery, bridge manifest)
packages/contracts/src/rpc.ts            WS_METHODS.watch*, WsWatchRpcGroup (merged into WsRpcGroup)
packages/contracts/src/clientRpcPermissions.ts  environment:maintain gate on confirm/purge
apps/server/src/persistence/Migrations/  063–066 watch tables
apps/server/src/watch/                   WatchPageService, WidgetTranspileService, gallery,
                                         connectors/ (service, poller, transports, pack store/module),
                                         __fixtures__/clanker-pack
apps/server/src/notifications/           UserNotificationService
apps/server/src/mcp/toolkits/watch/      MCP toolkit + handlers (no confirm/purge tools)
apps/server/src/ws.ts                    WsWatchRpcGroup handler subgroup (split for typecheck budget)
packages/client-runtime/src/state/       watch.ts (RPC atoms), watchPages, watchWidgets,
                                         watchConnectors, watchNotifications, watchMounts
packages/client-runtime/src/watchAppBridge.ts  Transport-free JSON-RPC bridge + host document
apps/web/src/components/watch/           Board, shells, bodies, dialogs, notifications, app frames
apps/web/src/routes/watch.tsx            /watch route
apps/mobile/src/features/watch/          Follower screen, sections, WebView widget host
```

## Clusters

### 1. Contracts & permissions (8 files)

- `packages/contracts/src/watch.ts` — 1162 lines of schemas: `WatchPage` (dual
  `revision`/`mobileRevision`), `WatchWidget` + placement/provenance/config, gallery
  templates, notification events/prefs/stream items, connector pack manifests/origins/
  instances/install-requests/transports/threshold rules, widget source records and the
  `WatchWidgetBridgeManifest`, all `Watch*Error` classes.
- `packages/contracts/src/watch.test.ts` _(test)_
- `packages/contracts/src/rpc.ts` — `WS_METHODS.watch*` (40 tags), per-method Rpc defs,
  `WsWatchRpcGroup` merged into `WsRpcGroup`.
- `packages/contracts/src/baseSchemas.ts` — 7 new branded entity ids.
- `packages/contracts/src/server.ts` — `ServerConfig.watchScreen`,
  `watchAgentWidgetsMobile` capability flags.
- `packages/contracts/src/clientRpcPermissions.ts` — `watchConnectorsConfirmInstall`,
  `ConfirmUpgrade`, `PurgeInstanceData` → `AuthEnvironmentMaintainScope`.
- `packages/contracts/src/index.ts`, `packages/shared/src/keybindings.ts`,
  `packages/contracts/src/keybindings.ts` — export barrel + `watch.open`/`watch.editPage`
  commands and the bare `e` keybinding.

Deps: none (root of the graph). **Focus:** schema invariants (forward-compat unions,
provenance template literal, revision semantics, threshold rule shape), RPC method
grouping, which methods are read vs operate vs environment:maintain, and the
keybinding `when` clause (`watchPageOpen && !editableFocus`).

### 2. Persistence migrations (5 files)

- `apps/server/src/persistence/Migrations/063_WatchScreen.ts` — `watch_pages`,
  `watch_widgets` (placement cols, mobile_order/hidden, provenance).
- `064_WatchNotifications.ts` — append-only `watch_notifications`, singleton prefs row,
  per-event-type `watch_notification_cursors`.
- `065_WatchConnectors.ts` — `watch_connector_packs` (PK pack_id+schema_version =
  approved-manifest history), `watch_connector_instances` (secret_keys records declared
  keys only, never values).
- `066_WatchConnectorVersioning.ts` — `watch_pack_widget_sources`.
- `apps/server/src/persistence/Migrations.ts` — registration.

**Focus:** schema matches contracts shapes; indexes; PK choices; that instance config
can never persist secret values.

### 3. Page/widget store + gallery (4 files)

- `apps/server/src/watch/WatchPageService.ts` — 1337 lines: full CRUD, reorder/
  duplicate/archive/restore, scope updates, widget add/remove/configure/setLayout/
  setMobileProjection/moveToPage, gallery instantiation, `subscribeList` PubSub,
  revision-checked mutations, `WatchLayoutCollisionError`.
- `apps/server/src/watch/gallery.ts` — starter template list (instantiated into real
  rows, not seeded).
- `apps/server/src/watch/WatchPageService.test.ts` _(test)_
- `apps/server/src/project/ProjectService.ts` (M) — archives project-scoped pages on
  project delete rather than deleting them.

Deps: contracts, SqlClient, PubSub. **Focus:** revision conflict handling, dual
revision split (desktop layout vs mobile projection), collision detection, orderKey
generation, archive semantics.

### 4. Notification service (2 files)

- `apps/server/src/notifications/UserNotificationService.ts` — taps post-commit
  orchestration event stream per consumed event type, maps domain events →
  `WatchNotification`, append-only history with `INSERT ... ON CONFLICT DO NOTHING`
  dedupe by deterministic notificationId, per-type `last_sequence` resume cursors,
  full-replace prefs. Delivery/mute/snooze deliberately client-side.
- `UserNotificationService.test.ts` _(test)_

Deps: EventSinkV2, ProjectionStoreV2, SqlClient, PubSub. **Focus:** cursor resume
correctness, dedupe-by-id on replay, event→notification mapping completeness,
history retention/unbounded growth.

### 5. Connector service + install confirm gate (4 files)

- `apps/server/src/watch/connectors/ConnectorService.ts` — 1828 lines: instance CRUD,
  setInstanceConfig, requestInstall/requestUpgrade, prepare/confirm install+upgrade,
  cancel, rollback, uninstall, prepare/purge instance data, pack widget source
  registration at confirm time, `subscribeInstances`.
- `apps/server/src/watch/connectors/ConfirmationTokens.ts` — in-memory single-use
  5-min tokens bound to (requestId, manifestHash); minted only by the prepare RPC,
  consumed on confirm; deleted on consume whether valid or not.
- `ConnectorService.test.ts`, `ConfirmationTokens.test.ts` _(tests)_

Deps: PackStore, WidgetTranspileService, UserNotificationService, SqlClient, secrets.
**Focus:** the human-confirm gate end-to-end (token binding, TTL, single-use, absent
from MCP), manifest hash pinning, upgrade/rollback version pinning, secret handling
(declared-keys-only), purge token flow.

### 6. Pack runtime: store, module sandbox, transports (9 files)

- `PackStore.ts` — 702 lines: local-dir and URL installs (`{manifest, files}` JSON
  bundle), content-hash-pinned storage under `<stateDir>/connectors/<packId>/<hash>/`,
  re-hash on every read, size caps, redirect hop limit, private-range blocklist +
  DNS-pinned fetch for remote installs.
- `PackModule.ts` — pack `connector.js` evaluated in `node:vm` realm per run
  (CommonJS-style `module.exports = {fetch, transform, migrateConfig}`), no ambient
  `require`/`process`/`fetch`, eval timeout, 256KB snapshot cap, typed
  AuthExpired/SecretAccess errors.
- `HttpTransport.ts` — `ctx.fetch` egress gate: host checked against manifest
  `egressHosts` (exact + `*.` wildcard), http(s)-only, default 30s timeout.
- `FileTransport.ts` — allowlisted `watch.roots`/`globs`/`maxDepth`, realpath
  confinement rejecting symlink escapes, file count/byte/depth caps, debounced rescan.
- `PackStore.test.ts`, `PackModule.test.ts`, `HttpTransport.test.ts`,
  `FileTransport.test.ts` _(tests)_

Deps: contracts, NodeHttpClient, node:vm/dns/net. **Focus:** this is the security
core — sandbox escape surface, egress bypass (redirects, DNS rebinding, casing,
wildcard apex), symlink/realpath confinement, cap enforcement.

### 7. Connector poller (5 files)

- `ConnectorPoller.ts` — 806 lines: per-instance poll runtime; effective interval =
  min over subscriber `refreshPolicy` requests clamped to `pollFloorMs`; shared
  snapshot cached and fanned out via sliding(1) PubSub; exponential backoff on
  consecutive failures; fs.watch-triggered runs for file transport; re-verifies pack
  content hash each run; health transitions emit `connector.unhealthy`/`authExpired`
  notifications; widget-declared threshold rules → notification events.
- `ConnectorPoller.test.ts`, `FileConnectorLatency.test.ts` _(tests)_
- `__fixtures__/stub-clanker.mjs`, `__fixtures__/clanker-pack/{manifest.json,
connector.js, widgets/runs.tsx}` _(test fixtures)_

Deps: ConnectorService, PackStore, PackModule, both transports,
UserNotificationService. **Focus:** backoff/interval math, fan-out freshness,
failure accounting, threshold rule evaluation, lifecycle (instance delete/disable).

### 8. Widget transpile pipeline + packaging (7 files)

- `apps/server/src/watch/WidgetTranspileService.ts` — 590 lines: `publish` validates
  bridge manifest, esbuild-bundles single-file TS/TSX → IIFE cached on disk under
  `widgetArtifactsDir` by content hash; rejects all imports; JSX → `T3.h`/`T3.Fragment`
  host global; failed builds recorded as `transpileFailed` data, not call failures;
  source-size/rate limits. esbuild loaded via `createRequire` (SEA-safe).
- `WidgetTranspileService.test.ts` _(test)_
- `apps/server/package.json` — new `esbuild@0.28.2` dep.
- `scripts/lib/cli-external-packages.ts` (+`.test.ts`) — `esbuild`, `@esbuild/`
  externalized from CLI bundle.
- `scripts/build-desktop-artifact.ts` (+`.test.ts`) — disables esbuild postinstall in
  staged cross-platform builds.
- `pnpm-lock.yaml` _(lockfile — skip)_

**Focus:** artifact integrity (hash-naming, read-back), import rejection completeness,
rate/size limits, the `T3` JSX contract vs the host prelude (cluster 9).

### 9. Shared sandbox host: bridge + web/mobile frames (12 files)

- `packages/client-runtime/src/watchAppBridge.ts` — 557 lines: JSON-RPC 2.0 over
  postMessage; `buildWatchAppDocument` generates the hardened host document (CSP
  hash-authorizes prelude + artifact, `connect-src 'none'`); `makeWatchAppHost`
  enforces the declared manifest — undeclared subscriptions/actions dropped and
  surfaced as violations; connector data authorized against the widget row's
  configured instance id (frame-supplied ids never trusted); 256KB message cap,
  16 pending-request cap.
- `packages/client-runtime/src/watchAppBridge.test.ts` _(test)_
- `apps/web/src/components/watch/WatchAppFrame.tsx` — srcdoc iframe,
  `sandbox="allow-scripts"` only (no same-origin, no forms); deliberately not
  `McpAppFrame` (whose served-doc CSP permits network/popups).
- `apps/web/src/components/watch/WatchAppWidget.tsx` — resolves artifact, wires
  bridge + mount state, missing-pack-kind degradation.
- `apps/web/src/components/watch/WatchAppTapToLoad.tsx`,
  `WatchAppSourceDialog.tsx`, `useWatchAppMounts.ts` — placeholder, source viewer,
  IntersectionObserver-driven visibility reporting.
- `apps/web/src/components/watch/WatchAppFrame.test.tsx`,
  `WatchAppWidget.test.tsx`, `useWatchAppMounts.test.tsx`,
  `watchAppPrelude.test.ts` _(tests)_
- `packages/client-runtime/package.json` — `./watch-app-bridge` + `./state/watch*`
  subpath exports.

Deps: contracts bridge manifest, ConnectorService subscribe stream. **Focus:** the
sandbox boundary — CSP string, postMessage origin checks, manifest enforcement,
message size caps, mount/unmount lifecycle leaks.

### 10. Client-runtime watch state (13 files)

- `state/watch.ts` — per-environment RPC command/query/subscription atoms for all 40
  watch methods; `isWatchPageRevisionConflict` structural check.
- `state/watchPages.ts` — 812 lines pure derivations: 12-col grid math (place, move,
  resize, reflow, collision, canonical order), medium/stack breakpoints, page
  partition/ordering, input builders for every mutation, mobile projection edits.
- `state/watchWidgets.ts` — first-party widget derivations (active work, needs
  attention, recent activity, connector status) off shared shell subscriptions;
  settings readers; error-state resolution.
- `state/watchConnectors.ts` — install/upgrade manifest diff for the confirm dialog.
- `state/watchNotifications.ts` — per-(notificationId, channel) delivery dedupe;
  desktop-native singleton channel; mute/snooze predicates.
- `state/watchMounts.ts` — LRU mount registry (`WATCH_APP_MOUNT_LIMIT = 6`),
  mounted/placeholder/unmounted transitions.
- `state/*.test.ts` ×6 _(tests)_
- `rpc/client.ts` (M) — watch subscription tags in `EnvironmentSubscriptionRpcTag`.
- `state/presentation.ts` (M) — `watchScreenSupportedAtom`.

Deps: contracts, runtime atom factories, models/threadInbox. **Focus:** grid
collision/reflow correctness, revision-conflict retry contract, subscription key
shape, mount registry edge cases, notification dedupe keying.

### 11. Server wiring: ws, MCP, auth, config, layers (10 files)

- `apps/server/src/ws.ts` (M) — `WsWatchRpcGroup` split into
  `ServerWsWatchRpcGroup`/`ServerWsCoreRpcGroup` (typecheck instantiation budget);
  ~140 lines of watch handlers delegating to services.
- `apps/server/src/mcp/toolkits/watch/tools.ts` + `handlers.ts` — toolkit: history,
  prefs update, widget source publish, connector list/CRUD/config/install-request/
  upgrade-request/rollback/uninstall. **No confirm/purge tools** — human-only.
- `tools.test.ts`, `mcp/toolkits/worktree/registration.test.ts` (M) _(tests)_
- `apps/server/src/mcp/McpHttpServer.ts` (M) — toolkit registration.
- `apps/server/src/auth/RpcAuthorization.ts` (M) + `.test.ts` (M) — scope map for all
  40 methods; confirm/purge at `environment:maintain`.
- `apps/server/src/observability/RpcInstrumentation.ts` (M) — "watch" aggregate.
- `apps/server/src/config.ts` (M) — `connectorsDir`, `widgetArtifactsDir` under T3 home.
- `apps/server/src/orchestration-v2/runtimeLayer.ts` (M) — layer composition.
- `orchestration-v2/Adapters/CodexAdapterV2.testkit.ts`,
  `orchestration-v2/testkit/ProviderReplayHarness.ts` (M) — new config paths in
  replay/test config _(test support)_.

**Focus:** handler thinness (decode → service → map error), scope assignments vs
MCP exposure matrix, that the RPC group split didn't drop/duplicate methods.

### 12. Web: board, shells, editing UI (12 files)

- `WatchScreen.tsx` — 1055 lines: page state, edit mode, all mutation commands,
  revision-conflict reload, gallery/picker/install dialogs, notification wiring.
- `WatchBoard.tsx` — dnd-kit drag/resize on the 12-col grid, responsive bands
  (edit ≥1200px, medium reflow, stack), a11y announcements.
- `WatchWidgetShell.tsx` — chrome: drag grip, edge/corner resize handles, context
  menu, settings entry, provenance marker.
- `WatchPageTabs.tsx` — 454 lines: tab bar, rename/reorder/duplicate/delete/restore.
- `WatchGalleryDialog.tsx`, `WatchWidgetPickerDialog.tsx`,
  `WatchWidgetSettingsForm.tsx` (412), `WatchWidgetBody.tsx`,
  `WatchWidgetErrorBody.tsx`, `WatchProvenanceMarker.tsx`,
  `WatchThresholdAlertBadge.tsx`, `watchUiBus.ts` — dialogs, config form,
  body dispatch, typed error rendering, cross-component action bus.

Deps: client-runtime watch-pages/mounts/bridge, dnd-kit. **Focus:** edit-mode write
paths (setLayout batching, revision conflict UX), drag/resize math vs shared
derivations, dialog → RPC flows, unmount on navigation.

### 13. Web: first-party + connector widgets (9 files)

- `widgets/WatchActiveWorkWidget.tsx`, `WatchNeedsAttentionWidget.tsx`,
  `WatchRecentActivityWidget.tsx`, `WatchTaskStarterWidget.tsx` (355 — task starter
  with project/target pickers), `WatchConnectorStatusWidget.tsx` (393 — instance
  health, threshold badges).
- `widgets/WatchConnectorConfigDialog.tsx`, `WatchConnectorSecretDialog.tsx` —
  instance config + declared-secret entry.
- `widgets/shared.tsx` — shared row/empty/link helpers.
- `WatchConnectorInstallConfirmDialog.tsx` — 454 lines: manifest diff display,
  egress/secrets review, token-gated confirm.

**Focus:** binding resolution (`threads`/`static`/connector sources), secret entry
never round-tripping values, confirm dialog diff accuracy vs `watchConnectors.ts`.

### 14. Web: notifications + app-shell integration (14 files)

- `WatchNotificationCoordinator.tsx` — always-mounted: consumes notification stream,
  writes prefs/unread/threshold-alert surface state.
- `watch/WatchNotificationBell.tsx` (373), `watchNotificationStore.ts`,
  `notificationIcons.tsx` — bell, popover, per-channel surface store.
- `threadNotifications.ts` (M) — multi-source badge counting (threads + watch).
- `CommandPalette.tsx` (M) — watch.open/editPage keybindings, watch action items,
  `watchPageOpen`/`editableFocus` context.
- `sidebar/SidebarChrome.tsx`, `mainAppLocation.ts` (M) — Watch sidebar entry.
- `routes/watch.tsx`, `routes/__root.tsx`, `state/watch.ts`,
  `state/environments.ts` (M — `useWatchScreenSupported`), `routeTree.gen.ts`
  _(generated — verify regen only)_.
- `docs/user/watch-screen.md`, `docs/README.md`, `.gitignore` _(docs/chore)_.

**Focus:** coordinator lifecycle (one stream per session), badge merging,
capability gating (`watchScreen`), route registration, command-palette `when` parity.

### 15. Mobile: watch follower + entry points (15 files)

- `features/watch/WatchScreen.tsx` — 561 lines: single-column follower, mobile
  projection edits only (`setMobileProjection`, never `setLayout`).
- `features/watch/WatchWidgetSection.tsx`, `WatchWidgetBody.tsx` (663 — all
  first-party bodies + connector data rendering).
- `features/watch/WatchAppWebView.tsx` — WebView twin of `WatchAppFrame` (same
  generated document, ReactNativeWebView bridge, deny-all load gate).
- `features/watch/WatchAppWidget.tsx`, `useWatchAppMounts.ts` — mount governance
  without IntersectionObserver (section mount = visible).
- `features/watch/watchMobile.ts` — `watchScreenSupported` +
  `watchAgentWidgetsMobile` kill switch (Android WebView fails-open window → agent
  widgets drop out entirely when off).
- `features/watch/useWatchEntryEnvironmentId.ts`, `state/watch.ts`.
- `features/watch/WatchAppWebView.test.tsx`, `watchMobile.test.ts` _(tests)_
- `Stack.tsx`, `features/home/HomeHeader{,.android,.types}.tsx`,
  `HomeRouteScreen.tsx`, `MaterialThreadListToolbar.tsx`,
  `features/workspace/WorkspaceRootScreen.tsx`, `WorkspaceToolbar.ios.tsx` (M —
  route + entry points).

**Focus:** mobileRevision-only writes, kill-switch coverage (every agent-widget path),
WebView load-gate posture vs web iframe, entry-point hiding when unsupported.

## Excluded / low-review files

- `pnpm-lock.yaml`, `apps/web/src/routeTree.gen.ts` (generated).
- All `*.test.ts(x)` files — listed inside clusters; verify coverage exists, not deep review.
- `apps/server/src/watch/__fixtures__/` — test fixtures.
- `docs/user/watch-screen.md`, `docs/README.md`, `.gitignore` — docs/chore.

## Totals

- **15 clusters**, ~142 files.
- Highest-risk areas: cluster 6 (pack sandbox/egress), cluster 9 (widget sandbox
  bridge), cluster 5 (confirm gate), cluster 7 (poller resource lifecycle).
