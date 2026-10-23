# Review — Cluster 13: Web first-party + connector widgets (feat/watch-screen)

Scope: `apps/web/src/components/watch/widgets/*`, `apps/web/src/components/watch/WatchConnectorInstallConfirmDialog.tsx`, cross-checked against `packages/client-runtime/src/state/watchConnectors.ts`, `packages/contracts/src/watch.ts`, and `apps/server/src/watch/connectors/ConnectorService.ts` / `ConnectorPoller.ts`.

### [SEVERITY: HIGH] Finding 1: Upgrade diff omits `widgets`/`bridge`/`authSchema` — the human gate misrepresents what changed

**File**: packages/client-runtime/src/state/watchConnectors.ts:49-67 (rendered by `ManifestDiffRows` in apps/web/src/components/watch/WatchConnectorInstallConfirmDialog.tsx:91-146)

**Problem**: `diffWatchConnectorManifests` diffs only `schemaVersion`, `transport`, `egressHosts`, `secretKeys`, and operation **names**. The manifest also carries `widgets` — each with a `bridge` manifest declaring "the only data subscriptions and actions the frame may use" (`packages/contracts/src/watch.ts:402-428`) — and `authSchema`. None of those are diffed. Operation `description` changes are invisible too (only names are compared).

**Evidence**: On confirm, the new bundle's widget sources are transpiled and registered server-side (`registerPackWidgets` at `apps/server/src/watch/connectors/ConnectorService.ts:1350`). An upgrade that adds a widget, widens a widget's `bridge.subscriptions`/`actions` (the sandbox privilege surface, enforced host-side in `watchAppBridge.ts:178,259`), or rewrites `authSchema` renders in the dialog as only `schemaVersion N → M`. If only those fields changed, the reviewer sees a version bump and nothing else.

**Impact**: The dialog exists precisely so a human can catch a hostile pack upgrade expanding its reach. New executable widget code and new bridge grants landing invisibly is exactly the class of change the gate is meant to surface — a misleading diff here is a security defect.

**Suggestion**: Extend the diff with a `widgets` group (added/removed widget names, and per-widget bridge subscription/action deltas for widgets present in both) and an `authSchema` changed/unchanged row (deep-equal is enough — a config-schema rewrite needs no field-level diff to be reviewable).

### [SEVERITY: MEDIUM] Finding 2: Install-time review never shows declared operations or bundled widgets

**File**: apps/web/src/components/watch/WatchConnectorInstallConfirmDialog.tsx:193-220 (`ConfirmBody`)

**Problem**: On install (and on upgrades where `diffBase` is null), the body renders only egress hosts and secret key names. `manifest.operations` and `manifest.widgets` are never displayed — operations surface only inside the upgrade diff, and only when their name set changed.

**Evidence**: The contract describes the manifest as "the pack contract a human confirms at install: declared operations, declared egress hosts, declared secret keys, and the transport" (`packages/contracts/src/watch.ts:431-434`). Two of those four are absent from the install view; the widget list (executable code about to be registered) is absent on both legs.

**Impact**: A user approving a fresh install cannot see what the pack declares it does — e.g. an operation named `deleteWorkspace` or a bundled widget they never asked for.

**Suggestion**: Add `PermissionGroup`-style sections for operations (name + description) and bundled widgets (name + bridge summary) to `ConfirmBody`, shown on both install and upgrade.

### [SEVERITY: MEDIUM] Finding 3: localUrl post-fetch review acknowledgement is never enforced

**File**: apps/web/src/components/watch/WatchConnectorInstallConfirmDialog.tsx:236, 354-358, 381-393

**Problem**: `needsLocalFetchAck` is computed from `props.request`, but `prepareInstallConfirm` persists the fetched manifest into the request row **without** `notifyChanged` (`ConnectorService.ts:1246-1280` — compare the `subscribeList` push model at lines 693-704, which only re-pushes on notify). So `props.request.manifest` stays `null` for the whole dialog session and `needsLocalFetchAck` stays `true`.

**Evidence**: `confirmDisabled` (line 354-358) gates the checkbox only via `needsReviewAck && !needsLocalFetchAck && !reviewed` — dead code on the localUrl path. Meanwhile the checkbox label flips to "I reviewed what this pack can reach" once `prepared` is set (line 388-390) while `reviewed` remains `true` from the pre-fetch ack — and even unchecking it does not disable Confirm.

**Impact**: The two-stage ack the dialog copy implies (ack the URL → fetch → ack the capabilities) collapses to one. The fetched manifest is shown and Confirm is an explicit click, so the hole is bounded — but the post-fetch acknowledgement is decorative, and the `confirmDisabled` expression suggests it was meant to gate.

**Suggestion**: Recompute `needsLocalFetchAck` from `shownRequest` (`prepared?.request ?? request`), or have `prepareInstallConfirm` emit `notifyChanged` after the row update; and reset `reviewed` to false when `prepared` arrives for a localUrl request so the capability ack is a fresh act.

### [SEVERITY: MEDIUM] Finding 4: "last fetch" is systematically stale for healthy instances

**File**: apps/web/src/components/watch/widgets/WatchConnectorStatusWidget.tsx:125-126, 293

**Problem**: The row's only liveness signal is `health.lastFetchAt`, but the server deliberately excludes `lastFetchAt` from `healthChanged` (`ConnectorService.ts:910-926`, notify at line 960) — "it ticks on every poll run… excluded" to avoid re-pushing the list on every fetch.

**Evidence**: Verified against `ConnectorPoller.ts:438-449`: every successful poll writes `lastFetchAt` via `recordHealth`, but a healthy instance produces no notify (status/lastError/consecutiveFailures/lastRollback all unchanged), so `subscribeList` never re-pushes. Failure polls do notify (consecutiveFailures increments) — meaning the label goes stale precisely in the healthy case where it matters. The widget's `useNowMinute` re-renders the relative label but against the same frozen timestamp.

**Impact**: A healthy connector polling every minute can show "last fetch 2h ago" indefinitely — the observed-live staleness is structural, not a bug in formatting.

**Suggestion**: Either include `fetchedAt` for the instance in the connector snapshot stream and let the status widget merge it, or relabel to something honest (e.g. drop the "last fetch" readout and rely on the health badge). If the list must stay quiet, a periodic low-frequency refresh (e.g. piggyback on `useNowMinute` at a coarser interval) is cheaper than a misleading field.

### [SEVERITY: MEDIUM] Finding 5: No way to clear a stored secret — `clearSecretKeys` is unreachable

**File**: apps/web/src/components/watch/widgets/WatchConnectorSecretDialog.tsx:74-80

**Problem**: Submit builds `secrets` only from non-empty trimmed inputs; empty fields are dropped. The wire contract supports `clearSecretKeys` (`packages/contracts/src/watch.ts:704`) and the server honors it (`ConnectorService.ts:824-831`), but neither the dialog nor `run()` in `WatchConnectorStatusWidget.tsx:139-166` ever sends it.

**Impact**: A stored credential can never be revoked through the UI — a leaked or rotated-out secret persists until the instance is deleted (which also drops config). One-way door for a sensitive value.

**Suggestion**: Add a per-key "clear" affordance (e.g. a small remove button beside keys already in `configuredSecretKeys`) that maps to `clearSecretKeys` on `setInstanceConfig`.

### [SEVERITY: MEDIUM] Finding 6: TaskStarter silently downgrades a worktree launch to local while git status is pending

**File**: apps/web/src/components/watch/widgets/WatchTaskStarterWidget.tsx:121-131, 153-164

**Problem**: `envModeMayBeWorktree` triggers a `vcsEnvironment.status` subscription keyed on `{environmentId, cwd}` (`runtime.ts:449-454` — a fresh atom per cwd, so switching the project picker always starts uncached). `onStart` reads `gitStatusQuery.data?.isRepo === true`; while the query is pending, `data` is null → `isRepo: false` → `resolveSendEnvMode` returns `"local"` (`ChatView.logic.ts:818-823`). `canStart` does not gate on the query settling.

**Evidence**: A fast Start click (or Enter in the textarea, line 305-310) after selecting a project — or on first mount before the first subscription event lands — resolves `envMode: "local"`, so `isWorktree` is false, the `baseBranch === null` guard never runs, and the thread launches in the project checkout instead of the worktree the env-mode chain wanted.

**Impact**: Silent loss of workspace isolation for a user-initiated task — the exact opposite of a safe default (running an agent in the real checkout when worktree was configured). Not exploitable, but wrong and invisible: nothing tells the user the run went local.

**Suggestion**: When `envModeMayBeWorktree` is true, disable Start while `gitStatusQuery.isPending` (or `await` the status inside `onStart` before resolving `envMode`).

## Verified clean / notes (non-findings)

- `WatchConnectorSecretDialog` never reads back stored values: fields start blank, `configuredSecretKeys` is presence-only, and only session-entered keys are sent. Secret/schema hygiene is correct.
- `setInstanceConfig` replaces `config_json` wholesale; the secrets path resends `instance.config` from the live list — a tiny stale-write window exists but the prop refreshes on notify. Noted, not flagged.
- After a failed `migrateConfig` repin, secrets/reconnect writes fail `configInvalid` before touching secrets (`ConnectorService.ts:821`); the "Could not update secrets" toast then reports a config error. Confusing but self-consistent with validate-before-write.
- Threads-binding repoint/stale handling is correct: unbound widgets follow page ambient scope, explicit `"*"`/project bindings win, missing projects surface `projectMissing` with a repoint action (`watchPages.ts:656`, `watchWidgets.ts:190-201`, `WatchWidgetBody.tsx:149-210`).
- `startTurn` input shape matches `StartThreadTurnInput` (`client-runtime/operations/commands.ts:169-185`); thread creation only happens inside the explicit Start/Enter path.
- `WatchWidgetRow` correctly keeps action buttons outside the row's open-button (no nested buttons); `WatchElapsed` direct-DOM ticking avoids per-second React commits.
- `pack` fallback `versions[0]` in `ConnectorRow` (line 111-113) can pick an arbitrary version's manifest for secret badges if the pinned row is absent — defensive fallback for a case that appears unreachable in practice (a live instance's pinned pack row can't be purged). Noted only.

**Count: 6 findings — 1 HIGH, 5 MEDIUM.**
