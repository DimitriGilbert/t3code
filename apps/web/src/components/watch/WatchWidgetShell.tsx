import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  WATCH_RESIZE_EDGES,
  watchFirstPartyWidgetSpec,
  watchWidgetDisplayTitle,
  watchWidgetIsConfigurable,
  watchWidgetProvenanceMarker,
  type WatchResizeEdge,
} from "@t3tools/client-runtime/state/watch-pages";
import type { WatchWidget, WatchWidgetId } from "@t3tools/contracts";
import { CheckIcon, EllipsisIcon, GripVerticalIcon, Settings2Icon } from "lucide-react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useRef } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { watchWidgetConfigFormId } from "./WatchWidgetSettingsForm";

const RESIZE_HANDLE_STYLES: Record<WatchResizeEdge, string> = {
  n: "top-0 left-1/2 h-2 w-10 -translate-x-1/2 cursor-ns-resize",
  s: "bottom-0 left-1/2 h-2 w-10 -translate-x-1/2 cursor-ns-resize",
  e: "right-0 top-1/2 h-10 w-2 -translate-y-1/2 cursor-ew-resize",
  w: "left-0 top-1/2 h-10 w-2 -translate-y-1/2 cursor-ew-resize",
  se: "right-0 bottom-0 size-3 cursor-nwse-resize",
  sw: "bottom-0 left-0 size-3 cursor-nesw-resize",
};

/**
 * One edge/corner hit zone. Pointer-only on purpose — the keyboard path is
 * the grip's arrows/shift+arrows, so these stay out of the tab order and the
 * a11y tree.
 */
function WatchResizeHandle(props: {
  readonly widgetId: WatchWidgetId;
  readonly edge: WatchResizeEdge;
}) {
  const { listeners, setNodeRef } = useDraggable({
    id: `resize:${props.edge}:${props.widgetId}`,
    data: { kind: "resize", edge: props.edge, widgetId: props.widgetId },
  });
  return (
    <span
      ref={setNodeRef}
      {...listeners}
      aria-hidden="true"
      className={cn("absolute z-20 touch-none", RESIZE_HANDLE_STYLES[props.edge])}
    />
  );
}

const GRIP_KEY_DELTAS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

function WatchProvenanceBadge(props: { readonly widget: WatchWidget }) {
  const marker = watchWidgetProvenanceMarker(props.widget.provenance);
  if (marker === null) return null;
  const packId = marker === "pack" ? props.widget.provenance.slice("pack:".length) : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge size="sm" variant={marker === "agent" ? "info" : "secondary"}>
            {marker === "agent" ? "Agent" : "Pack"}
          </Badge>
        }
      />
      <TooltipPopup>
        {marker === "agent"
          ? "Authored by an agent. Sandboxed, no network."
          : `Installed by connector pack ${packId}.`}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The card chrome around every watch widget: fixed 28px header carrying the
 * provenance marker and title, and a content region. In edit mode the header
 * gains the configure gear, the drag grip (the only move handle), and the
 * overflow menu, and the card gains resize hit zones on every edge center
 * and both bottom corners. While `configuring`, the header swaps to the
 * "Configure" title and a Check "Done" that submits the swapped-in settings
 * form by id; the drag/resize affordances are suppressed for the duration.
 */
export function WatchWidgetShell(props: {
  readonly widget: WatchWidget;
  readonly editing?: boolean | undefined;
  /** The widget's content region is showing its configure form. */
  readonly configuring?: boolean | undefined;
  /** True while this widget's drag/resize candidate overlaps another widget. */
  readonly colliding?: boolean | undefined;
  /** Opens the configure dialog (gear + context-menu entry share it). */
  readonly onConfigure?: (() => void) | undefined;
  /** Opens the widget context menu at a client position. */
  readonly onMenu?: ((position: { x: number; y: number }) => void) | undefined;
  /** Grip arrow keys: move by cell; shift+arrows resize the south/east edges. */
  readonly onKeyboardAdjust?:
    | ((deltaColumns: number, deltaRows: number, resize: boolean) => void)
    | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly children?: ReactNode;
}) {
  const spec = watchFirstPartyWidgetSpec(props.widget.kind);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const editing = props.editing === true;
  // A stale configuring flag on a widget with nothing to edit collapses back
  // to the normal header — the body already fell through to the live view.
  const configuring = props.configuring === true && watchWidgetIsConfigurable(props.widget);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `move:${props.widget.id}`,
    data: { kind: "move", widgetId: props.widget.id },
    disabled: !editing || configuring,
  });

  const handleGripKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const delta = GRIP_KEY_DELTAS[event.key];
    if (delta === undefined || props.onKeyboardAdjust === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    props.onKeyboardAdjust(delta[0], delta[1], event.shiftKey);
  };

  return (
    <section
      ref={setNodeRef}
      data-watch-widget=""
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs/5",
        editing && "outline outline-1 outline-border/60",
        isDragging && "z-30 opacity-80 ring-1 ring-primary/30",
        props.colliding && "cursor-not-allowed",
        props.className,
      )}
      style={{
        ...props.style,
        transform: CSS.Translate.toString(transform),
        // Snap-back ease when a gesture ends or cancels; off during the drag
        // itself so the card tracks the pointer.
        transition: isDragging ? undefined : "transform 150ms ease-out",
      }}
      aria-label={watchWidgetDisplayTitle(props.widget)}
      onContextMenu={(event) => {
        if (props.onMenu === undefined) return;
        event.preventDefault();
        props.onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 px-2",
          (editing || configuring) && "border-b border-border/60",
        )}
      >
        <WatchProvenanceBadge widget={props.widget} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {configuring ? "Configure" : watchWidgetDisplayTitle(props.widget)}
        </span>
        {configuring ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  type="submit"
                  form={watchWidgetConfigFormId(props.widget.id)}
                  aria-label="Done configuring"
                >
                  <CheckIcon />
                </Button>
              }
            />
            <TooltipPopup>Done</TooltipPopup>
          </Tooltip>
        ) : editing ? (
          <>
            {watchWidgetIsConfigurable(props.widget) ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost-muted"
                      size="icon-micro"
                      aria-label="Configure widget"
                      onClick={props.onConfigure}
                    >
                      <Settings2Icon />
                    </Button>
                  }
                />
                <TooltipPopup>Configure</TooltipPopup>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-micro"
                    aria-label="Move widget"
                    {...attributes}
                    {...listeners}
                    aria-roledescription="drag handle"
                    aria-grabbed={isDragging}
                    onKeyDown={handleGripKeyDown}
                    className={cn(
                      props.colliding ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing",
                      isDragging && "cursor-grabbing",
                    )}
                  >
                    <GripVerticalIcon />
                  </Button>
                }
              />
              <TooltipPopup>Drag to move. Arrow keys move, Shift+arrows resize.</TooltipPopup>
            </Tooltip>
            <Button
              ref={menuButtonRef}
              variant="ghost-muted"
              size="icon-micro"
              aria-label="Widget actions"
              onClick={() => {
                const rect = menuButtonRef.current?.getBoundingClientRect();
                props.onMenu?.(
                  rect === undefined ? { x: 0, y: 0 } : { x: rect.left, y: rect.bottom + 4 },
                );
              }}
            >
              <EllipsisIcon />
            </Button>
          </>
        ) : null}
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 px-3 py-2",
          props.children === undefined ? "items-center" : "flex-col",
        )}
      >
        {props.children ?? (
          <p className="truncate text-xs text-muted-foreground">
            {spec?.description ?? "Runs in a sandboxed frame."}
          </p>
        )}
      </div>
      {editing && !configuring
        ? WATCH_RESIZE_EDGES.map((edge) => (
            <WatchResizeHandle key={edge} widgetId={props.widget.id} edge={edge} />
          ))
        : null}
    </section>
  );
}
