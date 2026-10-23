import { useAtomValue } from "@effect/atom-react";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  WATCH_GRID_ROW_UNIT_REM,
  watchWidgetDisplayTitle,
} from "@t3tools/client-runtime/state/watch-pages";
import { useAtomCommand } from "../../state/use-atom-command";
import { watchEnvironment } from "../../state/watch";

import { WatchAppWebView } from "./WatchAppWebView";

/**
 * The mobile twin of web's `WatchAppWidget`: one `agent:<sourceId>` body —
 * mount-governed by the page registry, artifact resolved through the source
 * stream plus one bundle fetch per `artifactHash`, and rendered through
 * `WatchAppWebView`, the mobile half of the sandbox contract. Visibility is
 * reported on mount/unmount (no IntersectionObserver on native); the registry
 * still caps mounted frames and demotes the rest to tap-to-load.
 */

const isConnectorInstanceId = Schema.is(WatchConnectorInstanceIdSchema);

/** The widget row's configured connector instance — the only one its bridge may reach. */
function widgetConnectorInstance(widget: WatchWidget): WatchConnectorInstanceId | undefined {
  const source = widget.config.source;
  if (source?.kind !== "connector" || source.binding === undefined) return undefined;
  return isConnectorInstanceId(source.binding) ? source.binding : undefined;
}

/** Desktop rows are 4rem grid units; clamped so a tall card stays a card. */
function mobileWidgetHeight(widget: WatchWidget): number {
  return Math.min(Math.max(widget.placement.h * WATCH_GRID_ROW_UNIT_REM * 16, 180), 520);
}

function WatchAppEmptyState(props: {
  readonly title: string;
  readonly description?: string;
  readonly icon?: "exclamationmark.triangle" | "wifi.slash";
}) {
  return (
    <View className="items-center justify-center gap-1 px-4 py-6">
      <SymbolView
        name={props.icon ?? "exclamationmark.triangle"}
        size={18}
        tintColorClassName="accent-icon-muted"
      />
      <Text className="text-sm font-t3-medium text-foreground">{props.title}</Text>
      {props.description === undefined ? null : (
        <Text className="text-center text-xs text-foreground-muted">{props.description}</Text>
      )}
    </View>
  );
}

export function WatchAppWidget(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  /** Pack registrations from `connectorsLive` — decides `connectorMissing` for `pack:*` widgets. */
  readonly packWidgetSources: ReadonlyArray<WatchPackWidgetSource>;
  /** Governance state from the page's mount registry; unmounted widgets render nothing. */
  readonly mountState: WatchAppMountState;
  /** Mounted-section visibility report — the registry turns it into mount changes. */
  readonly onVisibilityChange: (visible: boolean) => void;
  /** The "tap to load" tap; the registry re-seats this widget on mount. */
  readonly onRequestLoad: () => void;
}) {
  const { widget } = props;
  const sourceId = watchAgentSourceId(widget.kind);
  const [violation, setViolation] = useState<string | null>(null);

  // A mounted section is on screen; an unmounted one must release its seat.
  // The caller hands a fresh closure per render, so the latest callback goes
  // through a ref and the report itself fires exactly once on mount/unmount
  // (the widget instance is keyed by id in the parent stack).
  const visibilityRef = useRef(props.onVisibilityChange);
  useEffect(() => {
    visibilityRef.current = props.onVisibilityChange;
  }, [props.onVisibilityChange]);
  useEffect(() => {
    visibilityRef.current(true);
    return () => visibilityRef.current(false);
  }, []);

  const body = (() => {
    if (props.mountState === "unmounted") return null;
    if (props.mountState === "placeholder") {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load widget"
          onPress={props.onRequestLoad}
          className="items-center justify-center px-4 py-6"
        >
          <Text className="text-sm font-t3-medium text-primary">Tap to load widget</Text>
        </Pressable>
      );
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
      return <WatchAppEmptyState title="Connector missing" icon="wifi.slash" />;
    }
    return (
      <WatchAppArtifactBody
        environmentId={props.environmentId}
        widget={widget}
        sourceId={sourceId}
        onViolation={setViolation}
      />
    );
  })();

  return (
    <View>
      {body}
      {violation === null ? null : (
        <View className="absolute right-2 top-2 flex-row items-center gap-1 rounded-md bg-card px-1.5 py-0.5">
          <SymbolView
            name="exclamationmark.triangle"
            size={12}
            tintColorClassName="accent-danger-foreground"
          />
          <Text className="text-2xs text-danger-foreground">Widget error</Text>
        </View>
      )}
    </View>
  );
}

/**
 * The artifact path once mounted: the record stream drives readiness, one
 * bundle fetch follows each `artifactHash`, and the WebView mounts only for a
 * `ready` artifact.
 */
function WatchAppArtifactBody(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly sourceId: NonNullable<ReturnType<typeof watchAgentSourceId>>;
  readonly onViolation: (message: string) => void;
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

  if (state._tag === "pending") {
    return (
      <View className="items-center justify-center py-8">
        <ActivityIndicator />
      </View>
    );
  }
  if (state._tag === "missing") {
    return <WatchAppEmptyState title="Widget unpublished" />;
  }
  if (state._tag === "failed") {
    const description = state.record.failure?.detail ?? failureDetail ?? undefined;
    return (
      <WatchAppEmptyState
        title="Widget failed to build"
        {...(description === undefined ? {} : { description })}
      />
    );
  }

  const boundInstance = widgetConnectorInstance(props.widget);
  return (
    <View style={{ height: mobileWidgetHeight(props.widget) }}>
      <WatchAppWebView
        environmentId={props.environmentId}
        widgetId={props.widget.id}
        manifest={state.record.manifest}
        bundle={state.bundle}
        scriptHash={state.scriptHash}
        {...(boundInstance === undefined ? {} : { connectorInstanceId: boundInstance })}
        {...(props.widget.config.source?.refreshPolicy === undefined
          ? {}
          : { refreshPolicy: props.widget.config.source.refreshPolicy })}
        onViolation={onViolation}
        title={watchWidgetDisplayTitle(props.widget)}
      />
    </View>
  );
}
