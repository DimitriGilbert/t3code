import {
  WATCH_FIRST_PARTY_WIDGETS,
  type WatchFirstPartyWidgetSpec,
} from "@t3tools/client-runtime/state/watch-pages";
import type { WatchPackWidgetSource } from "@t3tools/contracts";
import { FileJsonIcon, PackageIcon, SquareActivityIcon, UnplugIcon } from "lucide-react";

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
 * The add-widget picker: one dialog listing the first-party widget catalog
 * grouped by data section, plus a "Connector packs" section for the widget
 * sources installed packs registered. Pack sources appear only while their
 * pack is installed — the list is capability-filtered, not historical.
 */
export function WatchWidgetPickerDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (spec: WatchFirstPartyWidgetSpec) => void;
  /** Live (non-archived) pack-registered widget sources, from `connectorsLive`. */
  readonly packSources?: ReadonlyArray<WatchPackWidgetSource>;
  readonly onPickPackSource?: (source: WatchPackWidgetSource) => void;
  /** Opens the widget import dialog — import lives under "Add a widget". */
  readonly onImport?: () => void;
}) {
  const sections = (Object.keys(SECTION_LABELS) as Array<keyof typeof SECTION_LABELS>)
    .map((section) => ({
      section,
      widgets: WATCH_FIRST_PARTY_WIDGETS.filter((spec) => spec.section === section),
    }))
    .filter((group) => group.widgets.length > 0);
  const packSources = (props.packSources ?? []).filter((source) => source.archivedAt === null);

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
            {packSources.length === 0 || props.onPickPackSource === undefined ? null : (
              <div className="flex flex-col gap-1.5">
                <span className="px-1 text-xs font-medium text-muted-foreground">
                  Connector packs
                </span>
                <DiscoveryList>
                  {packSources.map((source) => (
                    <DiscoveryListRow
                      key={source.sourceId}
                      icon={
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground">
                          <PackageIcon className="size-4" />
                        </span>
                      }
                      title={source.name}
                      description={`Pack ${source.packId} · v${source.schemaVersion}`}
                      onClick={() => props.onPickPackSource?.(source)}
                    />
                  ))}
                </DiscoveryList>
              </div>
            )}
            {props.onImport === undefined ? null : (
              <>
                <div className="flex items-center gap-3" aria-hidden>
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-muted-foreground text-2xs uppercase tracking-wider">
                    or import
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <DiscoveryList>
                  <DiscoveryListRow
                    icon={
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground">
                        <FileJsonIcon className="size-4" />
                      </span>
                    }
                    title="Import a widget"
                    description="From a t3-widget .json export shared from another page or server."
                    onClick={props.onImport}
                  />
                </DiscoveryList>
              </>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
