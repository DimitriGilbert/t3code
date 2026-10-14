import {
  WATCH_FIRST_PARTY_WIDGETS,
  type WatchFirstPartyWidgetSpec,
} from "@t3tools/client-runtime/state/watch-pages";
import { SquareActivityIcon, UnplugIcon } from "lucide-react";

import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";

const SECTION_LABELS: Record<WatchFirstPartyWidgetSpec["section"], string> = {
  threads: "Threads",
  connectors: "Connectors",
};

const SECTION_ICONS: Record<WatchFirstPartyWidgetSpec["section"], typeof SquareActivityIcon> = {
  threads: SquareActivityIcon,
  connectors: UnplugIcon,
};

/**
 * The add-widget picker: one dialog listing the first-party widget catalog,
 * grouped by data section. Pack-provided and agent-authored kinds join the
 * list in a later phase.
 */
export function WatchWidgetPickerDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (spec: WatchFirstPartyWidgetSpec) => void;
}) {
  const sections = (Object.keys(SECTION_LABELS) as Array<keyof typeof SECTION_LABELS>)
    .map((section) => ({
      section,
      widgets: WATCH_FIRST_PARTY_WIDGETS.filter((spec) => spec.section === section),
    }))
    .filter((group) => group.widgets.length > 0);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a widget</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {sections.map((group) => {
              const SectionIcon = SECTION_ICONS[group.section];
              return (
                <div key={group.section} className="flex flex-col gap-1.5">
                  <span className="px-1 text-xs font-medium text-muted-foreground">
                    {SECTION_LABELS[group.section]}
                  </span>
                  <DiscoveryList>
                    {group.widgets.map((spec) => (
                      <DiscoveryListRow
                        key={spec.kind}
                        icon={
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground">
                            <SectionIcon className="size-4" />
                          </span>
                        }
                        title={spec.title}
                        description={spec.description}
                        onClick={() => props.onPick(spec)}
                      />
                    ))}
                  </DiscoveryList>
                </div>
              );
            })}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
