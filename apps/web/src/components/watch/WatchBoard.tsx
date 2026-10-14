import {
  type Announcements,
  DndContext,
  type DragMoveEvent,
  type DragStartEvent,
  PointerSensor,
  type ScreenReaderInstructions,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  canonicalWatchWidgetOrder,
  firstFreeWatchPlacement,
  reflowWatchPlacements,
  WATCH_GRID_COLUMNS,
  WATCH_GRID_EDIT_MIN_WIDTH_PX,
  WATCH_GRID_MEDIUM_COLUMNS,
  WATCH_GRID_ROW_UNIT_REM,
  WATCH_GRID_STACK_MIN_WIDTH_PX,
  watchCellDelta,
  watchGridPitch,
  watchMoveCandidate,
  watchPlacementFits,
  watchPlacementsEqual,
  watchResizeCandidate,
  watchWidgetDisplayTitle,
  type WatchResizeEdge,
} from "@t3tools/client-runtime/state/watch-pages";
import type { WatchWidget, WatchWidgetId, WatchWidgetPlacement } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

import { WatchWidgetShell } from "./WatchWidgetShell";

const ROW_UNIT_PX = `${WATCH_GRID_ROW_UNIT_REM}rem`;

interface BoardDragData {
  readonly kind: "move" | "resize";
  readonly edge?: WatchResizeEdge;
  readonly widgetId: WatchWidgetId;
}

interface BoardInteraction {
  readonly widgetId: WatchWidgetId;
  readonly kind: "move" | "resize";
  readonly edge?: WatchResizeEdge;
  readonly start: WatchWidgetPlacement;
  readonly candidate: WatchWidgetPlacement;
  readonly collides: boolean;
}

interface BoardMetrics {
  readonly columnPitch: number;
  readonly rowPitch: number;
}

/**
 * The board's breakpoint contract:
 * - >=1200px: the stored 12-column placement grid, editable in edit mode.
 * - 768–1200px: a 6-column canonical-order reflow, view-only.
 * - <768px: a single column, the same derived rule mobile renders.
 * Reflowed layouts are render-time views; stored placements are never
 * rewritten to match them.
 *
 * Layout gestures never mutate widgets mid-gesture: the drag/resize produces
 * a ghost candidate that commits one revision-checked `setLayout` on drop.
 * Overlap is forbidden — a colliding ghost tints destructive and its drop is
 * a no-op; Escape cancels the gesture outright.
 */
export function WatchBoard(props: {
  readonly widgets: ReadonlyArray<WatchWidget>;
  readonly editing: boolean;
  /** Edit-mode "Add widget" ghost cell; fires the picker. */
  readonly onAddWidget?: () => void;
  /** Commits a dropped/moved placement — one `setLayout` per gesture. */
  readonly onCommitLayout?: (widgetId: WatchWidgetId, placement: WatchWidgetPlacement) => void;
  readonly onConfigureWidget?: (widget: WatchWidget) => void;
  readonly onWidgetMenu?: (widget: WatchWidget, position: { x: number; y: number }) => void;
}) {
  const wide = useMediaQuery({ min: WATCH_GRID_EDIT_MIN_WIDTH_PX });
  const stacked = useMediaQuery({ max: WATCH_GRID_STACK_MIN_WIDTH_PX - 1 });
  const ordered = useMemo(() => canonicalWatchWidgetOrder(props.widgets), [props.widgets]);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [interaction, setInteraction] = useState<BoardInteraction | null>(null);
  const interactionRef = useRef<BoardInteraction | null>(null);
  // The accessibility announcements can run either before or after the
  // drag-end/cancel handlers, so the settled outcome is kept here as a
  // fallback once `interactionRef` is cleared.
  const gestureOutcomeRef = useRef<{
    widgetId: WatchWidgetId;
    candidate: WatchWidgetPlacement;
    rejected: boolean;
    cancelled: boolean;
  } | null>(null);
  const metricsRef = useRef<BoardMetrics | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Interactions only exist inside edit mode, which only exists on the
  // 12-column board — candidates always run on the canonical grid.
  const editing = props.editing && wide;

  const mediumPlacements = useMemo(() => {
    if (wide || stacked) return null;
    return reflowWatchPlacements(ordered, WATCH_GRID_MEDIUM_COLUMNS);
  }, [ordered, stacked, wide]);

  const setInteractionState = (next: BoardInteraction | null) => {
    interactionRef.current = next;
    setInteraction(next);
  };

  const otherPlacements = (widgetId: WatchWidgetId): WatchWidgetPlacement[] =>
    ordered.filter((widget) => widget.id !== widgetId).map((widget) => widget.placement);

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as BoardDragData | undefined;
    const board = boardRef.current;
    // The activator is the grip for moves and a hit zone for resizes; the
    // card it lives in carries the span sizes both pitches derive from.
    const card =
      event.activatorEvent.target instanceof HTMLElement
        ? event.activatorEvent.target.closest("[data-watch-widget]")
        : null;
    if (data === undefined || board === null || card === null) return;
    const widget = ordered.find((entry) => entry.id === data.widgetId);
    if (widget === undefined) return;
    if (!(card instanceof HTMLElement)) return;
    const boardStyle = window.getComputedStyle(board);
    const columnGap = Number.parseFloat(boardStyle.columnGap) || 0;
    const rowGap = Number.parseFloat(boardStyle.rowGap) || columnGap;
    metricsRef.current = {
      columnPitch: watchGridPitch(card.offsetWidth, widget.placement.w, columnGap),
      rowPitch: watchGridPitch(card.offsetHeight, widget.placement.h, rowGap),
    };
    setInteractionState({
      widgetId: widget.id,
      kind: data.kind,
      ...(data.edge === undefined ? {} : { edge: data.edge }),
      start: widget.placement,
      candidate: widget.placement,
      collides: false,
    });
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const metrics = metricsRef.current;
    const current = interactionRef.current;
    if (metrics === null || current === null) return;
    const deltaColumns = watchCellDelta(event.delta.x, metrics.columnPitch);
    const deltaRows = watchCellDelta(event.delta.y, metrics.rowPitch);
    const candidate =
      current.kind === "resize" && current.edge !== undefined
        ? watchResizeCandidate(current.start, current.edge, deltaColumns, deltaRows)
        : watchMoveCandidate(current.start, deltaColumns, deltaRows);
    const collides = !watchPlacementFits(candidate, otherPlacements(current.widgetId));
    if (watchPlacementsEqual(candidate, current.candidate) && collides === current.collides) {
      return;
    }
    setInteractionState({ ...current, candidate, collides });
  };

  const handleDragEnd = () => {
    const finished = interactionRef.current;
    setInteractionState(null);
    metricsRef.current = null;
    if (finished === null) return;
    gestureOutcomeRef.current = {
      widgetId: finished.widgetId,
      candidate: finished.candidate,
      rejected: finished.collides,
      cancelled: false,
    };
    if (finished.collides) return;
    if (watchPlacementsEqual(finished.candidate, finished.start)) return;
    props.onCommitLayout?.(finished.widgetId, finished.candidate);
  };

  const handleDragCancel = () => {
    const finished = interactionRef.current;
    setInteractionState(null);
    metricsRef.current = null;
    if (finished === null) return;
    gestureOutcomeRef.current = {
      widgetId: finished.widgetId,
      candidate: finished.candidate,
      rejected: false,
      cancelled: true,
    };
  };

  const handleKeyboardAdjust = (
    widget: WatchWidget,
    deltaColumns: number,
    deltaRows: number,
    resize: boolean,
  ) => {
    if (!editing || props.onCommitLayout === undefined) return;
    const candidate = resize
      ? watchResizeCandidate(
          widget.placement,
          deltaColumns !== 0 ? "e" : "s",
          deltaColumns,
          deltaRows,
        )
      : watchMoveCandidate(widget.placement, deltaColumns, deltaRows);
    if (watchPlacementsEqual(candidate, widget.placement)) return;
    if (!watchPlacementFits(candidate, otherPlacements(widget.id))) return;
    props.onCommitLayout(widget.id, candidate);
  };

  // While a gesture is in flight, Escape must cancel it without also firing
  // the page-level Escape (which would exit edit mode). The sensor's own
  // listener performs the cancel; marking the event handled is enough. The
  // boolean dep keeps candidate churn from re-registering the listener.
  const gestureActive = interaction !== null;
  useEffect(() => {
    if (!gestureActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [gestureActive]);

  const widgetTitleForId = (widgetId: WatchWidgetId | undefined) => {
    const widget = ordered.find((entry) => entry.id === widgetId);
    return widget === undefined ? null : watchWidgetDisplayTitle(widget);
  };

  const gestureOutcome = () => {
    const live = interactionRef.current;
    if (live === null) return gestureOutcomeRef.current;
    return {
      widgetId: live.widgetId,
      candidate: live.candidate,
      rejected:
        live.collides || !watchPlacementFits(live.candidate, otherPlacements(live.widgetId)),
      cancelled: false,
    };
  };

  // Quiet mid-gesture (the ghost carries position); announce the gesture's
  // endpoints with the widget's title rather than the draggable id.
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const data = active.data.current as BoardDragData | undefined;
      const title = widgetTitleForId(data?.widgetId);
      if (title === null) return undefined;
      return `${data?.kind === "resize" ? "Resizing" : "Picked up"} ${title}.`;
    },
    onDragOver: () => undefined,
    onDragMove: () => undefined,
    onDragEnd: () => {
      const finished = gestureOutcome();
      if (finished === null || finished.cancelled) return undefined;
      const title = widgetTitleForId(finished.widgetId);
      if (title === null) return undefined;
      return finished.rejected
        ? `${title} can't overlap another widget or leave the grid.`
        : `${title} placed at column ${finished.candidate.x + 1}, row ${finished.candidate.y + 1}.`;
    },
    onDragCancel: () => {
      const finished = gestureOutcome();
      const title = widgetTitleForId(finished?.widgetId);
      return title === null ? "Gesture cancelled." : `${title} returned to its place.`;
    },
  };

  // No KeyboardSensor is registered — the keyboard path is the focused
  // grip's arrow keys (Shift resizes), so the default "press space bar to
  // lift" instructions would describe a gesture that does not exist.
  const screenReaderInstructions: ScreenReaderInstructions = {
    draggable:
      "With the widget's drag handle focused, arrow keys move it one cell and Shift plus arrow keys resize it.",
  };

  const renderShell = (widget: WatchWidget, placement: WatchWidgetPlacement | undefined) => (
    <WatchWidgetShell
      key={widget.id}
      widget={widget}
      editing={editing}
      colliding={interaction?.widgetId === widget.id && interaction.collides}
      onConfigure={props.onConfigureWidget ? () => props.onConfigureWidget?.(widget) : undefined}
      onMenu={props.onWidgetMenu ? (position) => props.onWidgetMenu?.(widget, position) : undefined}
      onKeyboardAdjust={(deltaColumns, deltaRows, resize) =>
        handleKeyboardAdjust(widget, deltaColumns, deltaRows, resize)
      }
      style={
        placement === undefined
          ? undefined
          : {
              gridColumn: `${placement.x + 1} / span ${placement.w}`,
              gridRow: `${placement.y + 1} / span ${placement.h}`,
            }
      }
    />
  );

  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements, screenReaderInstructions }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {stacked ? (
        <div className="flex flex-col gap-3">
          {ordered.map((widget) => (
            <WatchWidgetShell
              key={widget.id}
              widget={widget}
              onConfigure={
                props.onConfigureWidget ? () => props.onConfigureWidget?.(widget) : undefined
              }
              onMenu={
                props.onWidgetMenu
                  ? (position) => props.onWidgetMenu?.(widget, position)
                  : undefined
              }
              style={{ minHeight: `calc(${ROW_UNIT_PX} * ${widget.placement.h})` }}
            />
          ))}
        </div>
      ) : (
        <div
          ref={boardRef}
          className={cn("relative grid gap-3", interaction?.collides && "cursor-not-allowed")}
          style={{
            gridTemplateColumns: `repeat(${wide ? WATCH_GRID_COLUMNS : WATCH_GRID_MEDIUM_COLUMNS}, minmax(0, 1fr))`,
            gridAutoRows: ROW_UNIT_PX,
          }}
        >
          {interaction !== null ? (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 flex gap-3">
              {Array.from({ length: WATCH_GRID_COLUMNS }, (_, index) => (
                <div
                  key={index}
                  className={cn(
                    "min-w-0 flex-1",
                    index < WATCH_GRID_COLUMNS - 1 && "border-r border-border/40",
                  )}
                />
              ))}
            </div>
          ) : null}
          {ordered.map((widget) => {
            const placement = wide ? widget.placement : mediumPlacements?.get(widget.id);
            if (placement === undefined) return null;
            return renderShell(widget, placement);
          })}
          {interaction !== null ? (
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none z-20 rounded-xl border border-dashed",
                interaction.collides
                  ? "border-destructive/60 bg-destructive/8"
                  : "border-primary/40 bg-primary/8",
              )}
              style={{
                gridColumn: `${interaction.candidate.x + 1} / span ${interaction.candidate.w}`,
                gridRow: `${interaction.candidate.y + 1} / span ${interaction.candidate.h}`,
              }}
            />
          ) : null}
          {editing && props.onAddWidget !== undefined ? (
            <button
              type="button"
              onClick={props.onAddWidget}
              className="z-10 flex min-h-0 items-center justify-center rounded-xl border border-dashed border-border/70 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent/30 hover:text-foreground"
              style={(() => {
                const slot = firstFreeWatchPlacement(ordered, { w: 4, h: 2 });
                return {
                  gridColumn: `${slot.x + 1} / span ${slot.w}`,
                  gridRow: `${slot.y + 1} / span ${slot.h}`,
                };
              })()}
            >
              Add widget
            </button>
          ) : null}
        </div>
      )}
    </DndContext>
  );
}
