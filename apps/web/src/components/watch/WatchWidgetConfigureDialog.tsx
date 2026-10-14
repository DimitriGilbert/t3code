import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { watchWidgetDisplayTitle } from "@t3tools/client-runtime/state/watch-pages";
import type { WatchConnectorInstance, WatchWidget, WatchWidgetConfig } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

/** Sentinel for "no explicit binding" — the widget falls back to the page's ambient scope. */
const PAGE_DEFAULT_BINDING = "__page_default__";
const ALL_PROJECTS_BINDING = "*";
const NO_CONNECTOR_BINDING = "__none__";

function fieldRow(label: string, control: ReactNode) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {control}
    </div>
  );
}

/**
 * The Configure surface for a watch widget: edits the `source` binding only —
 * which project a `threads` source reads against, or which connector instance
 * a `connector` source subscribes to. Config writes carry the widget's own
 * revision, so they never collide with a concurrent layout drag.
 */
export function WatchWidgetConfigureDialog(props: {
  readonly widget: WatchWidget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly connectorInstances: ReadonlyArray<WatchConnectorInstance>;
  readonly onSave: (config: WatchWidgetConfig) => void;
}) {
  const source = props.widget.config.source;
  const [draftBinding, setDraftBinding] = useState<string>(
    () =>
      source?.binding ?? (source?.kind === "threads" ? PAGE_DEFAULT_BINDING : NO_CONNECTOR_BINDING),
  );
  const bindable = source?.kind === "threads" || source?.kind === "connector";
  const bindingLabel =
    source?.kind === "threads"
      ? draftBinding === PAGE_DEFAULT_BINDING
        ? "Page default"
        : draftBinding === ALL_PROJECTS_BINDING
          ? "All projects"
          : (props.projects.find((project) => project.id === draftBinding)?.title ?? draftBinding)
      : draftBinding === NO_CONNECTOR_BINDING
        ? "No connector"
        : (props.connectorInstances.find((instance) => instance.id === draftBinding)?.name ??
          draftBinding);

  const save = () => {
    if (!bindable || source === undefined) return;
    const binding =
      source.kind === "threads"
        ? draftBinding === PAGE_DEFAULT_BINDING
          ? undefined
          : draftBinding
        : draftBinding === NO_CONNECTOR_BINDING
          ? undefined
          : draftBinding;
    props.onSave({
      ...props.widget.config,
      source: {
        ...source,
        ...(binding === undefined ? {} : { binding }),
      },
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{watchWidgetDisplayTitle(props.widget)}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {source?.kind === "threads" ? (
            fieldRow(
              "Project",
              <Select
                value={draftBinding}
                onValueChange={(next) => {
                  if (typeof next === "string") setDraftBinding(next);
                }}
              >
                <SelectTrigger size="sm" aria-label="Project">
                  <SelectValue>{bindingLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={PAGE_DEFAULT_BINDING}>Page default</SelectItem>
                  <SelectItem value={ALL_PROJECTS_BINDING}>All projects</SelectItem>
                  {props.projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>,
            )
          ) : source?.kind === "connector" ? (
            fieldRow(
              "Connector",
              <Select
                value={draftBinding}
                onValueChange={(next) => {
                  if (typeof next === "string") setDraftBinding(next);
                }}
              >
                <SelectTrigger size="sm" aria-label="Connector">
                  <SelectValue>{bindingLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={NO_CONNECTOR_BINDING}>No connector</SelectItem>
                  {props.connectorInstances.map((instance) => (
                    <SelectItem key={instance.id} value={instance.id}>
                      {instance.name ?? instance.packId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>,
            )
          ) : (
            <p className="text-xs text-muted-foreground">
              This widget has no configurable options.
            </p>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          {bindable ? <Button onClick={save}>Save</Button> : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
