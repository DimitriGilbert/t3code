# Verification Report — Review Report 3 (Watch page/widget store + gallery)

Verified each finding against `apps/server/src/watch/WatchPageService.ts`, `packages/contracts/src/watch.ts`, `apps/server/src/persistence/Migrations/063_WatchScreen.ts`, `packages/client-runtime/src/state/{watchPages,threadSort}.ts`, `apps/web/src/components/watch/WatchScreen.tsx`, the test file, git history (e1bc252cd), and `.plans/welcome-screen/{PRD,PLAN,DESIGN}.md`.

**Verdict counts: 6 VERIFIED-DEFECT / 0 VERIFIED-INTENTIONAL / 0 REJECTED.** Severity kept at MEDIUM for findings 1, 2, 3, 5; downgraded to LOW for findings 4 and 6.

---

## Finding 1 — VERIFIED-DEFECT (MEDIUM)

Reorder/duplicate mint `order_key`s that can collide with archived rows.

- `reorder` (`WatchPageService.ts:648`) scans `selectPageRows({ includeArchived: false })`, picks live neighbors, calls `orderKeyBetween(prev, next)` (line 667). Confirmed `orderKeyMidpoint("m","n")` returns `"mn"` (traced digit math at lines 170-184), so an archived row keyed `"mn"` between live `"m"`/`"n"` collides exactly as described.
- `duplicate` (`WatchPageService.ts:776-784`) queries the successor with `WHERE archived_at IS NULL AND order_key > source.orderKey` — an archived row immediately after `source` is skipped, and the midpoint between `source` and the next _live_ row can equal the archived key. The `orderKeyAfter` fallback can also land on an archived key.
- The `spreadOrderKeys` respread (lines 676-691) rewrites only live rows; generated keys ignore archived keys entirely — a spread key can collide with a retained archived key.
- e1bc252cd fixed only `lastOrderKey` (comment at 522-524 explicitly documents the archived-collision class for appends) — the midpoint/respread paths genuinely remain unfixed. No `reservedKeys` equivalent exists; the client-side `planPinnedReorder` (`threadSort.ts:274-298`) does build `reservedKeys` from hidden rows and iterates `pinOrderKeyBetween` past collisions, confirming the server path is the asymmetric one.
- Consequence confirmed by migration `063_WatchScreen.ts`: no UNIQUE on `order_key`; tiebreak is `page_id` (`ORDER BY order_key ASC, page_id ASC` at line 395).

**Fix direction**: reserve archived rows' keys in reorder/duplicate — iterate `orderKeyBetween` past reserved keys like `planPinnedReorder` does, and generate `spreadOrderKeys(live + reserved)` filtered by reserved keys. Self-heals on the next respread, so MEDIUM (not HIGH) is right.

## Finding 2 — VERIFIED-DEFECT (MEDIUM)

`moveToPage` self-move always fails with a phantom revision conflict.

- Traced `WatchPageService.ts:1247-1259`: with `sourcePageId === destinationPageId`, the first `bumpPageRevision` takes `revision` N→N+1; the second bump then requires `revision = destinationExpectedRevision`. The client builder (`watchPages.ts:806-809`) sends `sourcePage.revision`/`destinationPage.revision` — identical N for a self-move — so the second bump misses.
- `failRevisionMiss` runs inside the transaction (same `sql` tag, invoked from the `withTransaction` gen at line 1247), so `findPage` reads the uncommitted row at N+1 and the resulting `WatchPageRevisionConflictError` reports `currentRevision: N+1`; rollback leaves committed revision at N. Phantom conflict confirmed exactly as reported.
- Reachability: the web UI filters the current page out of `move-to:` destinations (`WatchScreen.tsx:636` — `entry.id !== page.id`), so web can't produce it today. But `watchWidgetsMoveToPage` is a standard-scope RPC (`ws.ts:582`, `RpcAuthorization.ts:138`); other clients/agents can send it, and nothing in the contract rejects `sourcePageId === destinationPageId`.
- Bonus defect noted by the report's framing: even if the second bump somehow passed, the page revision would double-bump for one logical move.

**Fix direction**: early-return a no-op (or delegate to single-page placement) when `sourcePageId === destinationPageId` in `moveToPage`. MEDIUM stands — the error actively tells the client to reload a revision that doesn't exist.

## Finding 3 — VERIFIED-DEFECT (MEDIUM, defensible at LOW)

`configureWidget` bypasses the archived-page immutability guard.

- `WatchPageService.ts:1092-1099`: `UPDATE watch_widgets ... WHERE widget_id = ? AND revision = ?` — no join/filter on `watch_pages.archived_at`, confirmed.
- Audited every sibling write: `addWidget`/`removeWidget`/`setLayout`/`moveToPage` gate via `bumpPageRevision` (`archived_at IS NULL`, lines 481/488); `setMobileProjection` via `bumpMobileRevision` (line 505); `rename`/`updateScope` check `archived_at IS NULL` (lines 611, 897); `duplicate` rejects `source.archivedAt !== null` (line 773). `configureWidget` is the sole mutating path that succeeds on a widget under an archived page. (`delete` also ignores archive status, but permanent deletion of a parked page is plausibly intentional.)
- Test `WatchPageService.test.ts:395-405` asserts "Archived pages are immutable" only through `setLayout` — the invariant holds for every write except config.
- Impact is a queued/stale config write landing on a hidden page and resurrecting on `restore`; no UI path reaches it today (archived pages aren't listed by default). MEDIUM retained because "archived ⇒ immutable" is a stated invariant, but LOW is defensible.

**Fix direction**: join the parent page (or check `findPage(widget.pageId).archivedAt`) and fail with the archived `WatchPageError`.

## Finding 4 — VERIFIED-DEFECT (severity: MEDIUM → LOW)

`rename`/`reorder` take no `expectedRevision` despite the contract doc claiming they are guarded.

- `WatchPageRenameInput`/`WatchPageReorderInput` (`watch.ts:243-254`) have no revision field — confirmed.
- `rename` bumps `revision` unconditionally (`WatchPageService.ts:606-613`); `reorder` writes only `order_key`/`updated_at` (lines 669-691) — never checks or bumps `revision`. Confirmed.
- The contract doc at `watch.ts:28-30` says `revision` guards "layout, membership, rename/reorder" — inaccurate. However, the PRD (`.plans/welcome-screen/PRD.md:87-91`) promises revision guards only for "layout writes and set-membership changes (add/remove/move-between-pages)" — rename/reorder were never intended to be guarded. So the _behavior_ matches intent; the _doc_ overstates it.
- Downgraded to LOW: no behavioral guarantee is actually broken — rename still bumps revision (invalidating stale layout writers), and reorder touching no guarded fields means it needn't invalidate `expectedRevision` holders. Real defect, but it is a doc defect.

**Fix direction**: correct the doc comment on `WatchPage.revision` to "layout and membership". Adding `expectedRevision` fields is optional scope creep — the PRD doesn't ask for it.

## Finding 5 — VERIFIED-DEFECT (MEDIUM)

`create`/`instantiateFromGallery` read `lastOrderKey` outside the transaction (TOCTOU).

- `create` (`WatchPageService.ts:565-601`) has **no transaction at all**: `lastOrderKey` at line 575, then a bare INSERT. Confirmed.
- `instantiateFromGallery` reads `lastKey` at line 930, _before_ `sql.withTransaction` at line 931. Confirmed.
- No UNIQUE constraint on `order_key` (migration `063_WatchScreen.ts:15`). Two concurrent creates read the same `lastKey` and both insert `orderKeyAfter(lastKey)` = the identical `${lastKey}n` key. Confirmed mechanism.
- Asymmetry claim confirmed: `duplicate`'s successor SELECT (line 776) runs inside its `withTransaction` (line 767).
- Moving the read inside the transaction does fix it under SQLite (single-writer serialization — the second transaction observes the first's committed insert).

**Fix direction**: wrap `create`'s read+insert in `sql.withTransaction`; move the `lastKey` read inside `instantiateFromGallery`'s transaction. Likelihood is low but the fix is trivial and the failure mode (duplicate keys → `page_id` tiebreak until respread) is the same class as Finding 1. MEDIUM stands.

## Finding 6 — VERIFIED-DEFECT (severity: MEDIUM → LOW)

`restore` bumps `revision` but not `mobile_revision`.

- `WatchPageService.ts:854-861`: `SET archived_at = NULL, revision = revision + 1, updated_at` — `mobile_revision` untouched. Confirmed.
- Asymmetry is real: a stale `setLayout` expectedRevision is invalidated across archive→restore, while a stale `setMobileProjection` expectedMobileRevision still matches.
- Downgraded to LOW on impact analysis: while archived, _every_ path that could diverge the mobile projection is archived-gated (`bumpMobileRevision`, `bumpPageRevision`, all `archived_at IS NULL`), and the one ungated write (Finding 3's `configureWidget`) doesn't touch `mobile_order`/`mobile_hidden`. So at restore time the mobile projection is bit-identical to pre-archive — the "stale" mobile write replays old values onto unchanged state. The asymmetry violates the dual-revision design's symmetry but is unexploitable today; the `revision` bump on restore is itself belt-and-suspenders.

**Fix direction**: add `mobile_revision = mobile_revision + 1` to the `restore` UPDATE for symmetry with the design's per-projection invalidation.

---

## Additional notes

- Note (line 48 of report 3) on `placementInBounds` missing `x >= 0`/`y >= 0` checks: confirmed at lines 226-230 — only `w >= 1`, `h >= 1`, `x + w <= 12`, `minCols` bounds. Negative `x`/`y` pass. Reachability claim confirmed: `WatchWidgetPlacement` uses `NonNegativeInt` for `x`/`y` (`watch.ts:75-76`), so RPC-decoded input can't produce negatives; the gallery constant is trusted code. Correctly filed as a note, not a finding.
- `subscribe-before-snapshot` in `subscribeList` (549-559), `notifyChanged` on every mutation path, and `archiveForProject`'s post-commit/rows-gated notification (975-981) all verified as correct.
- `selectPageRows` ORDER BY (`order_key ASC, page_id ASC`, line 395) means collided keys degrade to `page_id` ordering — consistent with findings 1/5's described failure mode.
