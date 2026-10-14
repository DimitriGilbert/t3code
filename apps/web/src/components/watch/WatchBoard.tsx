import type { WatchWidget } from "@t3tools/contracts";
import {
  canonicalWatchWidgetOrder,
  firstFreeWatchPlacement,
  reflowWatchPlacements,
  WATCH_GRID_COLUMNS,
  WATCH_GRID_EDIT_MIN_WIDTH_PX,
  WATCH_GRID_MEDIUM_COLUMNS,
  WATCH_GRID_ROW_UNIT_REM,
  WATCH_GRID_STACK_MIN_WIDTH_PX,
} from "@t3tools/client-runtime/state/watch-pages";
import { useMemo } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";

import { WatchWidgetShell } from "./WatchWidgetShell";

const ROW_UNIT_PX = `${WATCH_GRID_ROW_UNIT_REM}rem`;

/**
 * The board's breakpoint contract:
 * - >=1200px: the stored 12-column placement grid.
 * - 768–1200px: a 6-column canonical-order reflow, view-only.
 * - <768px: a single column, the same derived rule mobile renders.
 * Reflowed layouts are render-time views; stored placements are never
 * rewritten to match them.
 */
export function WatchBoard(props: {
  readonly widgets: ReadonlyArray<WatchWidget>;
  readonly editing: boolean;
  /** Edit-mode "Add widget" ghost cell; fires the picker. */
  readonly onAddWidget?: () => void;
}) {
  const wide = useMediaQuery({ min: WATCH_GRID_EDIT_MIN_WIDTH_PX });
  const stacked = useMediaQuery({ max: WATCH_GRID_STACK_MIN_WIDTH_PX - 1 });
  const ordered = useMemo(() => canonicalWatchWidgetOrder(props.widgets), [props.widgets]);

  const mediumPlacements = useMemo(() => {
    if (wide || stacked) return null;
    return reflowWatchPlacements(ordered, WATCH_GRID_MEDIUM_COLUMNS);
  }, [ordered, stacked, wide]);

  if (stacked) {
    return (
      <div className="flex flex-col gap-3">
        {ordered.map((widget) => (
          <WatchWidgetShell
            key={widget.id}
            widget={widget}
            style={{ minHeight: `calc(${ROW_UNIT_PX} * ${widget.placement.h})` }}
          />
        ))}
      </div>
    );
  }

  const columns = wide ? WATCH_GRID_COLUMNS : WATCH_GRID_MEDIUM_COLUMNS;
  return (
    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridAutoRows: ROW_UNIT_PX,
      }}
    >
      {ordered.map((widget) => {
        const placement = wide ? widget.placement : mediumPlacements?.get(widget.id);
        if (placement === undefined) return null;
        return (
          <WatchWidgetShell
            key={widget.id}
            widget={widget}
            editing={props.editing}
            style={{
              gridColumn: `${placement.x + 1} / span ${placement.w}`,
              gridRow: `${placement.y + 1} / span ${placement.h}`,
            }}
          />
        );
      })}
      {props.editing && props.onAddWidget !== undefined ? (
        <button
          type="button"
          onClick={props.onAddWidget}
          className="flex min-h-0 items-center justify-center rounded-xl border border-dashed border-border/70 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent/30 hover:text-foreground"
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
  );
}
