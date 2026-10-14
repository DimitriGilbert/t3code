import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  resolveWatchThreadsProjectBinding,
  watchFirstPartyWidgetSpec,
  watchWidgetIsConfigurable,
} from "@t3tools/client-runtime/state/watch-pages";
import {
  resolveWatchConnectorSourceError,
  resolveWatchThreadsProjectError,
  type WatchWidgetErrorActionId,
} from "@t3tools/client-runtime/state/watch-widgets";
import { ProjectId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProvider,
  TimestampFormat,
  WatchConnectorInstance,
  WatchConnectorPack,
  WatchPage,
  WatchWidget,
  WatchWidgetConfig,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { WatchActiveWorkWidget } from "./widgets/WatchActiveWorkWidget";
import { WatchConnectorStatusWidget } from "./widgets/WatchConnectorStatusWidget";
import { WatchNeedsAttentionWidget } from "./widgets/WatchNeedsAttentionWidget";
import { WatchRecentActivityWidget } from "./widgets/WatchRecentActivityWidget";
import { WatchTaskStarterWidget } from "./widgets/WatchTaskStarterWidget";
import { WatchWidgetErrorBody } from "./WatchWidgetErrorBody";
import { WatchWidgetSettingsForm } from "./WatchWidgetSettingsForm";

/**
 * Picks the live body for a first-party widget, layered over the same
 * degradation contract the sandboxed kinds get: `configure` swaps the body
 * for the generated settings form, then typed source errors (stale project
 * binding, missing/down connector) replace it entirely — a widget that
 * cannot show data must still be repointable.
 * Non-first-party kinds (`agent:*`, `pack:*`) return undefined so the shell
 * keeps its placeholder until the frame mount lands.
 */
export function WatchWidgetBody(props: {
  readonly environmentId: EnvironmentId;
  readonly page: WatchPage;
  readonly widget: WatchWidget;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly snoozeSupported: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly connectorInstances: ReadonlyArray<WatchConnectorInstance>;
  readonly connectorPacks: ReadonlyArray<WatchConnectorPack>;
  /**
   * True once the connectors query has produced data. Until then a connector
   * binding's health is unknown, so source errors stay silent — resolving
   * against an empty list would flash `connectorMissing` on every mount.
   */
  readonly connectorsReady: boolean;
  /** Settled connectors-query failure text, shown by the status widget. */
  readonly connectorsError: string | null;
  /** The widget is in its configure state — the body swaps to the form. */
  readonly configuring: boolean;
  readonly onConfigureSubmit: (widget: WatchWidget, config: WatchWidgetConfig) => void;
  /** Opens the in-place configure form; absent on the read-only archived path. */
  readonly onConfigureOpen?: ((widget: WatchWidget) => void) | undefined;
  readonly onConfigureClose: () => void;
  /** Re-send a bound connector instance's config (restarts its poller). */
  readonly onReconnectConnector: (instance: WatchConnectorInstance) => void;
  /** Open the secret dialog for a bound connector instance. */
  readonly onUpdateConnectorSecret: (instance: WatchConnectorInstance) => void;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}): ReactNode {
  const { widget, page } = props;
  const spec = watchFirstPartyWidgetSpec(widget.kind);
  if (spec === undefined) return undefined;

  const boundProject = resolveWatchThreadsProjectBinding(page, widget);
  const boundProjectId = boundProject === null ? null : ProjectId.make(boundProject);
  const sourceError =
    resolveWatchThreadsProjectError(page, widget, props.projects) ??
    (props.connectorsReady
      ? resolveWatchConnectorSourceError(widget, props.connectorInstances)
      : null);
  const source = widget.config.source;
  const boundInstance =
    source?.kind === "connector" && source.binding !== undefined
      ? (props.connectorInstances.find((instance) => instance.id === source.binding) ?? null)
      : null;

  if (props.configuring && watchWidgetIsConfigurable(widget)) {
    return (
      <WatchWidgetSettingsForm
        widget={widget}
        projects={props.projects}
        connectorInstances={props.connectorInstances}
        invalidField={sourceError?.cause === "configMismatch" ? sourceError.field : undefined}
        onSubmit={(config) => props.onConfigureSubmit(widget, config)}
        onCancel={props.onConfigureClose}
      />
    );
  }

  if (sourceError !== null) {
    // Recovery actions that cannot run here are hidden, not dead: the
    // configure-family actions need `onConfigureOpen` (absent on the
    // read-only archived path) and the instance actions need a live binding.
    const hiddenActions: WatchWidgetErrorActionId[] = [];
    if (boundInstance === null) hiddenActions.push("reconnect", "update-secret");
    if (props.onConfigureOpen === undefined) {
      hiddenActions.push("configure", "repoint", "view-source", "remove");
    }
    return (
      <WatchWidgetErrorBody
        error={sourceError}
        timestampFormat={props.timestampFormat}
        hiddenActions={hiddenActions}
        // The read-only archived path passes no configure opener; recovery
        // mutations stay off there entirely.
        onAction={
          props.onConfigureOpen === undefined
            ? undefined
            : (action: WatchWidgetErrorActionId) => {
                const onConfigureOpen = props.onConfigureOpen;
                switch (action) {
                  case "reconnect":
                    if (boundInstance !== null) props.onReconnectConnector(boundInstance);
                    return;
                  case "update-secret":
                    if (boundInstance !== null) props.onUpdateConnectorSecret(boundInstance);
                    return;
                  // "repoint"/"configure" both land on the in-place form;
                  // "view-source"/"remove" belong to pack/agent kinds.
                  default:
                    onConfigureOpen?.(widget);
                }
              }
        }
      />
    );
  }

  const threadScope = {
    threads: props.threads,
    projectId: boundProjectId,
    projectTitleById: new Map(props.projects.map((project) => [project.id, project.title])),
    showProjectBadge: boundProjectId === null,
    onOpenThread: props.onOpenThread,
  } as const;

  switch (widget.kind) {
    case "active-work":
      return (
        <WatchActiveWorkWidget
          environmentId={props.environmentId}
          widget={widget}
          {...threadScope}
        />
      );
    case "needs-attention":
      return (
        <WatchNeedsAttentionWidget
          environmentId={props.environmentId}
          widget={widget}
          snoozeSupported={props.snoozeSupported}
          {...threadScope}
        />
      );
    case "task-starter":
      return (
        <WatchTaskStarterWidget
          environmentId={props.environmentId}
          widget={widget}
          projects={props.projects}
          providers={props.providers}
          threads={props.threads}
          projectId={boundProjectId}
          onOpenThread={props.onOpenThread}
        />
      );
    case "recent-activity":
      return (
        <WatchRecentActivityWidget
          environmentId={props.environmentId}
          widget={widget}
          {...threadScope}
        />
      );
    case "connector-status":
      return (
        <WatchConnectorStatusWidget
          environmentId={props.environmentId}
          widget={widget}
          instances={props.connectorInstances}
          packs={props.connectorPacks}
          timestampFormat={props.timestampFormat}
          connectorsReady={props.connectorsReady}
          connectorsError={props.connectorsError}
        />
      );
    default:
      return undefined;
  }
}
