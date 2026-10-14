import type {
  ProjectId,
  WatchConnectorInstanceId,
  WatchGalleryTemplate,
  WatchPackWidgetSource,
  WatchPage,
  WatchPageId,
  WatchPageInstantiateFromGalleryInput,
  WatchWidget,
  WatchWidgetAddInput,
  WatchWidgetConfig,
  WatchWidgetConfigureInput,
  WatchWidgetId,
  WatchWidgetKind,
  WatchWidgetMoveToPageInput,
  WatchWidgetPlacement,
  WatchWidgetProvenance,
  WatchWidgetSetLayoutInput,
} from "@t3tools/contracts";

/**
 * Pure watch-page and board-layout helpers shared by web and mobile. Nothing
 * here owns state: pages/widgets come from the `pagesLive` subscription and
 * every helper is a pure derivation the client can call per render. Mobile
 * reuses the canonical order, the placement math, and the project-resolution
 * rules; only the rendering differs.
 */

// ── Grid geometry ─────────────────────────────────────────────────────

export const WATCH_GRID_COLUMNS = 12;
/** Reflowed column count for the medium-width view-only band. */
export const WATCH_GRID_MEDIUM_COLUMNS = 6;
/** Fixed row unit; a fixed CSS value, deliberately not a token. */
export const WATCH_GRID_ROW_UNIT_REM = 4;
/** Layout editing exists only at or above this width; below it the board is view-only. */
export const WATCH_GRID_EDIT_MIN_WIDTH_PX = 1200;
/** Below this width the board collapses to a single column (mobile's rule). */
export const WATCH_GRID_STACK_MIN_WIDTH_PX = 768;

// ── Pages ─────────────────────────────────────────────────────────────

/** Tab order: `orderKey` first, id as a stable tiebreak. Returns a new array. */
export function sortWatchPages(pages: ReadonlyArray<WatchPage>): WatchPage[] {
  return [...pages].sort(
    (a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id),
  );
}

/**
 * Splits the live list into the tab strip (active, ordered) and the archive
 * (archived, ordered). Archived pages never appear in the strip.
 */
export function partitionWatchPages(pages: ReadonlyArray<WatchPage>): {
  readonly active: ReadonlyArray<WatchPage>;
  readonly archived: ReadonlyArray<WatchPage>;
} {
  const active: WatchPage[] = [];
  const archived: WatchPage[] = [];
  for (const page of pages) {
    (page.archivedAt === null ? active : archived).push(page);
  }
  return { active: sortWatchPages(active), archived: sortWatchPages(archived) };
}

/** First unused "New page", "New page 2", … name across active and archived pages. */
export function nextWatchPageName(pages: ReadonlyArray<WatchPage>, baseName = "New page"): string {
  const names = new Set(pages.map((page) => page.name));
  if (!names.has(baseName)) return baseName;
  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!names.has(candidate)) return candidate;
  }
}

/**
 * The ambient project binding a page lends to unbound widgets. Only
 * `scope: "project"` pages carry one; global pages resolve to `null`,
 * meaning "all projects".
 */
export function watchPageAmbientProjectId(
  page: Pick<WatchPage, "scope" | "projectId">,
): ProjectId | null {
  return page.scope === "project" ? page.projectId : null;
}

/**
 * Whether a tab shows its project name badge: only project pages, and only
 * when that project is not the page's ambient context (inside a project view
 * the badge restates what the chrome already says).
 */
export function watchPageShowsProjectBadge(
  page: Pick<WatchPage, "scope" | "projectId">,
  viewedProjectId: ProjectId | null,
): boolean {
  return page.scope === "project" && page.projectId !== null && page.projectId !== viewedProjectId;
}

/**
 * The `beforePageId` for a one-step tab move within the active strip, or
 * `undefined` when the page is already at the edge. Keyboard/menu equivalent
 * of drag reorder; dnd drops compute the same value from the drop index.
 */
export function watchPageReorderBefore(
  orderedActivePages: ReadonlyArray<WatchPage>,
  pageId: WatchPageId,
  direction: "left" | "right",
): WatchPageId | null | undefined {
  const index = orderedActivePages.findIndex((page) => page.id === pageId);
  if (index < 0) return undefined;
  const targetIndex = direction === "left" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= orderedActivePages.length) return undefined;
  // Moving left slots in front of the neighbour; moving right slots in front
  // of the page after the neighbour (null when the neighbour is last).
  const beforePage =
    direction === "left" ? orderedActivePages[targetIndex] : orderedActivePages[targetIndex + 1];
  return beforePage === undefined ? null : beforePage.id;
}

/**
 * The `beforePageId` for a dnd drop of `pageId` onto `overPageId`: dropped
 * forward, the page lands after the target; dropped backward, in front of it.
 * `undefined` when either id is absent or they are the same.
 */
export function watchPageReorderForDrop(
  orderedActivePages: ReadonlyArray<WatchPage>,
  pageId: WatchPageId,
  overPageId: WatchPageId,
): WatchPageId | null | undefined {
  const from = orderedActivePages.findIndex((page) => page.id === pageId);
  const to = orderedActivePages.findIndex((page) => page.id === overPageId);
  if (from < 0 || to < 0 || from === to) return undefined;
  if (from > to) return orderedActivePages[to]!.id;
  const after = orderedActivePages[to + 1];
  return after === undefined ? null : after.id;
}

// ── Widgets ───────────────────────────────────────────────────────────

/**
 * Canonical widget order: `y`, then `x`, then insertion index (the sort is
 * stable). DOM order always follows it so tab order and screen readers match
 * the visual reading order regardless of placement.
 */
export function canonicalWatchWidgetOrder(widgets: ReadonlyArray<WatchWidget>): WatchWidget[] {
  // Hermes lacks Array#toSorted; sorting a copy is equally non-mutating.
  return [...widgets].sort(
    (a, b) => a.placement.y - b.placement.y || a.placement.x - b.placement.x,
  );
}

/** A page's widgets in canonical order. */
export function watchPageWidgets(
  widgets: ReadonlyArray<WatchWidget>,
  pageId: WatchPageId,
): WatchWidget[] {
  return canonicalWatchWidgetOrder(widgets.filter((widget) => widget.pageId === pageId));
}

/** True when two placements share at least one grid cell. */
export function watchPlacementsOverlap(a: WatchWidgetPlacement, b: WatchWidgetPlacement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

type PlacementSize = Pick<WatchWidgetPlacement, "w" | "h"> &
  Partial<Pick<WatchWidgetPlacement, "minCols">>;

/**
 * First free slot for a widget of `size` on a `columns`-wide board already
 * holding `placed` rects. Scans rows top-to-bottom, columns left-to-right;
 * the row below the deepest widget always fits, so this never fails.
 */
function firstFreePlacement(
  placed: ReadonlyArray<WatchWidgetPlacement>,
  size: PlacementSize,
  columns: number,
): WatchWidgetPlacement {
  const w = Math.min(size.w, columns);
  const h = size.h;
  const minCols = size.minCols === undefined ? undefined : Math.min(size.minCols, columns);
  const bottom = placed.reduce((max, placement) => Math.max(max, placement.y + placement.h), 0);
  for (let y = 0; y <= bottom; y += 1) {
    for (let x = 0; x + w <= columns; x += 1) {
      const candidate: WatchWidgetPlacement = { x, y, w, h };
      if (!placed.some((placement) => watchPlacementsOverlap(candidate, placement))) {
        return minCols === undefined ? candidate : { ...candidate, minCols };
      }
    }
  }
  // Unreachable: `y === bottom` is an empty row and always accepts x = 0.
  return { x: 0, y: bottom, w, h, ...(minCols === undefined ? {} : { minCols }) };
}

/** First free 12-column (or `columns`) placement for a new widget on a page. */
export function firstFreeWatchPlacement(
  widgets: ReadonlyArray<Pick<WatchWidget, "placement">>,
  size: PlacementSize,
  columns: number = WATCH_GRID_COLUMNS,
): WatchWidgetPlacement {
  return firstFreePlacement(
    widgets.map((widget) => widget.placement),
    size,
    columns,
  );
}

/**
 * The narrow-view layout: canonical-order widgets packed into `columns`
 * columns. This is a derived render-time view — stored placements are never
 * read back out of it and the input is not mutated. Mobile's single column
 * is `reflowWatchPlacements(widgets, 1)` filtered by `mobileHidden`.
 */
export function reflowWatchPlacements(
  widgets: ReadonlyArray<WatchWidget>,
  columns: number,
): ReadonlyMap<WatchWidgetId, WatchWidgetPlacement> {
  const result = new Map<WatchWidgetId, WatchWidgetPlacement>();
  const placed: WatchWidgetPlacement[] = [];
  for (const widget of canonicalWatchWidgetOrder(widgets)) {
    const placement = firstFreePlacement(placed, widget.placement, columns);
    placed.push(placement);
    result.set(widget.id, placement);
  }
  return result;
}

// ── Layout editing ──────────────────────────────────────────────────────

/** Column count the board renders at a given viewport width. */
export function watchBoardColumns(viewportWidthPx: number): number {
  if (viewportWidthPx >= WATCH_GRID_EDIT_MIN_WIDTH_PX) return WATCH_GRID_COLUMNS;
  if (viewportWidthPx >= WATCH_GRID_STACK_MIN_WIDTH_PX) return WATCH_GRID_MEDIUM_COLUMNS;
  return 1;
}

/**
 * Layout editing exists only at or above the edit width — below it the board
 * is a derived view and `setLayout` must not be reachable from the UI.
 */
export function watchLayoutEditableAt(viewportWidthPx: number): boolean {
  return viewportWidthPx >= WATCH_GRID_EDIT_MIN_WIDTH_PX;
}

/**
 * The pixel distance between the start of one cell and the next, recovered
 * from a rendered element spanning `span` cells: `spanPx = span * pitch -
 * gap`. One measurement per gesture, then all math runs in cell units.
 */
export function watchGridPitch(spanPx: number, span: number, gapPx: number): number {
  if (span <= 0) return 0;
  return (spanPx + gapPx) / span;
}

/** Whole-cell distance for a pointer delta; snaps at half a cell. */
export function watchCellDelta(deltaPx: number, pitchPx: number): number {
  if (pitchPx <= 0) return 0;
  return Math.round(deltaPx / pitchPx);
}

/**
 * Whether a placement is legal on a `columns`-wide board holding `others`:
 * inside the grid, at least one row tall, at or above its `minCols` floor,
 * and overlapping nothing. Overlap is forbidden — a colliding drop is a
 * no-op, never a shove.
 */
export function watchPlacementFits(
  placement: WatchWidgetPlacement,
  others: ReadonlyArray<WatchWidgetPlacement>,
  columns: number = WATCH_GRID_COLUMNS,
): boolean {
  return (
    placement.x >= 0 &&
    placement.y >= 0 &&
    placement.w >= Math.max(1, placement.minCols ?? 1) &&
    placement.h >= 1 &&
    placement.x + placement.w <= columns &&
    !others.some((other) => watchPlacementsOverlap(placement, other))
  );
}

/** Two placements are the same rect (per-gesture no-change guard). */
export function watchPlacementsEqual(a: WatchWidgetPlacement, b: WatchWidgetPlacement): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Where a dragged widget would land: the start placement shifted by whole
 * cells, clamped inside the grid and to the top edge.
 */
export function watchMoveCandidate(
  start: WatchWidgetPlacement,
  deltaColumns: number,
  deltaRows: number,
  columns: number = WATCH_GRID_COLUMNS,
): WatchWidgetPlacement {
  return {
    ...start,
    x: Math.min(Math.max(0, start.x + deltaColumns), Math.max(0, columns - start.w)),
    y: Math.max(0, start.y + deltaRows),
  };
}

/**
 * The resize handles a widget offers: a hit zone on each edge center plus
 * both bottom corners (bottom corners only — top corners would fight the
 * header row's controls).
 */
export type WatchResizeEdge = "n" | "s" | "e" | "w" | "se" | "sw";

export const WATCH_RESIZE_EDGES: ReadonlyArray<WatchResizeEdge> = ["n", "s", "e", "w", "se", "sw"];

/**
 * The placement a resize gesture is proposing. Width never drops below
 * `minCols` (floor 1), height never below one row, and the board's right
 * edge clamps eastward growth — the candidate is always legal geometry, so
 * collision alone decides whether a drop is refused.
 */
export function watchResizeCandidate(
  start: WatchWidgetPlacement,
  edge: WatchResizeEdge,
  deltaColumns: number,
  deltaRows: number,
  columns: number = WATCH_GRID_COLUMNS,
): WatchWidgetPlacement {
  const minWidth = Math.max(1, start.minCols ?? 1);
  let { x, y, w, h } = start;
  if (edge === "w" || edge === "sw") {
    const nextX = Math.min(Math.max(0, start.x + deltaColumns), start.x + start.w - minWidth);
    w = start.w + (start.x - nextX);
    x = nextX;
  }
  if (edge === "e" || edge === "se") {
    w = Math.min(Math.max(minWidth, start.w + deltaColumns), Math.max(minWidth, columns - start.x));
  }
  if (edge === "n") {
    const nextY = Math.min(Math.max(0, start.y + deltaRows), start.y + start.h - 1);
    h = start.h + (start.y - nextY);
    y = nextY;
  }
  if (edge === "s" || edge === "se" || edge === "sw") {
    h = Math.max(1, start.h + deltaRows);
  }
  return { ...start, x, y, w, h };
}

// ── Widget identity ───────────────────────────────────────────────────

export interface WatchWidgetSettingsSelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * One generated configure-form row for a first-party widget. Mirrors the
 * provider-settings descriptor shape (`deriveProviderSettingsFields`) but is
 * authored per widget kind — these settings live in `config.settings`, which
 * the server stores opaquely, so validation and defaults are the client's.
 */
export interface WatchWidgetSettingsField {
  readonly key: string;
  readonly control: "text" | "number" | "textarea" | "stringList" | "select" | "switch";
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  /** "omit" drops the key from `settings` when empty/false; "persist" writes it. */
  readonly clearWhenEmpty?: "omit" | "persist";
  /** Options for a `select` control; the first entry is the fallback. */
  readonly options?: ReadonlyArray<WatchWidgetSettingsSelectOption>;
  /** Number bounds, applied client-side at save time. */
  readonly min?: number;
  readonly max?: number;
  readonly defaultValue?: unknown;
}

export interface WatchFirstPartyWidgetSpec {
  readonly kind: WatchWidgetKind;
  readonly title: string;
  readonly description: string;
  readonly section: "threads" | "connectors";
  readonly defaultSize: PlacementSize;
  /** Generated configure-form rows for `config.settings`; empty for binding-only widgets. */
  readonly settingsFields: ReadonlyArray<WatchWidgetSettingsField>;
}

/** Shared "rows shown" number descriptor used by the list widgets. */
const maxItemsField = (label = "Maximum items"): WatchWidgetSettingsField => ({
  key: "maxItems",
  control: "number",
  label,
  min: 1,
  max: 20,
  defaultValue: 8,
});

/** The first-party registry the add-widget picker lists. */
export const WATCH_FIRST_PARTY_WIDGETS: ReadonlyArray<WatchFirstPartyWidgetSpec> = [
  {
    kind: "active-work",
    title: "Active work",
    description: "Running threads across this page's projects.",
    section: "threads",
    defaultSize: { w: 7, h: 4 },
    settingsFields: [
      maxItemsField(),
      {
        key: "showStop",
        control: "switch",
        label: "Show stop button",
        description: "Offer an inline interrupt on running threads.",
        defaultValue: true,
        clearWhenEmpty: "persist",
      },
    ],
  },
  {
    kind: "needs-attention",
    title: "Needs attention",
    description: "Threads waiting on an answer or approval.",
    section: "threads",
    defaultSize: { w: 5, h: 4 },
    settingsFields: [
      maxItemsField(),
      {
        key: "staleAfterHours",
        control: "number",
        label: "Stale after (hours)",
        description: "Flag working threads with no update for this long.",
        min: 1,
        max: 24 * 30,
        defaultValue: 24,
      },
      {
        key: "showSnoozed",
        control: "switch",
        label: "Show snoozed threads",
        description: "List snoozed threads dimmed after the attention rows.",
        defaultValue: true,
        clearWhenEmpty: "persist",
      },
    ],
  },
  {
    kind: "task-starter",
    title: "Task starter",
    description: "Start a new thread from this page.",
    section: "threads",
    defaultSize: { w: 4, h: 3 },
    settingsFields: [
      {
        key: "templates",
        control: "stringList",
        label: "Prompt templates",
        description: "One template per line; they render as quick-start chips.",
        placeholder: "e.g. Review the latest diff for regressions",
      },
      {
        key: "runtimeMode",
        control: "select",
        label: "Runtime mode",
        options: [
          { value: "full-access", label: "Full access" },
          { value: "auto-accept-edits", label: "Auto-accept edits" },
          { value: "auto", label: "Auto" },
          { value: "approval-required", label: "Approval required" },
        ],
        defaultValue: "full-access",
      },
    ],
  },
  {
    kind: "recent-activity",
    title: "Recent activity",
    description: "Finished turns and checkpoints.",
    section: "threads",
    defaultSize: { w: 8, h: 3 },
    settingsFields: [
      maxItemsField("Maximum threads"),
      {
        key: "showDiffs",
        control: "switch",
        label: "Show diff stats",
        description: "Load turn checkpoints for file counts and +/- lines.",
        defaultValue: true,
        clearWhenEmpty: "persist",
      },
    ],
  },
  {
    kind: "connector-status",
    title: "Connector status",
    description: "Connector instances, health, and last fetch.",
    section: "connectors",
    defaultSize: { w: 12, h: 2 },
    settingsFields: [],
  },
];

export function watchFirstPartyWidgetSpec(
  kind: WatchWidgetKind,
): WatchFirstPartyWidgetSpec | undefined {
  return WATCH_FIRST_PARTY_WIDGETS.find((spec) => spec.kind === kind);
}

/**
 * Whether the in-place configure form would render at least one control: a
 * bindable `threads`/`connector` source or a declared settings field.
 * Widgets with neither (e.g. connector-status) suppress the Configure
 * affordance rather than swapping in an empty card. Non-first-party kinds
 * have no generated settings form but stay repointable when they bind a
 * connector instance.
 */
export function watchWidgetIsConfigurable(widget: Pick<WatchWidget, "kind" | "config">): boolean {
  const spec = watchFirstPartyWidgetSpec(widget.kind);
  if (spec === undefined) {
    // Agent/pack kinds have no declared settings fields, but a connector
    // source binding is still repointable through the same picker.
    return widget.config.source?.kind === "connector";
  }
  if (spec.settingsFields.length > 0) return true;
  const source = widget.config.source;
  return source?.kind === "threads" || source?.kind === "connector";
}

/** Header title for a shell: the registry title, a generic agent label, or the kind itself. */
export function watchWidgetDisplayTitle(widget: Pick<WatchWidget, "kind">): string {
  const spec = watchFirstPartyWidgetSpec(widget.kind);
  if (spec !== undefined) return spec.title;
  return widget.kind.startsWith("agent:") ? "Agent widget" : widget.kind;
}

/**
 * The provenance marker shown in the widget header, or `null` for first-party
 * widgets (they need no warning). "pack" reads as Pack, agent-published as
 * Agent — the security-visible marker the PRD requires.
 */
export function watchWidgetProvenanceMarker(
  provenance: WatchWidgetProvenance,
): "agent" | "pack" | null {
  if (provenance === "firstParty") return null;
  if (provenance === "agentPublished") return "agent";
  return "pack";
}

/**
 * The project a `threads`-source widget reads against. An explicit binding
 * wins; `"*"` binds to all projects; an absent binding falls back to the
 * page's ambient scope — which is what makes per-project pages reusable
 * templates. Non-`threads` sources bind no project (`connector` binds an
 * instance id instead, resolved by the connector stream).
 */
export function resolveWatchThreadsProjectBinding(
  page: Pick<WatchPage, "scope" | "projectId">,
  widget: Pick<WatchWidget, "config">,
): string | null {
  const source = widget.config.source;
  if (source === undefined || source.kind !== "threads") return null;
  const binding = source.binding;
  if (binding === undefined) return watchPageAmbientProjectId(page);
  return binding === "*" ? null : binding;
}

// ── Command input builders ────────────────────────────────────────────

/**
 * The `addWidget` payload for a kind: page-revision-checked membership write
 * landing at the first free placement. `size` overrides the registry default
 * for kinds not in the first-party catalog.
 */
export function buildWatchWidgetAddInput(
  page: WatchPage,
  pageWidgets: ReadonlyArray<WatchWidget>,
  kind: WatchWidgetKind,
  size?: PlacementSize,
): WatchWidgetAddInput {
  const spec = watchFirstPartyWidgetSpec(kind);
  // First-party widgets land with the same default source the gallery
  // templates carry — a `threads` widget reads the page's ambient scope and
  // stays repointable; connectors-section widgets are `static`.
  const config =
    spec === undefined
      ? undefined
      : {
          source: { kind: spec.section === "threads" ? ("threads" as const) : ("static" as const) },
        };
  return {
    pageId: page.id,
    expectedRevision: page.revision,
    kind,
    ...(config === undefined ? {} : { config }),
    placement: firstFreeWatchPlacement(pageWidgets, size ?? spec?.defaultSize ?? { w: 4, h: 3 }),
  };
}

/**
 * The `addWidget` payload for a pack-bundled widget source: the `agent:` kind
 * names the published source, the `pack:<packId>` provenance marks where the
 * code shipped from, and the widget binds a connector source — to
 * `options.instanceId` when the caller resolved one, otherwise unbound for
 * the user to pick in Configure.
 */
export function buildWatchWidgetAddPackInput(
  page: WatchPage,
  pageWidgets: ReadonlyArray<WatchWidget>,
  source: WatchPackWidgetSource,
  options?: { readonly instanceId?: WatchConnectorInstanceId },
): WatchWidgetAddInput {
  return {
    pageId: page.id,
    expectedRevision: page.revision,
    kind: `agent:${source.sourceId}`,
    config: {
      source: {
        kind: "connector",
        ...(options?.instanceId === undefined ? {} : { binding: options.instanceId }),
      },
    },
    provenance: `pack:${source.packId}`,
    placement: firstFreeWatchPlacement(pageWidgets, { w: 4, h: 3 }),
  };
}

/**
 * The `instantiateFromGallery` payload: the template id plus an optional
 * project override that rescopes the instance to that project instead of the
 * template's own scope.
 */
export function watchGalleryInstantiateInput(
  template: Pick<WatchGalleryTemplate, "id">,
  projectId?: ProjectId,
): WatchPageInstantiateFromGalleryInput {
  return projectId === undefined
    ? { templateId: template.id }
    : { templateId: template.id, projectId };
}

/**
 * The `setLayout` payload for one widget's committed placement, checked
 * against the page revision — a concurrent change fails the write and the
 * client prompts a reload instead of writing last-writer-wins.
 */
export function buildWatchWidgetSetLayoutInput(
  page: WatchPage,
  widgetId: WatchWidgetId,
  placement: WatchWidgetPlacement,
): WatchWidgetSetLayoutInput {
  return {
    pageId: page.id,
    expectedRevision: page.revision,
    layouts: [{ widgetId, placement }],
  };
}

/**
 * The `configure` payload for a config-only edit, checked against the
 * widget's own revision so it can never collide with a layout drag.
 */
export function buildWatchWidgetConfigureInput(
  widget: Pick<WatchWidget, "id" | "revision">,
  config: WatchWidgetConfig,
): WatchWidgetConfigureInput {
  return { widgetId: widget.id, expectedRevision: widget.revision, config };
}

/**
 * The `addWidget` payload duplicating `source` onto the same page: kind,
 * config, and pack provenance ride along; placement lands at the first free
 * slot sized like the source.
 */
export function buildWatchWidgetDuplicateInput(
  page: WatchPage,
  pageWidgets: ReadonlyArray<WatchWidget>,
  source: WatchWidget,
): WatchWidgetAddInput {
  const provenance =
    source.provenance === "firstParty" || source.provenance === "agentPublished"
      ? undefined
      : source.provenance;
  return {
    pageId: page.id,
    expectedRevision: page.revision,
    kind: source.kind,
    config: source.config,
    placement: firstFreeWatchPlacement(pageWidgets, source.placement),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

/**
 * The `moveToPage` payload: both pages' revisions guard the move — a stale
 * revision on either side rejects the whole thing. The widget lands at the
 * destination's first free slot sized like its current placement.
 */
export function buildWatchWidgetMoveToPageInput(
  widget: WatchWidget,
  sourcePage: WatchPage,
  destinationPage: WatchPage,
  destinationPageWidgets: ReadonlyArray<WatchWidget>,
): WatchWidgetMoveToPageInput {
  return {
    widgetId: widget.id,
    sourcePageId: sourcePage.id,
    sourceExpectedRevision: sourcePage.revision,
    destinationPageId: destinationPage.id,
    destinationExpectedRevision: destinationPage.revision,
    placement: firstFreeWatchPlacement(destinationPageWidgets, widget.placement),
  };
}
