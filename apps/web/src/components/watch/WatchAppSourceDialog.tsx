import type { WatchWidgetSourceRecord } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef } from "react";

import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "~/components/ui/anchoredCopyToast";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

/**
 * The "View source" affordance for `pack` and `agentPublished` widgets: the
 * published TSX in a read-only block plus the artifact hash. Rendered by the
 * host outside the frame, like the provenance marker it belongs to.
 */
export function WatchAppSourceDialog(props: {
  readonly record: WatchWidgetSourceRecord;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(copyButtonRef),
    onError: (error: Error) => showAnchoredCopyErrorToast(copyButtonRef, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Widget source</DialogTitle>
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span>Artifact</span>
            <MiddleTruncate value={props.record.artifactHash} />
            <Button
              ref={copyButtonRef}
              variant="ghost"
              size="icon-micro"
              aria-label="Copy artifact hash"
              onClick={() => copyToClipboard(props.record.artifactHash)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
        </DialogHeader>
        <DialogPanel>
          <pre className="font-mono text-xs leading-5 whitespace-pre-wrap break-all">
            {props.record.source}
          </pre>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
