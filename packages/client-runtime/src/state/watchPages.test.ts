import {
  ProjectId,
  WatchPageId,
  WatchWidgetId,
  type WatchGalleryTemplate,
  type WatchPage,
  type WatchWidget,
  type WatchWidgetPlacement,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildWatchWidgetAddInput,
  buildWatchWidgetConfigureInput,
  buildWatchWidgetDuplicateInput,
  buildWatchWidgetMoveToPageInput,
  buildWatchWidgetSetLayoutInput,
  canonicalWatchWidgetOrder,
  firstFreeWatchPlacement,
  nextWatchPageName,
  partitionWatchPages,
  reflowWatchPlacements,
  resolveWatchThreadsProjectBinding,
  sortWatchPages,
  WATCH_GRID_COLUMNS,
  watchBoardColumns,
  watchCellDelta,
  watchGalleryInstantiateInput,
  watchGridPitch,
  watchLayoutEditableAt,
  watchMoveCandidate,
  watchPageAmbientProjectId,
  watchPageReorderBefore,
  watchPageReorderForDrop,
  watchPageShowsProjectBadge,
  watchPlacementFits,
  watchPlacementsOverlap,
  watchResizeCandidate,
  watchWidgetDisplayTitle,
  watchWidgetProvenanceMarker,
} from "./watchPages.ts";

const pageId = (id: string) => WatchPageId.make(`watch-page:${id}`);
const widgetId = (id: string) => WatchWidgetId.make(`watch-widget:${id}`);
const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");

const page = (id: string, overrides: Partial<WatchPage> = {}): WatchPage => ({
  id: pageId(id),
  name: `Page ${id}`,
  scope: "global",
  projectId: null,
  orderKey: id,
  revision: 1,
  mobileRevision: 0,
  archivedAt: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

const widget = (
  id: string,
  pageKey: string,
  placement: WatchWidgetPlacement,
  overrides: Partial<WatchWidget> = {},
): WatchWidget => ({
  id: widgetId(id),
  pageId: pageId(pageKey),
  kind: "active-work",
  config: {},
  placement,
  revision: 1,
  mobileOrder: 0,
  mobileHidden: false,
  provenance: "firstParty",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

describe("sortWatchPages", () => {
  it("orders by orderKey then id and does not mutate the input", () => {
    const pages = [page("b"), page("a", { id: pageId("a2") }), page("a", { id: pageId("a1") })];
    const sorted = sortWatchPages(pages);
    expect(sorted.map((p) => p.id)).toEqual([pageId("a1"), pageId("a2"), pageId("b")]);
    expect(pages[0]?.id).toBe(pageId("b"));
  });
});

describe("partitionWatchPages", () => {
  it("splits archived pages out of the active strip, each ordered", () => {
    const { active, archived } = partitionWatchPages([
      page("b"),
      page("z", { archivedAt: "2025-01-02T00:00:00.000Z" }),
      page("a"),
      page("y", { archivedAt: "2025-01-02T00:00:00.000Z" }),
    ]);
    expect(active.map((p) => p.id)).toEqual([pageId("a"), pageId("b")]);
    expect(archived.map((p) => p.id)).toEqual([pageId("y"), pageId("z")]);
  });
});

describe("nextWatchPageName", () => {
  it("returns the base name first, then the first free suffix", () => {
    expect(nextWatchPageName([])).toBe("New page");
    const pages = [page("a"), page("b", { name: "New page" }), page("c", { name: "New page 2" })];
    expect(nextWatchPageName(pages)).toBe("New page 3");
  });
});

describe("watchPageAmbientProjectId", () => {
  it("lends the project only for project-scoped pages", () => {
    expect(watchPageAmbientProjectId(page("g"))).toBeNull();
    expect(watchPageAmbientProjectId(page("p", { scope: "project", projectId: projectA }))).toBe(
      projectA,
    );
  });
});

describe("watchPageShowsProjectBadge", () => {
  const scoped = page("p", { scope: "project", projectId: projectA });

  it("shows only for project pages outside their own project context", () => {
    expect(watchPageShowsProjectBadge(scoped, null)).toBe(true);
    expect(watchPageShowsProjectBadge(scoped, projectB)).toBe(true);
    expect(watchPageShowsProjectBadge(scoped, projectA)).toBe(false);
    expect(watchPageShowsProjectBadge(page("g"), null)).toBe(false);
  });
});

describe("watchPageReorderBefore", () => {
  const ordered = [page("a"), page("b"), page("c")];

  it("slots left in front of the previous page", () => {
    expect(watchPageReorderBefore(ordered, pageId("b"), "left")).toBe(pageId("a"));
  });

  it("slots right in front of the page after the neighbour, or null at the end", () => {
    expect(watchPageReorderBefore(ordered, pageId("a"), "right")).toBe(pageId("c"));
    expect(watchPageReorderBefore(ordered, pageId("b"), "right")).toBeNull();
  });

  it("returns undefined when the page is at the edge or absent", () => {
    expect(watchPageReorderBefore(ordered, pageId("a"), "left")).toBeUndefined();
    expect(watchPageReorderBefore(ordered, pageId("c"), "right")).toBeUndefined();
    expect(watchPageReorderBefore(ordered, pageId("missing"), "left")).toBeUndefined();
  });
});

describe("watchPageReorderForDrop", () => {
  const ordered = [page("a"), page("b"), page("c"), page("d")];

  it("dropping forward lands after the target, backward lands in front", () => {
    expect(watchPageReorderForDrop(ordered, pageId("a"), pageId("c"))).toBe(pageId("d"));
    expect(watchPageReorderForDrop(ordered, pageId("a"), pageId("d"))).toBeNull();
    expect(watchPageReorderForDrop(ordered, pageId("d"), pageId("b"))).toBe(pageId("b"));
  });

  it("returns undefined for self-drops and unknown ids", () => {
    expect(watchPageReorderForDrop(ordered, pageId("a"), pageId("a"))).toBeUndefined();
    expect(watchPageReorderForDrop(ordered, pageId("a"), pageId("missing"))).toBeUndefined();
  });
});

describe("canonicalWatchWidgetOrder", () => {
  it("orders by y then x with a stable insertion tiebreak", () => {
    const widgets = [
      widget("third", "p", { x: 6, y: 0, w: 4, h: 2 }),
      widget("first", "p", { x: 0, y: 0, w: 4, h: 2 }),
      widget("tie-a", "p", { x: 0, y: 2, w: 4, h: 2 }),
      widget("tie-b", "p", { x: 0, y: 2, w: 4, h: 2 }),
    ];
    expect(canonicalWatchWidgetOrder(widgets).map((w) => w.id)).toEqual([
      widgetId("first"),
      widgetId("third"),
      widgetId("tie-a"),
      widgetId("tie-b"),
    ]);
  });
});

describe("watchPlacementsOverlap", () => {
  const base = { x: 0, y: 0, w: 4, h: 2 };

  it("detects shared cells and treats edge contact as free", () => {
    expect(watchPlacementsOverlap(base, { x: 3, y: 1, w: 2, h: 2 })).toBe(true);
    expect(watchPlacementsOverlap(base, { x: 4, y: 0, w: 2, h: 2 })).toBe(false);
    expect(watchPlacementsOverlap(base, { x: 0, y: 2, w: 4, h: 2 })).toBe(false);
  });
});

describe("firstFreeWatchPlacement", () => {
  it("places at the origin on an empty board", () => {
    expect(firstFreeWatchPlacement([], { w: 4, h: 2 })).toEqual({ x: 0, y: 0, w: 4, h: 2 });
  });

  it("fills the first horizontal gap before wrapping to a new row", () => {
    const placed = [widget("a", "p", { x: 0, y: 0, w: 7, h: 4 })];
    expect(firstFreeWatchPlacement(placed, { w: 5, h: 4 })).toEqual({ x: 7, y: 0, w: 5, h: 4 });
    expect(firstFreeWatchPlacement(placed, { w: 6, h: 4 })).toEqual({ x: 0, y: 4, w: 6, h: 4 });
  });

  it("lands below the deepest widget when the board is full and clamps width", () => {
    const placed = [widget("a", "p", { x: 0, y: 0, w: 12, h: 2 })];
    expect(firstFreeWatchPlacement(placed, { w: 16, h: 3 })).toEqual({ x: 0, y: 2, w: 12, h: 3 });
  });

  it("carries minCols through, clamped to the column count", () => {
    expect(firstFreeWatchPlacement([], { w: 4, h: 2, minCols: 3 }, 6)).toEqual({
      x: 0,
      y: 0,
      w: 4,
      h: 2,
      minCols: 3,
    });
  });
});

describe("reflowWatchPlacements", () => {
  it("packs canonical order into fewer columns without overlaps or mutation", () => {
    const widgets = [
      widget("wide", "p", { x: 0, y: 0, w: 12, h: 2 }),
      widget("right", "p", { x: 7, y: 2, w: 5, h: 4 }),
      widget("left", "p", { x: 0, y: 2, w: 4, h: 4 }),
    ];
    const before = widgets.map((w) => ({ ...w.placement }));
    const reflowed = reflowWatchPlacements(widgets, 6);

    expect(reflowed.get(widgetId("wide"))).toEqual({ x: 0, y: 0, w: 6, h: 2 });
    // Canonical order (y, then x) places `left` first; it claims the top-left
    // slot and `right` wraps below it since 5 columns can't share its row.
    expect(reflowed.get(widgetId("left"))).toEqual({ x: 0, y: 2, w: 4, h: 4 });
    expect(reflowed.get(widgetId("right"))).toEqual({ x: 0, y: 6, w: 5, h: 4 });
    // Stored placements are untouched; the reflow is a render-time view.
    expect(widgets.map((w) => w.placement)).toEqual(before);
  });

  it("collapses to a strict single column at 1 column", () => {
    const widgets = [
      widget("a", "p", { x: 0, y: 0, w: 6, h: 2 }),
      widget("b", "p", { x: 6, y: 0, w: 6, h: 2 }),
    ];
    const reflowed = reflowWatchPlacements(widgets, 1);
    expect(reflowed.get(widgetId("a"))).toEqual({ x: 0, y: 0, w: 1, h: 2 });
    expect(reflowed.get(widgetId("b"))).toEqual({ x: 0, y: 2, w: 1, h: 2 });
  });
});

describe("resolveWatchThreadsProjectBinding", () => {
  const projectPage = page("p", { scope: "project", projectId: projectA });
  const threadsWidget = (binding?: string) =>
    widget(
      "w",
      "p",
      { x: 0, y: 0, w: 4, h: 2 },
      {
        config: { source: { kind: "threads", ...(binding === undefined ? {} : { binding }) } },
      },
    );

  it("falls back to the page ambient scope when unbound", () => {
    expect(resolveWatchThreadsProjectBinding(projectPage, threadsWidget())).toBe(projectA);
    expect(resolveWatchThreadsProjectBinding(page("g"), threadsWidget())).toBeNull();
  });

  it("honours an explicit project binding and the '*' all-projects binding", () => {
    expect(resolveWatchThreadsProjectBinding(projectPage, threadsWidget(projectB))).toBe(projectB);
    expect(resolveWatchThreadsProjectBinding(projectPage, threadsWidget("*"))).toBeNull();
    expect(resolveWatchThreadsProjectBinding(page("g"), threadsWidget(projectA))).toBe(projectA);
  });

  it("follows the new ambient project after a rescope while explicit bindings stay", () => {
    // Rescoping writes no widget rows, so resolution alone determines what an
    // unbound widget reads after the page moves.
    const rescoped = page("p", { scope: "project", projectId: projectB });
    expect(resolveWatchThreadsProjectBinding(rescoped, threadsWidget())).toBe(projectB);
    expect(resolveWatchThreadsProjectBinding(rescoped, threadsWidget(projectA))).toBe(projectA);
  });

  it("binds nothing for non-threads sources or missing source", () => {
    const connector = widget(
      "w",
      "p",
      { x: 0, y: 0, w: 4, h: 2 },
      {
        config: { source: { kind: "connector", binding: "instance-1" } },
      },
    );
    expect(resolveWatchThreadsProjectBinding(projectPage, connector)).toBeNull();
    expect(
      resolveWatchThreadsProjectBinding(projectPage, widget("w", "p", { x: 0, y: 0, w: 4, h: 2 })),
    ).toBeNull();
  });
});

describe("watchWidgetProvenanceMarker / watchWidgetDisplayTitle", () => {
  it("marks only non-first-party code", () => {
    expect(watchWidgetProvenanceMarker("firstParty")).toBeNull();
    expect(watchWidgetProvenanceMarker("agentPublished")).toBe("agent");
    expect(watchWidgetProvenanceMarker("pack:pack-1")).toBe("pack");
  });

  it("uses registry titles, a generic agent label, then the raw kind", () => {
    expect(watchWidgetDisplayTitle({ kind: "needs-attention" })).toBe("Needs attention");
    expect(watchWidgetDisplayTitle({ kind: "agent:src-1" })).toBe("Agent widget");
    expect(watchWidgetDisplayTitle({ kind: "custom-kind" })).toBe("custom-kind");
  });
});

describe("buildWatchWidgetAddInput", () => {
  it("carries the page revision and lands at the first free slot", () => {
    const target = page("p", { revision: 7 });
    const placed = [widget("a", "p", { x: 0, y: 0, w: 7, h: 4 })];
    const input = buildWatchWidgetAddInput(target, placed, "connector-status");
    expect(input).toEqual({
      pageId: target.id,
      expectedRevision: 7,
      kind: "connector-status",
      config: { source: { kind: "static" } },
      placement: { x: 0, y: 4, w: 12, h: 2 },
    });
  });

  it("defaults threads-section widgets to the ambient threads source", () => {
    const input = buildWatchWidgetAddInput(page("p"), [], "active-work");
    expect(input.config).toEqual({ source: { kind: "threads" } });
    // Kinds outside the first-party catalog carry no seed config.
    expect(buildWatchWidgetAddInput(page("p"), [], "agent:src-1").config).toBeUndefined();
  });

  it("sizes unknown kinds from the provided override or the fallback", () => {
    const target = page("p");
    expect(buildWatchWidgetAddInput(target, [], "agent:src-1", { w: 6, h: 5 }).placement).toEqual({
      x: 0,
      y: 0,
      w: 6,
      h: 5,
    });
    expect(buildWatchWidgetAddInput(target, [], "agent:src-1").placement).toEqual({
      x: 0,
      y: 0,
      w: 4,
      h: 3,
    });
  });
});

describe("watchGalleryInstantiateInput", () => {
  const template: Pick<WatchGalleryTemplate, "id"> = { id: "starter-watch" };

  it("uses the template scope unless a project override is given", () => {
    expect(watchGalleryInstantiateInput(template)).toEqual({ templateId: "starter-watch" });
    expect(watchGalleryInstantiateInput(template, projectA)).toEqual({
      templateId: "starter-watch",
      projectId: projectA,
    });
  });
});

describe("WATCH_GRID_COLUMNS", () => {
  it("is the 12-column contract shared by the contract placements", () => {
    expect(WATCH_GRID_COLUMNS).toBe(12);
  });
});

describe("watchBoardColumns / watchLayoutEditableAt", () => {
  it("maps viewport width to the board's column contract", () => {
    expect(watchBoardColumns(1600)).toBe(12);
    expect(watchBoardColumns(1200)).toBe(12);
    expect(watchBoardColumns(1199)).toBe(6);
    expect(watchBoardColumns(768)).toBe(6);
    expect(watchBoardColumns(767)).toBe(1);
    expect(watchBoardColumns(320)).toBe(1);
  });

  it("gates layout editing at 1200px exactly", () => {
    expect(watchLayoutEditableAt(1200)).toBe(true);
    expect(watchLayoutEditableAt(1199)).toBe(false);
    expect(watchLayoutEditableAt(768)).toBe(false);
    expect(watchLayoutEditableAt(0)).toBe(false);
  });
});

describe("watchGridPitch / watchCellDelta", () => {
  it("recovers cell pitch from a rendered span including its gaps", () => {
    // A 4-column widget at 12px gaps: 4*72 + 3*12 = 324 → pitch 72 + 12 = 84.
    expect(watchGridPitch(324, 4, 12)).toBe(84);
    expect(watchGridPitch(128, 2, 12)).toBe(70);
    expect(watchGridPitch(100, 0, 12)).toBe(0);
  });

  it("snaps pointer deltas to whole cells at the half-cell boundary", () => {
    expect(watchCellDelta(0, 80)).toBe(0);
    expect(watchCellDelta(39, 80)).toBe(0);
    expect(watchCellDelta(41, 80)).toBe(1);
    expect(watchCellDelta(-41, 80)).toBe(-1);
    expect(watchCellDelta(167, 80)).toBe(2);
    expect(watchCellDelta(100, 0)).toBe(0);
  });
});

describe("watchPlacementFits", () => {
  const others = [{ x: 4, y: 0, w: 4, h: 2 }];

  it("accepts a free in-bounds placement and rejects overlap", () => {
    expect(watchPlacementFits({ x: 0, y: 0, w: 4, h: 2 }, others)).toBe(true);
    expect(watchPlacementFits({ x: 5, y: 1, w: 4, h: 2 }, others)).toBe(false);
    // Edge contact is free.
    expect(watchPlacementFits({ x: 8, y: 0, w: 4, h: 2 }, others)).toBe(true);
    expect(watchPlacementFits({ x: 4, y: 2, w: 4, h: 2 }, others)).toBe(true);
  });

  it("rejects out-of-grid and below-floor geometry", () => {
    expect(watchPlacementFits({ x: -1, y: 0, w: 4, h: 2 }, [])).toBe(false);
    expect(watchPlacementFits({ x: 0, y: -1, w: 4, h: 2 }, [])).toBe(false);
    expect(watchPlacementFits({ x: 9, y: 0, w: 4, h: 2 }, [])).toBe(false);
    expect(watchPlacementFits({ x: 0, y: 0, w: 0, h: 2 }, [])).toBe(false);
    expect(watchPlacementFits({ x: 0, y: 0, w: 4, h: 0 }, [])).toBe(false);
    expect(watchPlacementFits({ x: 0, y: 0, w: 2, h: 2, minCols: 3 }, [])).toBe(false);
    expect(watchPlacementFits({ x: 0, y: 0, w: 3, h: 2, minCols: 3 }, [])).toBe(true);
  });
});

describe("watchMoveCandidate", () => {
  const start = { x: 4, y: 2, w: 4, h: 2 };

  it("shifts by whole cells and clamps to the grid edges", () => {
    expect(watchMoveCandidate(start, 2, 1)).toEqual({ x: 6, y: 3, w: 4, h: 2 });
    expect(watchMoveCandidate(start, -10, -10)).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    expect(watchMoveCandidate(start, 20, 0)).toEqual({ x: 8, y: 2, w: 4, h: 2 });
  });

  it("keeps minCols through the move", () => {
    expect(watchMoveCandidate({ ...start, minCols: 3 }, 1, 0).minCols).toBe(3);
  });
});

describe("watchResizeCandidate", () => {
  const start = { x: 4, y: 2, w: 4, h: 2 };

  it("grows and shrinks each edge independently", () => {
    expect(watchResizeCandidate(start, "e", 2, 0)).toEqual({ x: 4, y: 2, w: 6, h: 2 });
    expect(watchResizeCandidate(start, "s", 0, 2)).toEqual({ x: 4, y: 2, w: 4, h: 4 });
    expect(watchResizeCandidate(start, "w", -2, 0)).toEqual({ x: 2, y: 2, w: 6, h: 2 });
    expect(watchResizeCandidate(start, "n", 0, -2)).toEqual({ x: 4, y: 0, w: 4, h: 4 });
    expect(watchResizeCandidate(start, "se", 1, 1)).toEqual({ x: 4, y: 2, w: 5, h: 3 });
    expect(watchResizeCandidate(start, "sw", -1, 1)).toEqual({ x: 3, y: 2, w: 5, h: 3 });
  });

  it("shrinking west/north moves the origin, never below zero", () => {
    expect(watchResizeCandidate(start, "w", 2, 0)).toEqual({ x: 6, y: 2, w: 2, h: 2 });
    expect(watchResizeCandidate(start, "w", -10, 0)).toEqual({ x: 0, y: 2, w: 8, h: 2 });
    // Northward growth can claim at most the rows above the widget.
    expect(watchResizeCandidate(start, "n", 0, -10)).toEqual({ x: 4, y: 0, w: 4, h: 4 });
  });

  it("clamps width at minCols and height at one row", () => {
    const withMin = { ...start, minCols: 3 };
    expect(watchResizeCandidate(withMin, "e", -10, 0)).toEqual({
      x: 4,
      y: 2,
      w: 3,
      h: 2,
      minCols: 3,
    });
    // West edge shrink also stops at minCols, origin parked at x + w - minCols.
    expect(watchResizeCandidate(withMin, "w", 10, 0)).toEqual({
      x: 5,
      y: 2,
      w: 3,
      h: 2,
      minCols: 3,
    });
    expect(watchResizeCandidate(start, "s", 0, -10)).toEqual({ x: 4, y: 2, w: 4, h: 1 });
    expect(watchResizeCandidate(start, "e", -10, 0).w).toBe(1);
  });

  it("clamps east growth at the board edge and never escapes the grid", () => {
    expect(watchResizeCandidate(start, "e", 20, 0).w).toBe(8);
    const resized = watchResizeCandidate({ x: 10, y: 0, w: 2, h: 1 }, "se", 10, 10);
    expect(resized.x + resized.w).toBeLessThanOrEqual(WATCH_GRID_COLUMNS);
    expect(resized.h).toBe(11);
  });
});

describe("buildWatchWidgetSetLayoutInput", () => {
  it("carries the page revision alongside the single placement patch", () => {
    const target = page("p", { revision: 9 });
    const placement = { x: 2, y: 1, w: 4, h: 2 };
    expect(buildWatchWidgetSetLayoutInput(target, widgetId("w"), placement)).toEqual({
      pageId: target.id,
      expectedRevision: 9,
      layouts: [{ widgetId: widgetId("w"), placement }],
    });
  });
});

describe("buildWatchWidgetConfigureInput", () => {
  it("is checked against the widget revision, not the page's", () => {
    const source = widget("w", "p", { x: 0, y: 0, w: 4, h: 2 }, { revision: 4 });
    const config = { source: { kind: "threads" as const, binding: projectA } };
    expect(buildWatchWidgetConfigureInput(source, config)).toEqual({
      widgetId: widgetId("w"),
      expectedRevision: 4,
      config,
    });
  });
});

describe("buildWatchWidgetDuplicateInput", () => {
  it("copies kind and config, lands at the first free slot at source size", () => {
    const target = page("p", { revision: 3 });
    const source = widget(
      "a",
      "p",
      { x: 0, y: 0, w: 7, h: 4 },
      { config: { source: { kind: "threads", binding: projectA } } },
    );
    expect(buildWatchWidgetDuplicateInput(target, [source], source)).toEqual({
      pageId: target.id,
      expectedRevision: 3,
      kind: "active-work",
      config: { source: { kind: "threads", binding: projectA } },
      // A 7-wide copy can't share the source's row; it wraps to the row below.
      placement: { x: 0, y: 4, w: 7, h: 4 },
    });
  });

  it("carries pack provenance but never first-party or agent markers", () => {
    const target = page("p");
    const packed = widget(
      "a",
      "p",
      { x: 0, y: 0, w: 4, h: 2 },
      {
        kind: "agent:src-9",
        provenance: "pack:pack-7",
      },
    );
    expect(buildWatchWidgetDuplicateInput(target, [], packed).provenance).toBe("pack:pack-7");
    expect(
      buildWatchWidgetDuplicateInput(
        target,
        [],
        widget("b", "p", { x: 0, y: 0, w: 4, h: 2 }, { provenance: "agentPublished" }),
      ).provenance,
    ).toBeUndefined();
    expect(
      buildWatchWidgetDuplicateInput(target, [], widget("c", "p", { x: 0, y: 0, w: 4, h: 2 }))
        .provenance,
    ).toBeUndefined();
  });
});

describe("buildWatchWidgetMoveToPageInput", () => {
  it("guards both page revisions and lands at the destination's first free slot", () => {
    const source = page("s", { revision: 2 });
    const destination = page("d", { revision: 11 });
    const moving = widget("m", "s", { x: 0, y: 0, w: 7, h: 4 });
    const destPlaced = [widget("x", "d", { x: 0, y: 0, w: 12, h: 1 })];
    expect(buildWatchWidgetMoveToPageInput(moving, source, destination, destPlaced)).toEqual({
      widgetId: widgetId("m"),
      sourcePageId: source.id,
      sourceExpectedRevision: 2,
      destinationPageId: destination.id,
      destinationExpectedRevision: 11,
      placement: { x: 0, y: 1, w: 7, h: 4 },
    });
  });
});
