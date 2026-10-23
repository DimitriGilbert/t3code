import { formatCompactElapsedSeconds } from "~/components/chat/AgentElapsed";
import { cn } from "~/lib/utils";
import { useEffect, useRef, type ReactNode } from "react";

/** A quiet, centered one-liner for widgets with nothing to show. */
export function WatchWidgetEmpty(props: { readonly text: string }) {
  return (
    <div className="flex h-full min-h-8 w-full items-center justify-center">
      <p className="text-xs text-muted-foreground">{props.text}</p>
    </div>
  );
}

/** Vertically scrolling list region for a widget's rows. */
export function WatchWidgetRows(props: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-y-auto">
      {props.children}
    </div>
  );
}

/**
 * One clickable row: title, a small status/meta cluster, and trailing
 * actions. The row itself is not the button — `actions` holds real buttons,
 * and a <button> cannot legally nest inside one. The title+meta cluster is
 * the open-target; actions sit beside it so their clicks are never row clicks.
 */
export function WatchWidgetRow(props: {
  readonly title: string;
  readonly onOpen: () => void;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "group/row flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-accent/60",
        props.className,
      )}
    >
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.title}</span>
        {props.meta}
      </button>
      {props.actions}
    </div>
  );
}

/**
 * Live elapsed readout ("3m", "1.5h") counted from `startedAt`. Writes the
 * text node directly per second — zero React commits per tick, like
 * `AgentElapsed`.
 */
export function WatchElapsed(props: { readonly startedAt: string | null }) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const startedAt = props.startedAt;

  useEffect(() => {
    const node = textRef.current;
    if (node === null) return;
    if (startedAt === null) {
      node.textContent = "";
      return;
    }
    const update = () => {
      const startMs = Date.parse(startedAt);
      const text = Number.isNaN(startMs)
        ? ""
        : formatCompactElapsedSeconds(Math.max(0, Date.now() - startMs) / 1000);
      if (node.textContent !== text) node.textContent = text;
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return startedAt === null ? null : (
    <span ref={textRef} className="shrink-0 text-2xs tabular-nums text-muted-foreground" />
  );
}
