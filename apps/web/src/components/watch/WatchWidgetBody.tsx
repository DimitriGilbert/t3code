import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  watchAgentSourceId,
  type WatchAppMountState,
} from "@t3tools/client-runtime/state/watch-mounts";
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
  WatchConnectorInstallRequest,
  WatchConnectorPack,
  WatchPackWidgetSource,
  WatchPage,
  WatchWidget,
  WatchWidgetConfig,
  WatchWidgetId,
  WatchWidgetSourceRecord,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { WatchAppWidget } from "./WatchAppWidget";
import { WatchActiveWorkWidget } from "./widgets/WatchActiveWorkWidget";
import { WatchConnectorStatusWidget } from "./widgets/WatchConnectorStatusWidget";
import { WatchNeedsAttentionWidget } from "./widgets/WatchNeedsAttentionWidget";
import { WatchRecentActivityWidget } from "./widgets/WatchRecentActivityWidget";
import { WatchTaskStarterWidget } from "./widgets/WatchTaskStarterWidget";
import { WatchWidgetErrorBody } from "./WatchWidgetErrorBody";
import { WatchWidgetSettingsForm } from "./WatchWidgetSettingsForm";

/**
 * The mount governance an `agent:<sourceId>` widget obeys — wired by the
 * board through {@link useWatchAppMounts}. Absent on paths that never mount
 * agent code (the archived read-only board is a plain render).
 */
export interface WatchAppMountControls {
  readonly stateOf: (widgetId: WatchWidgetId) => WatchAppMountState;
  readonly reportVisibility: (widgetId: WatchWidgetId, visible: boolean) => void;
  readonly requestMount: (widgetId: WatchWidgetId) => void;
}

/**
 * Wraps the configure form so a live `pagesLive` update can never leave it
 * submitting stale draft values under a fresh `expectedRevision`: the form
 * is keyed on `widget.revision`, so a remote config write remounts it
 * against the new base. The gate outlives the remount — it carries the
 * "changed elsewhere" notice, which the remounted form can't know about
 * since its predecessor's draft state died with it.
 */
function WatchWidgetConfigFormGate(props: {
  readonly widget: WatchWidget;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly connectorInstances: ReadonlyArray<WatchConnectorInstance>;
  /** Field key a `configMismatch` error names — forwarded to the form. */
  readonly invalidField?: string | undefined;
  readonly onSubmit: (config: WatchWidgetConfig) => void;
  readonly onCancel: () => void;
}) {
  const { widget } = props;
  // The revision the form opened against. Any later render carrying a
  // different revision means a write landed while the user was editing —
  // the keyed remount silently re-bases the draft, and this notice explains
  // why in-progress edits were replaced. A successful save from this client
  // also bumps the revision, but the screen closes the form on success, so
  // the notice is at most a render's worth of flash before unmount.
  const [openedRevision] = useState(widget.revision);
  const changedElsewhere = widget.revision !== openedRevision;
  return (
    <>
      {changedElsewhere ? (
        <p className="mb-2 shrink-0 text-2xs text-muted-foreground">
          This widget changed on another client — the form was reset to the latest values.
        </p>
      ) : null}
      <WatchWidgetSettingsForm
        key={widget.revision}
        widget={widget}
        projects={props.projects}
        connectorInstances={props.connectorInstances}
        invalidField={props.invalidField}
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
      />
    </>
  );
}

/**
 * Picks the live body for a widget, layered over the same degradation
 * contract for first-party and sandboxed kinds: `configure` swaps the body
 * for the generated settings form, then typed source errors (stale project
 * binding, missing/down connector) replace it entirely — a widget that
 * cannot show data must still be repointable. Agent kinds defer to
 * `WatchAppWidget`, which the mount registry's `WatchAppMountControls`
 * governs: offscreen bodies unmount, over-cap bodies get tap-to-load.
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
  /** Pack-registered widget sources — resolves `connectorMissing` for `pack:*` provenance. */
  readonly packWidgetSources: ReadonlyArray<WatchPackWidgetSource>;
  /** Mount governance for `agent:*` kinds; absent renders them unmounted. */
  readonly appMounts?: WatchAppMountControls;
  /**
   * Lifts the published source record an agent widget resolves, so the host
   * can offer "View source" from the widget context menu.
   */
  readonly onAppSourceRecord?: (
    widgetId: WatchWidgetId,
    record: WatchWidgetSourceRecord | null,
  ) => void;
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
  /** Pending install/upgrade requests — the connector-status widget lists them. */
  readonly installRequests: ReadonlyArray<WatchConnectorInstallRequest>;
  /** Opens the human-confirm dialog for a pending request. */
  readonly onReviewInstallRequest: (request: WatchConnectorInstallRequest) => void;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}): ReactNode {
  const { widget, page } = props;
  const spec = watchFirstPartyWidgetSpec(widget.kind);

  // Agent/pack kinds: the generated configure form handles the connector
  // binding (they have no declared settings fields); the live body is the
  // governed sandbox frame. While configuring or errored, the app body
  // unmounts entirely — its observer reports hidden and the mount seat frees.
  if (spec === undefined) {
    if (watchAgentSourceId(widget.kind) === undefined) return undefined;
    if (props.configuring && watchWidgetIsConfigurable(widget)) {
      return (
        <WatchWidgetConfigFormGate
          widget={widget}
          projects={props.projects}
          connectorInstances={props.connectorInstances}
          onSubmit={(config) => props.onConfigureSubmit(widget, config)}
          onCancel={props.onConfigureClose}
        />
      );
    }
    if (props.appMounts === undefined) return undefined;
    return (
      <WatchAppWidget
        environmentId={props.environmentId}
        widget={widget}
        packWidgetSources={props.packWidgetSources}
        mountState={props.appMounts.stateOf(widget.id)}
        onVisibilityChange={(visible) => props.appMounts?.reportVisibility(widget.id, visible)}
        onRequestLoad={() => props.appMounts?.requestMount(widget.id)}
        onSourceRecord={(record) => props.onAppSourceRecord?.(widget.id, record)}
      />
    );
  }

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
      <WatchWidgetConfigFormGate
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
          installRequests={props.installRequests}
          connectorsReady={props.connectorsReady}
          connectorsError={props.connectorsError}
          onReviewInstallRequest={props.onReviewInstallRequest}
        />
      );
    default:
      return undefined;
  }
}
