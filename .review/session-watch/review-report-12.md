# Review — Cluster 12 (Web: board, shells, editing UI) — feat/watch-screen

### [SEVERITY: MEDIUM] Finding 1: Configure form keeps a stale draft base while submitting the fresh widget revision — concurrent config edits are silently overwritten

**File**: apps/web/src/components/watch/WatchWidgetSettingsForm.tsx:144-152, 185-204; apps/web/src/components/watch/WatchWidgetBody.tsx:128,167; apps/web/src/components/watch/WatchScreen.tsx:623-626

**Problem**: `WatchWidgetSettingsForm` initializes `draft`, `draftBinding`, `initialDraft`, and `initialBinding` once at mount via `useState` initializers. The form stays mounted while `widget` keeps updating from the `pagesLive` subscription (the body is not keyed on `widget.revision`). On submit, `handleSubmit` builds `config` from the stale `draft`/`draftBinding`, and `WatchScreen.handleConfigureSave` → `buildWatchWidgetConfigureInput` attaches the _current_ `widget.revision` as `expectedRevision`.

**Evidence**: `const [draft, setDraft] = useState<DraftSettings>(() => initialSettings(widget, fields));` and `const [initialBinding] = useState(() => draftBinding);` (form:148-150) never re-run. `configureWidget` on the server (`apps/server/src/watch/WatchPageService.ts:1089-1112`) wholesale-replaces `config` and only guards on `revision` equality — which passes, since the revision is fresh.

**Impact**: If another client re-binds or re-configures the widget while this form is open, the submit passes the server's revision check yet writes values derived from the old config — the exact last-writer-wins clobber the revision mechanism exists to prevent. `dirty` also compares against the stale base, so untouched remote changes look like local edits.

**Suggestion**: Remount the form when `widget.revision`/`widget.config` changes (`key={widget.revision}` at the `WatchWidgetBody` render sites), or re-initialize `draft`/`draftBinding` in an effect when `widget.config` changes underneath. Keep the close-on-conflict behavior from Finding 2 in mind so the fix doesn't fight it.

---

### [SEVERITY: MEDIUM] Finding 2: Configure edits are discarded before the write resolves — conflict/failure loses user data

**File**: apps/web/src/components/watch/WatchScreen.tsx:619-629

**Problem**: `handleConfigureSave` calls `setConfiguringWidgetId(null)` _before_ the `configureWidget` command resolves. On a `WatchPageRevisionConflictError` (or any other failure) the form unmounts and the draft is destroyed. The only feedback is `reportWatchWriteConflict`'s toast — "Reload to pick up the latest layout, then retry" — but nothing remains to retry: the user's edits are gone.

**Evidence**:

```ts
const handleConfigureSave = useCallback(
  (widget: WatchWidget, config: WatchWidgetConfig) => {
    setConfiguringWidgetId(null);            // form unmounts here
    if (environmentId === null) return;
    void configureWidget({ ... }).then(reportWatchWriteConflict);
  }, ...)
```

**Impact**: On conflict the user must reopen Configure and retype everything — the revision-conflict UX explicitly tells them to "retry" an input that no longer exists. Same on transient/network failures, which additionally get no toast at all (see Finding 3).

**Suggestion**: Close the form only on `AsyncResult.isSuccess`. On conflict, keep the form mounted (with the stale-base fix from Finding 1 it can re-base onto the fresh widget) so the user can re-submit.

---

### [SEVERITY: MEDIUM] Finding 3: Non-conflict write failures are silent — collisions and server errors produce no user-facing signal

**File**: apps/web/src/components/watch/WatchScreen.tsx:490-502, 525-548, 566-617, 684-708; apps/web/src/state/use-atom-command.ts:19-23; packages/client-runtime/src/state/runtime.ts:420-437

**Problem**: `useAtomCommand`'s default reporter is `console` (`runAtomCommand(...)` is called without a reporter, so `reportFailure: true` only does `console.warn`). Every page/widget command in `WatchScreen` runs with defaults, and the only `.then` handler is `reportWatchWriteConflict`, which early-returns for anything that isn't `WatchPageRevisionConflictError`. Result: `WatchLayoutCollisionError`, `WatchPageError` ("page is archived", "not found"), auth denials, and transport failures are completely invisible to the user — the write just doesn't happen.

**Evidence**: `reportWatchWriteConflict` (WatchScreen.tsx:398-407) returns early unless `isWatchPageRevisionConflict(...)`. `handleDeletePage`/`handleRenameCommit`/`onReorderPage`/`onUpdatePageScope`/`onRestorePage` have no failure handler at all; `handlePickWidget`, `handleCommitLayout`, `removeWidget`, `moveWidgetToPage` only pipe through `reportWatchWriteConflict`. Compare with `reportConnectorConfigFailure` (WatchScreen.tsx:215-226), which exists precisely because connector commands need a manual toast.

**Impact**: User confirms "Delete page" and nothing happens with no explanation; an add-widget placement that collides server-side (stale `firstFreeWatchPlacement`) silently no-ops; a denied `setLayout` drag just snaps back with no message. Conflicts get a warning toast while every other failure mode gets nothing.

**Suggestion**: Extend `reportWatchWriteConflict` (or add a second handler) to toast non-conflict failures — e.g. reuse the `squashAtomCommandFailure` + `toastManager.add({ type: "error" })` pattern already used for connector commands. Page ops need a result handler too.

---

### [SEVERITY: MEDIUM] Finding 4: `watchUiBus` replays an unbounded, undated action queue at the next mount

**File**: apps/web/src/components/watch/watchUiBus.ts:16-33; emitters: apps/web/src/components/CommandPalette.tsx:490-495, 2280-2331

**Problem**: `emitWatchUiAction` pushes every action into `pending` whenever no listener is registered, and `onWatchUiAction` flushes the whole backlog to the _first_ listener that registers — with no TTL, no dedup, and no cap. The intended case ("open-gallery" emitted right after `navigate({to:"/watch"})`) works, but the mechanism is wider than the guarded emitters assume: any emitter that fires off-route (e.g. a user-customized `watch.editPage` keybinding bound without the `when: "watchPageOpen && !editableFocus"` clause from `packages/shared/src/keybindings.ts:212`) queues a `toggle-edit` that detonates on the next /watch visit — possibly minutes later, and N times for N presses (parity decides the final mode).

**Evidence**: `if (listeners.size === 0) { pending.push(action); return; }` (bus:20-24) and `for (const action of pending.splice(0)) listener(action)` (bus:30). The built-in emitters are route-gated (`pathname === "/watch"` at CommandPalette.tsx:2288; the default `watch.editPage` binding carries `watchPageOpen`), so the default path is safe — but the queue retains stale intent for arbitrary durations whenever any emitter escapes that gate.

**Impact**: Delayed, possibly repeated state changes applied to a screen the user opened for an unrelated reason. Low on default bindings; a footgun for every future emitter and for un-`when`-ed custom keybindings.

**Suggestion**: Bound the queue: drop actions older than a short TTL, collapse consecutive identical actions, or keep only the last action. Alternatively restrict queueing to the post-navigation case by having `emit` accept a "deliver-once" flag.

---

## Notes (below severity threshold, no action required)

- `handleWidgetMenu`/`handlePickWidget` capture `page.revision`/`selectedWidgets` at menu-open/dialog-open time; a concurrent change makes the write fail with a conflict that is correctly flagged + toasted. Bounded staleness, server-enforced — acceptable.
- `handleCommitLayout` re-runs `watchPlacementFits` at commit against latest render state before sending — good defense-in-depth on top of the board's mid-gesture check and the server's collision rule. No path emits a placement the server would accept-but-diverge.
- A `moveWidgetToPage` conflict flags `needsReload` for `error.pageId`, which may be the _destination_ page; the banner only renders for the selected page (toast still fires). Harmless — the flag shows correctly when that page is next selected.
- Server-side, `configureWidget` (WatchPageService.ts:1089-1112) does not check `archivedAt` on the parent page — the archived read-only guarantee for widget config is UI-only. Worth a server-side look in another cluster, not a web defect.
- `watchUiBus` listener registration is correctly cleaned up on unmount; `WatchAppFrame` disposes host/message-listener/iframe and feed atom subscriptions on unmount; `useWatchAppMounts` reseats on env+page key change. No leaks found leaving /watch.
- `watch.editPage`'s default binding is `when: "watchPageOpen && !editableFocus"` — off-route emission cannot happen on default keybindings (see Finding 4 for the residual case).
- `WatchConnectorInstallConfirmDialog`'s single `reviewed` flag serving both the localUrl fetch-ack and the egress review-ack is intentional per `watchInstallRequestNeedsReviewAck`'s doc ("any https fetch — including a `localUrl` request whose deferred fetch this acknowledgement also unlocks — gets the gate"). Confirm-disabled math re-engages once the fetched manifest lands.
