import { PlayIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { cn } from "~/lib/utils";

/**
 * The "tap to load" placeholder shown only when more than the mount cap of
 * agent widgets is simultaneously visible (the mount registry evicts the LRU).
 * One tap target, flat — no shimmer loop.
 */
export function WatchAppTapToLoad(props: {
  readonly onLoad: () => void;
  readonly className?: string;
}) {
  return (
    <Empty size="compact" className={cn("min-h-0", props.className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PlayIcon />
        </EmptyMedia>
        <EmptyTitle>Load widget</EmptyTitle>
      </EmptyHeader>
      <Button size="sm" variant="secondary" onClick={props.onLoad}>
        Load
      </Button>
    </Empty>
  );
}
