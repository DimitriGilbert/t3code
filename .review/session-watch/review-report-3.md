# Review Report — Cluster 3: Watch page/widget store + gallery

Branch: `feat/watch-screen`. Scope: `WatchPageService.ts`, `gallery.ts`, `ProjectService.ts` watch diff, `WatchPageService.test.ts` (skim).

## Summary

6 findings, all MEDIUM. No CRITICAL/HIGH. The revision-bump helpers are correctly transactional (WHERE revision=expected AND archived_at IS NULL, RETURNING-gated, `failRevisionMiss` distinguishing not-found/archived/stale), `notifyChanged` is emitted on every mutation path (all 15 methods audited), `subscribeList` correctly subscribes before snapshot, and `orderKeyMidpoint`/`spreadOrderKeys` were verified correct. The recurring theme is `order_key` integrity vs. archived rows and one asymmetric dual-revision path.

### [SEVERITY: MEDIUM] Finding 1: reorder/duplicate mint `order_key`s that can collide with archived rows

**File**: apps/server/src/watch/WatchPageService.ts:648, 676-681, 776-784
**Problem**: `reorder` computes insert neighbors from `selectPageRows({ includeArchived: false })`; `duplicate` finds the next key via `WHERE archived_at IS NULL AND order_key > source.orderKey`. Both then call `orderKeyBetween(prev, next)` which produces a midpoint strictly between the _live_ neighbors — but an archived row's key may sit in that gap and equal the minted key. The respread fallback (`spreadOrderKeys`) likewise ignores archived keys entirely. The client-side analogue `planPinnedReorder` (packages/client-runtime/src/state/threadSort.ts:274-287) explicitly builds `reservedKeys` from hidden rows and skips colliding keys; the server has no equivalent. Commit e1bc252cd fixed `lastOrderKey` to count archived rows for appends but missed the midpoint paths.
**Evidence**: Live pages `m`, `n` with archived page `mn` between them → `orderKeyBetween("m","n")` returns `"mn"` → duplicate/reorder writes a second `mn`. After `restore`, two rows share the key and ordering falls to `page_id`.
**Impact**: Order-key ambiguity — restored pages land in arbitrary position relative to the collided row; self-heals on next reorder respread, but tab order is wrong in the meantime.
**Suggestion**: Include archived rows' keys in the neighbor/reserved set (or query the immediate successor regardless of `archived_at` for `duplicate`, and for `reorder` iterate `orderKeyBetween` past reserved keys like `planPinnedReorder` does); include archived keys in the respread reservation.

### [SEVERITY: MEDIUM] Finding 2: `moveToPage` with source == destination always fails with a phantom revision conflict

**File**: apps/server/src/watch/WatchPageService.ts:1246-1265 (no `sourcePageId !== destinationPageId` guard); client builder packages/client-runtime/src/state/watchPages.ts:803-810
**Problem**: When `sourcePageId === destinationPageId`, the first `bumpPageRevision` raises `revision` N→N+1; the second bump then checks `revision = destinationExpectedRevision` — which the client builder sets to the same page's same revision N — so it misses and `failRevisionMiss` fires. Worse, `failRevisionMiss` runs inside the transaction and reads the _uncommitted_ post-bump row, so the error reports `currentRevision: N+1` while the committed value remains N. Nothing in the contract or service forbids the self-move.
**Impact**: A same-page move (e.g. drop onto the current tab) can never succeed — a false `WatchPageRevisionConflictError` telling the client to reload a revision that doesn't exist.
**Suggestion**: Early-return the widget (no-op) or delegate to the single-page placement path when `sourcePageId === destinationPageId`.

### [SEVERITY: MEDIUM] Finding 3: `configureWidget` bypasses the archived-page immutability guard

**File**: apps/server/src/watch/WatchPageService.ts:1092-1099
**Problem**: The UPDATE checks `WHERE widget_id = ? AND revision = ?` with no join to `watch_pages.archived_at`. Every other mutating path is gated through `bumpPageRevision`/`bumpMobileRevision`, which require `archived_at IS NULL`; `configureWidget` is the sole write that succeeds on a widget belonging to an archived page. The test at WatchPageService.test.ts:395-405 asserts "Archived pages are immutable" via `setLayout`, but that invariant doesn't hold for config writes.
**Impact**: Widget config on a parked page silently mutates; `restore` then resurrects edits the user never saw made. Inconsistent archive semantics across the write surface.
**Suggestion**: Join the page row (or re-check `findPage`) and fail with the archived `WatchPageError` when `archivedAt !== null`.

### [SEVERITY: MEDIUM] Finding 4: `rename`/`reorder` take no `expectedRevision` despite the contract claiming revision guards them

**File**: packages/contracts/src/watch.ts:28-30 (doc: "`revision` guards page-level writes (layout, membership, rename/reorder)"), 243-254 (inputs have no revision field); apps/server/src/watch/WatchPageService.ts:603-634, 636-707
**Problem**: `rename` bumps `revision` unconditionally without checking one; `reorder` neither checks nor bumps `revision` (it only rewrites `order_key`/`updated_at`). Two clients renaming concurrently last-writer-win with no conflict; a reorder doesn't invalidate any client's held revision, so a stale `expectedRevision` still passes a subsequent `setLayout`. Either the inputs are missing the field or the doc overstates the guarantee.
**Impact**: Stale name/scope-adjacent writes can't produce the typed conflict the dual-revision design promises; clients have no way to detect reorder-vs-reorder races.
**Suggestion**: Add `expectedRevision` to `WatchPageRenameInput`/`WatchPageReorderInput` (and have reorder bump `revision`), or correct the contract doc.

### [SEVERITY: MEDIUM] Finding 5: `create`/`instantiateFromGallery` read `lastOrderKey` outside the transaction

**File**: apps/server/src/watch/WatchPageService.ts:575-589 (no transaction at all), 930-959 (`lastKey` read before `sql.withTransaction`)
**Problem**: Both compute `orderKeyAfter(lastKey)` from a snapshot taken before the write. Two concurrent creates (or create + instantiate) read the same `lastKey` and insert the same `order_key` — there is no uniqueness constraint on the column. `duplicate` does its successor read inside its transaction; these two don't.
**Impact**: Duplicate `order_key`s → ordering degrades to `page_id` tiebreak until a reorder respread self-heals. Same invariant class as Finding 1, different mechanism (TOCTOU).
**Suggestion**: Move the `lastOrderKey` read inside a transaction covering the insert (`create` isn't transactional today), or add a per-create retry on collision.

### [SEVERITY: MEDIUM] Finding 6: `restore` bumps `revision` but not `mobile_revision` — asymmetric stale-write invalidation

**File**: apps/server/src/watch/WatchPageService.ts:854-861
**Problem**: Restoring an archived page increments only the layout `revision`. A desktop client holding a pre-archive `expectedRevision` correctly conflicts after restore, but a mobile client holding the pre-archive `expectedMobileRevision` can still write the projection — the archive→restore boundary is invisible to mobile writers. `archiveForProject` (975-979) bumps neither revision, which is fine while archived (writes are refused outright), but restore is the invalidation point.
**Impact**: A queued/stale `setMobileProjection` lands on a restored page while the equivalent `setLayout` is rejected — inconsistent protection across the two revisions the design deliberately isolates.
**Suggestion**: Bump `mobile_revision` in the `restore` UPDATE alongside `revision`.

## Notes (not findings)

- `placementInBounds` (line 226-230) omits `x >= 0`/`y >= 0` — `x = -2, w = 4` passes `x + w <= 12` and would then fail `WatchWidget` decode on every subsequent read. Currently unreachable: all placements arrive through RPC schema decode (`NonNegativeInt`) or the trusted gallery constant. One-line hardening only.
- `ProjectService.delete` (512-520, 537-539): archive is correctly post-commit, `isFirstDelete`-gated, optional via `serviceOption`, and best-effort (`catchCause` → warn). A failed archive leaves live pages bound to a dead project — deliberate degradation, bindings degrade to "project missing" anyway.
- `subscribeList` (549-559): subscribe-before-snapshot is correct; sliding(1) pubsub coalesces correctly; `notifyChanged` runs post-commit on every path including `archiveForProject`'s `rows.length > 0` guard.
- `setMobileProjection` correctly refuses widgets not on the page (page_id in WHERE) and rolls back the revision bump on any miss.
- Widget `revision` intentionally untouched by `setLayout`/`moveToPage` (placement is page-revision-owned per contract).
