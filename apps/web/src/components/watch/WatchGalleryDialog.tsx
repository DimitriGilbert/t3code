import type { WatchGalleryTemplate } from "@t3tools/contracts";
import { LayoutTemplateIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";

/**
 * The starter-page gallery: one dialog of server-defined templates, each row
 * instantiating immediately on click — deletion is the undo path.
 */
export function WatchGalleryDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly templates: ReadonlyArray<WatchGalleryTemplate>;
  readonly onInstantiate: (template: WatchGalleryTemplate) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start from a template</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <DiscoveryList>
            {props.templates.map((template) => (
              <DiscoveryListRow
                key={template.id}
                icon={
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground">
                    <LayoutTemplateIcon className="size-4" />
                  </span>
                }
                title={template.name}
                description={template.description ?? "A starter watch page."}
                action={
                  <Badge size="sm" variant="secondary">
                    {template.widgets.length} widgets
                  </Badge>
                }
                onClick={() => props.onInstantiate(template)}
              />
            ))}
          </DiscoveryList>
          {props.templates.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No templates available.
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
