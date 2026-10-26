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
import type {
  EnvironmentId,
  WatchConnectorInstanceId,
  WatchPackWidgetSource,
  WatchWidget,
  WatchWidgetSourceRecord,
} from "@t3tools/contracts";
import { WatchConnectorInstanceId as WatchConnectorInstanceIdSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import { TriangleAlertIcon, UnplugIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { watchEnvironment } from "~/state/watch";

import { WatchAppFrame, type WatchAppActionHandler } from "./WatchAppFrame";
import { WatchAppTapToLoad } from "./WatchAppTapToLoad";

/**
 * The body of one `agent:<sourceId>` widget, embedded inside `WatchWidgetShell`.
 * The shell owns the chrome — title, provenance badge, context menu — so this
 * component renders only the governed content region: an
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
  /** IntersectionObserver report — the registry turns it into mount changes. */
  readonly onVisibilityChange: (visible: boolean) => void;
  /** The "tap to load" tap; the registry re-seats this widget on mount. */
  readonly onRequestLoad: () => void;
  /**
   * The resolved source record (or null while unresolved/gone), lifted so the
   * shell context menu can offer "View source".
   */
  readonly onSourceRecord: (record: WatchWidgetSourceRecord | null) => void;
  /** Declared actions the host implements; undeclared names never reach it. */
  readonly actions?: Readonly<Record<string, WatchAppActionHandler>>;
  readonly hostContext?: () => Record<string, unknown>;
  readonly className?: string;
}) {
  const { widget } = props;
  const sourceId = watchAgentSourceId(widget.kind);
  const [violation, setViolation] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The caller hands a fresh closure every render; subscribing the observer
  // to it directly would teardown-and-hide on every render, an oscillation.
  // The ref syncs ahead of the observer effect, which re-runs only when the
  // widget identity changes.
  const onVisibilityChangeRef = useRef(props.onVisibilityChange);
  useEffect(() => {
    onVisibilityChangeRef.current = props.onVisibilityChange;
  });

  // Visibility reporting lives on this filling wrapper: the shell's content
  // region gives it a real box even while the body renders nothing, so the
  // registry hears every enter/leave regardless of mount state. Cleanup
  // reports hidden — an unmounted widget must not hold a mount seat.
  useEffect(() => {
    const element = rootRef.current;
    if (element === null) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        onVisibilityChangeRef.current(entry.isIntersecting);
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      onVisibilityChangeRef.current(false);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one mount per widget.id; the registry call is keyed on identity only
  }, [widget.id]);

  const body = (() => {
    if (props.mountState === "unmounted") return null;
    if (props.mountState === "placeholder") {
      return <WatchAppTapToLoad onLoad={props.onRequestLoad} />;
    }
    if (sourceId === undefined) {
      // Not an agent kind — this body only hosts published artifacts.
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
        onRecord={props.onSourceRecord}
        {...(props.actions === undefined ? {} : { actions: props.actions })}
        {...(props.hostContext === undefined ? {} : { hostContext: props.hostContext })}
      />
    );
  })();

  return (
    <div
      ref={rootRef}
      className={cn("relative flex min-h-0 w-full flex-1 flex-col", props.className)}
    >
      <div className="relative min-h-0 flex-1">{body}</div>
      {violation === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="absolute top-1 right-1 z-10 inline-flex items-center gap-1 rounded-sm bg-card/90 px-1.5 py-0.5 text-destructive shadow-xs/5">
                <TriangleAlertIcon className="size-3" />
                <span className="text-2xs">Widget error</span>
              </span>
            }
          />
          <TooltipPopup>{violation}</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * The artifact path once mounted: the record stream drives readiness, one
 * bundle fetch follows each `artifactHash`, and the frame mounts only for a
 * `ready` artifact. The resolved record is reported up so the host chrome can
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

  // Same fresh-closure hazard as the visibility observer: the caller's prop
  // changes identity every render, so the ref carries it and the effect keys
  // on the record alone — a re-render must not clear-and-re-report.
  const onRecordRef = useRef(props.onRecord);
  useEffect(() => {
    onRecordRef.current = props.onRecord;
  });
  useEffect(() => {
    onRecordRef.current(record === undefined ? null : record);
    // Unmounting (evicted, removed, or a later failed resolution) clears the
    // record so the host menu never offers a stale "View source".
    return () => onRecordRef.current(null);
  }, [record]);

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

  const state = resolveWatchAppArtifact(
    record,
    artifact !== null && artifact.artifactHash === artifactHash ? artifact.bundle : undefined,
  );

  const failureDetail = (() => {
    if (recordResult._tag !== "Failure") return null;
    const error = squashAtomCommandFailure(recordResult);
    return error instanceof Error && error.message.trim() !== "" ? error.message : null;
  })();

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
