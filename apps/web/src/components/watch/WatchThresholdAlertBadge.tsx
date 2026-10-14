import type { EnvironmentId, WatchWidgetId } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { acknowledgeWatchThresholdAlert, useWatchThresholdAlert } from "./watchNotificationStore";

/**
 * A threshold-source widget's inline alert state: while a `widget.threshold`
 * notification for this widget is unacknowledged, its header carries a
 * warning badge; clicking the badge acknowledges and clears it.
 */
export function WatchThresholdAlertBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly widgetId: WatchWidgetId;
}) {
  const fired = useWatchThresholdAlert(props.environmentId, props.widgetId);
  if (!fired) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Dismiss threshold alert"
            className="inline-flex shrink-0"
            onClick={() => acknowledgeWatchThresholdAlert(props.environmentId, props.widgetId)}
          >
            <Badge size="sm" variant="warning">
              <GaugeIcon className="size-2.5" />
              Alert
            </Badge>
          </button>
        }
      />
      <TooltipPopup>Threshold alert fired. Click to dismiss.</TooltipPopup>
    </Tooltip>
  );
}
