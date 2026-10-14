import type {
  EnvironmentId,
  WatchConnectorInstanceId,
  WatchPackWidgetSource,
  WatchWidget,
  WatchWidgetSourceRecord,
} from "@t3tools/contracts";
import { WatchConnectorInstanceId as WatchConnectorInstanceIdSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  isMissingPackWidgetKind,
  watchAgentSourceId,
  type WatchAppMountState,
} from "@t3tools/client-runtime/state/watch-mounts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  resolveWatchAppArtifact,
  type WatchAppBridgeViolation,
} from "@t3tools/client-runtime/watch-app-bridge";
import { useAtomValue } from "@effect/atom-react";
import { CodeIcon, EllipsisIcon, Trash2Icon, TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { watchEnvironment } from "~/state/watch";

import { WatchAppFrame, type WatchAppActionHandler } from "./WatchAppFrame";
import { WatchAppSourceDialog } from "./WatchAppSourceDialog";
import { WatchAppTapToLoad } from "./WatchAppTapToLoad";
import { WatchProvenanceMarker } from "./WatchProvenanceMarker";

/**
 * The host-owned chrome and artifact path around one `agent:<sourceId>`
 * widget. The provenance marker plus the "View source" / "Remove" affordances
 * render outside the sandbox — widget content can neither fake nor suppress
 * them — and they stay mounted across widget errors. Both affordances live in
 * the chrome's context menu, not as always-visible icons, matching the watch
 * board's density. The artifact itself resolves through the source stream
 * (the record) plus one bundle fetch per `artifactHash`; the frame mounts
 * only for a `ready` artifact.
 */

const isConnectorInstanceId = Schema.is(WatchConnectorInstanceIdSchema);

/** The widget row's configured connector instance — the only one its bridge may reach. */
function widgetConnectorInstance(widget: WatchWidget): WatchConnectorInstanceId | undefined {
  const source = widget.config.source;
  if (source?.kind !== "connector" || source.binding === undefined) return undefined;
  return isConnectorInstanceId(source.binding) ? source.binding : undefined;
}

function WatchAppEmptyState(props: {
  readonly title: string;
  readonly description?: string;
  readonly icon?: typeof TriangleAlertIcon;
}) {
  const Icon = props.icon ?? TriangleAlertIcon;
  return (
    <Empty size="compact" className="min-h-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description === undefined ? null : (
          <EmptyDescription>{props.description}</EmptyDescription>
        )}
      </EmptyHeader>
    </Empty>
  );
}

export function WatchAppWidget(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  /** Pack registrations from `connectorsLive` — decides `connectorMissing` for `pack:*` widgets. */
  readonly packWidgetSources: ReadonlyArray<WatchPackWidgetSource>;
  /** Governance state from the page's mount registry; offscreen widgets render nothing. */
  readonly mountState: WatchAppMountState;
  /** The "tap to load" tap; the registry re-seats this widget on mount. */
  readonly onRequestLoad: () => void;
  /** Host-owned remove affordance; when absent the menu entry is hidden. */
  readonly onRemove?: () => void;
  /** Declared actions the host implements; undeclared names never reach it. */
  readonly actions?: Readonly<Record<string, WatchAppActionHandler>>;
  readonly hostContext?: () => Record<string, unknown>;
  readonly className?: string;
}) {
  const { widget } = props;
  const sourceId = watchAgentSourceId(widget.kind);
  const [violation, setViolation] = useState<string | null>(null);
  const [sourceRecord, setSourceRecord] = useState<WatchWidgetSourceRecord | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);

  const body = (() => {
    if (props.mountState === "unmounted") return null;
    if (props.mountState === "placeholder") {
      return <WatchAppTapToLoad onLoad={props.onRequestLoad} />;
    }
    if (sourceId === undefined) {
      // Not an agent kind — this shell only hosts published artifacts.
      return <WatchAppEmptyState title="Unknown widget" />;
    }
    if (
      isMissingPackWidgetKind({
        kind: widget.kind,
        provenance: widget.provenance,
        widgetSources: props.packWidgetSources,
      })
    ) {
      return <WatchAppEmptyState title="Connector missing" icon={UnplugIcon} />;
    }
    return (
      <WatchAppArtifactBody
        environmentId={props.environmentId}
        widget={widget}
        sourceId={sourceId}
        onViolation={setViolation}
        onRecord={setSourceRecord}
        {...(props.actions === undefined ? {} : { actions: props.actions })}
        {...(props.hostContext === undefined ? {} : { hostContext: props.hostContext })}
      />
    );
  })();

  return (
    <div className={cn("relative flex size-full flex-col overflow-hidden", props.className)}>
      <div className="flex h-7 shrink-0 items-center gap-1 px-1.5">
        <WatchProvenanceMarker provenance={widget.provenance} />
        <div className="flex-1" />
        {violation === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex items-center gap-1 text-destructive">
                  <TriangleAlertIcon className="size-3" />
                  <span className="text-xs">Widget error</span>
                </span>
              }
            />
            <TooltipPopup>{violation}</TooltipPopup>
          </Tooltip>
        )}
        {props.onRemove === undefined && sourceRecord === null ? null : (
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="icon-micro" aria-label="Widget options" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {sourceRecord === null ? null : (
                <MenuItem onClick={() => setSourceOpen(true)}>
                  <CodeIcon />
                  View source
                </MenuItem>
              )}
              {props.onRemove === undefined ? null : (
                <MenuItem variant="destructive" onClick={props.onRemove}>
                  <Trash2Icon />
                  Remove
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        )}
      </div>
      <div className="relative min-h-0 flex-1">{body}</div>
      {sourceRecord === null ? null : (
        <WatchAppSourceDialog
          record={sourceRecord}
          open={sourceOpen}
          onOpenChange={setSourceOpen}
        />
      )}
    </div>
  );
}

/**
 * The artifact path once mounted: the record stream drives readiness, one
 * bundle fetch follows each `artifactHash`, and the frame mounts only for a
 * `ready` artifact. The resolved record is reported up so the host chrome can
 * offer "View source" — including for `failed` builds, where its diagnostics
 * matter most.
 */
function WatchAppArtifactBody(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly sourceId: NonNullable<ReturnType<typeof watchAgentSourceId>>;
  readonly onViolation: (message: string) => void;
  readonly onRecord: (record: WatchWidgetSourceRecord | null) => void;
  readonly actions?: Readonly<Record<string, WatchAppActionHandler>>;
  readonly hostContext?: () => Record<string, unknown>;
}) {
  const recordResult = useAtomValue(
    watchEnvironment.widgetSourceLive({
      environmentId: props.environmentId,
      input: { sourceId: props.sourceId },
    }),
  );
  // `undefined` while the stream is still loading; `null` = nothing published.
  const record: WatchWidgetSourceRecord | null | undefined =
    recordResult._tag === "Success" ? recordResult.value : undefined;

  const onRecord = props.onRecord;
  useEffect(() => {
    onRecord(record === undefined ? null : record);
  }, [onRecord, record]);

  const getSource = useAtomCommand(watchEnvironment.getWidgetSource, {
    reportFailure: false,
  });
  const [artifact, setArtifact] = useState<{
    readonly artifactHash: string;
    readonly bundle: string | null;
  } | null>(null);

  const artifactHash = record?.status === "ready" ? record.artifactHash : null;
  useEffect(() => {
    if (artifactHash === null) return;
    let cancelled = false;
    // A stale artifact is ignored at resolve time — its hash no longer matches.
    void getSource({
      environmentId: props.environmentId,
      input: { sourceId: props.sourceId },
    }).then((result) => {
      if (cancelled) return;
      setArtifact({
        artifactHash,
        bundle:
          result._tag === "Success" && result.value.source?.artifactHash === artifactHash
            ? result.value.bundle
            : null,
      });
    });
    return () => {
      cancelled = true;
    };
    // The command and environment are stable; the artifact hash is the refetch key.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [artifactHash, props.sourceId]);

  const state = useMemo(
    () =>
      resolveWatchAppArtifact(
        record,
        artifact !== null && artifact.artifactHash === artifactHash ? artifact.bundle : undefined,
      ),
    [record, artifact, artifactHash],
  );

  const failureDetail = useMemo(() => {
    if (recordResult._tag !== "Failure") return null;
    const error = squashAtomCommandFailure(recordResult);
    return error instanceof Error && error.message.trim() !== "" ? error.message : null;
  }, [recordResult]);

  const onViolation = (violation: WatchAppBridgeViolation) => props.onViolation(violation.message);

  const failureDescription =
    state._tag === "failed"
      ? (state.record.failure?.detail ?? failureDetail ?? undefined)
      : undefined;
  const boundInstance = widgetConnectorInstance(props.widget);

  if (state._tag === "pending") {
    return <Skeleton className="m-2 h-[calc(100%-1rem)]" />;
  }
  if (state._tag === "missing") {
    return <WatchAppEmptyState title="Widget unpublished" />;
  }
  if (state._tag === "failed") {
    return (
      <WatchAppEmptyState
        title="Widget failed to build"
        {...(failureDescription === undefined ? {} : { description: failureDescription })}
      />
    );
  }
  return (
    <WatchAppFrame
      environmentId={props.environmentId}
      widgetId={props.widget.id}
      manifest={state.record.manifest}
      bundle={state.bundle}
      scriptHash={state.scriptHash}
      {...(boundInstance === undefined ? {} : { connectorInstanceId: boundInstance })}
      {...(props.widget.config.source?.refreshPolicy === undefined
        ? {}
        : { refreshPolicy: props.widget.config.source.refreshPolicy })}
      {...(props.actions === undefined ? {} : { actions: props.actions })}
      {...(props.hostContext === undefined ? {} : { hostContext: props.hostContext })}
      onViolation={onViolation}
    />
  );
}
