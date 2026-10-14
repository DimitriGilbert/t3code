import type { WatchWidgetProvenance } from "@t3tools/contracts";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const PACK_PROVENANCE_PREFIX = "pack:";

/**
 * The non-spoofable provenance marker: rendered by the host in the widget
 * chrome, never inside the sandbox and never styleable by widget content.
 * `firstParty` shows nothing (T3's own widgets need no warning); `pack` and
 * `agentPublished` get a badge whose text is set here and nowhere else.
 */
export function WatchProvenanceMarker(props: { readonly provenance: WatchWidgetProvenance }) {
  const { provenance } = props;
  if (provenance === "firstParty") return null;
  const isAgentAuthored = provenance === "agentPublished";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge size="sm" variant={isAgentAuthored ? "info" : "secondary"}>
            {isAgentAuthored ? "Agent" : "Pack"}
          </Badge>
        }
      />
      <TooltipPopup>
        {isAgentAuthored
          ? "Authored by an agent — sandboxed, no network"
          : `Installed by connector pack ${provenance.slice(PACK_PROVENANCE_PREFIX.length)}`}
      </TooltipPopup>
    </Tooltip>
  );
}
