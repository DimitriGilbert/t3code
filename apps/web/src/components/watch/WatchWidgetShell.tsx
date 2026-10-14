import type { WatchWidget } from "@t3tools/contracts";
import {
  watchFirstPartyWidgetSpec,
  watchWidgetDisplayTitle,
  watchWidgetProvenanceMarker,
} from "@t3tools/client-runtime/state/watch-pages";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

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
 * provenance marker and title, and a content region. Phase 5a renders the
 * kind's one-line description as placeholder content; real widget bodies land
 * with their renderers in a later phase.
 */
export function WatchWidgetShell(props: {
  readonly widget: WatchWidget;
  readonly editing?: boolean;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}) {
  const spec = watchFirstPartyWidgetSpec(props.widget.kind);
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs/5",
        props.editing && "outline outline-1 outline-border/60",
        props.className,
      )}
      style={props.style}
      aria-label={watchWidgetDisplayTitle(props.widget)}
    >
      <div
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 px-2",
          props.editing && "border-b border-border/60",
        )}
      >
        <WatchProvenanceBadge widget={props.widget} />
        <span className="truncate text-xs font-medium">
          {watchWidgetDisplayTitle(props.widget)}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center px-3 py-2">
        <p className="truncate text-xs text-muted-foreground">
          {spec?.description ?? "Runs in a sandboxed frame."}
        </p>
      </div>
    </section>
  );
}
