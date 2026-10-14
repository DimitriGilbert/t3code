import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { watchConnectorOriginLabel } from "@t3tools/client-runtime/state/watch-connectors";
import { watchConnectorHealthErrorState } from "@t3tools/client-runtime/state/watch-widgets";
import type {
  EnvironmentId,
  WatchConnectorInstance,
  WatchConnectorInstallRequest,
  WatchConnectorPack,
  WatchWidget,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  CircleAlertIcon,
  EllipsisIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { readLocalApi } from "~/localApi";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { watchEnvironment } from "~/state/watch";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { WatchConnectorConfigDialog } from "./WatchConnectorConfigDialog";
import { WatchConnectorSecretDialog } from "./WatchConnectorSecretDialog";
import { WatchWidgetEmpty, WatchWidgetRows } from "./shared";

const HEALTH_BADGE: Record<
  WatchConnectorInstance["health"]["status"],
  { readonly label: string; readonly variant: "success" | "error" | "warning" | "outline" }
> = {
  healthy: { label: "Healthy", variant: "success" },
  unhealthy: { label: "Down", variant: "error" },
  authExpired: { label: "Auth expired", variant: "error" },
  unknown: { label: "Unknown", variant: "outline" },
};

/**
 * One pending install/upgrade — origin plus the kind badge, and a Review
 * button that opens the human-confirm dialog. Requests render above the
 * instance rows: an unattended request is the most actionable thing here.
 */
function PendingRequestRow(props: {
  readonly request: WatchConnectorInstallRequest;
  readonly onReview: (request: WatchConnectorInstallRequest) => void;
}) {
  const { request } = props;
  return (
    <div className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
      <CircleAlertIcon className="size-3.5 shrink-0 text-warning-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {request.packId ?? watchConnectorOriginLabel(request.origin)}
      </span>
      {request.localUrl ? (
        <Badge size="sm" variant="warning">
          local URL
        </Badge>
      ) : null}
      <Badge size="sm" variant="outline">
        {request.kind === "install" ? "Install" : "Upgrade"}
      </Badge>
      <Button variant="outline" size="xs" onClick={() => props.onReview(request)}>
        Review
      </Button>
    </div>
  );
}

function ConnectorRow(props: {
  readonly environmentId: EnvironmentId;
  readonly instance: WatchConnectorInstance;
  /** Every approved pack row for this instance's pack — the rollback targets. */
  readonly versions: ReadonlyArray<WatchConnectorPack>;
}) {
  const { instance } = props;
  const setInstanceConfig = useOrchestrationCommand(watchEnvironment.setConnectorInstanceConfig, {
    reportFailure: false,
  });
  const rollbackConnector = useOrchestrationCommand(watchEnvironment.rollbackConnector, {
    reportFailure: false,
  });
  const uninstallConnector = useOrchestrationCommand(watchEnvironment.uninstallConnector, {
    reportFailure: false,
  });
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // The manifest that speaks for the pinned version; absent rows fall back to
  // any known version so the secret badges still render.
  const pack =
    props.versions.find((version) => version.schemaVersion === instance.schemaVersion) ??
    props.versions[0];
  const rollbackTargets = props.versions.filter(
    (version) => version.schemaVersion !== instance.schemaVersion,
  );

  const health = instance.health;
  const presentation = HEALTH_BADGE[health.status];
  const error = watchConnectorHealthErrorState(instance);
  const declaredSecrets = pack?.manifest.secretKeys ?? [];
  const missingSecrets = declaredSecrets.filter(
    (key) => !instance.configuredSecretKeys.includes(key),
  );
  const lastFetch =
    health.lastFetchAt === null ? "never fetched" : formatRelativeTimeLabel(health.lastFetchAt);
  const rollback = health.lastRollback;

  const reportFailure = (result: AtomCommandResult<unknown, unknown>, title: string) => {
    if (AsyncResult.isSuccess(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: failure instanceof Error ? failure.message : "The connector request failed.",
    });
  };

  const run = async (
    intent: "reconnect" | "secrets" | "config",
    config = instance.config,
    secrets?: Record<string, string>,
  ) => {
    setBusy(true);
    try {
      // Re-sending config bumps updatedAt; the poller restarts and fetches.
      const result = await setInstanceConfig({
        environmentId: props.environmentId,
        input: {
          instanceId: instance.id,
          config,
          ...(secrets === undefined ? {} : { secrets }),
        },
      });
      reportFailure(
        result,
        intent === "secrets"
          ? "Could not update secrets"
          : intent === "config"
            ? "Could not save config"
            : "Could not reconnect",
      );
    } finally {
      setBusy(false);
    }
  };

  // Rollback re-pins to an already-approved version — no fetch, no new code.
  const runRollback = (schemaVersion: number) => {
    void rollbackConnector({
      environmentId: props.environmentId,
      input: { instanceId: instance.id, schemaVersion },
    }).then((result) => reportFailure(result, "Could not roll back"));
  };

  // Uninstall is pack-level and soft: it archives the pack and every instance
  // (polling stops, bound widgets degrade to placeholders) while config and
  // secrets stay on disk — the confirm says so before the write.
  const runUninstall = () => {
    void readLocalApi()
      ?.dialogs.confirm(
        `Uninstall "${instance.name ?? instance.packId}"?\nPolling stops and bound widgets degrade to placeholders. Config and secrets are retained.`,
        { variant: "destructive" },
      )
      .then((confirmed) => {
        if (!confirmed) return;
        void uninstallConnector({
          environmentId: props.environmentId,
          input: { packId: instance.packId },
        }).then((result) => reportFailure(result, "Could not uninstall"));
      });
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-1 rounded-md px-1.5 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {instance.name ?? instance.packId}
        </span>
        <Badge size="sm" variant={presentation.variant}>
          {presentation.label}
        </Badge>
        {missingSecrets.length > 0 || declaredSecrets.length === 0 ? null : (
          <Badge size="sm" variant="outline">
            <KeyRoundIcon className="size-2.5" />
            {instance.configuredSecretKeys.length}/{declaredSecrets.length}
          </Badge>
        )}
        {missingSecrets.length > 0 ? (
          <Badge size="sm" variant="warning">
            <KeyRoundIcon className="size-2.5" />
            Missing secrets
          </Badge>
        ) : null}
        {declaredSecrets.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  aria-label={`Update secrets for ${instance.name ?? instance.packId}`}
                  onClick={() => setSecretsOpen(true)}
                />
              }
            >
              <KeyRoundIcon />
            </TooltipTrigger>
            <TooltipPopup>Update secrets</TooltipPopup>
          </Tooltip>
        ) : null}
        {error !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  disabled={busy}
                  aria-label={`Reconnect ${instance.name ?? instance.packId}`}
                  onClick={() => void run("reconnect")}
                />
              }
            >
              <RefreshCwIcon />
            </TooltipTrigger>
            <TooltipPopup>Reconnect — restart the poll</TooltipPopup>
          </Tooltip>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-tiny"
                aria-label={`Actions for ${instance.name ?? instance.packId}`}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setConfigOpen(true)}>Edit config</MenuItem>
            <MenuSub>
              <MenuSubTrigger disabled={rollbackTargets.length === 0}>
                <RotateCcwIcon />
                Roll back to
              </MenuSubTrigger>
              <MenuSubPopup>
                {rollbackTargets.map((version) => (
                  <MenuItem
                    key={version.schemaVersion}
                    onClick={() => runRollback(version.schemaVersion)}
                  >
                    v{version.schemaVersion} — approved{" "}
                    {formatRelativeTimeLabel(version.approvedAt)}
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={runUninstall}>
              Uninstall
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="truncate">{watchConnectorOriginLabel(instance.origin)}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0">v{instance.schemaVersion}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0">last fetch {lastFetch}</span>
      </div>
      {health.lastError !== null ? (
        <p className="truncate text-2xs text-error-foreground">{health.lastError}</p>
      ) : null}
      {rollback !== undefined ? (
        <p className="flex items-center gap-1 text-2xs text-muted-foreground">
          <RotateCcwIcon className="size-3 shrink-0" />
          Rolled back v{rollback.fromSchemaVersion} → v{rollback.toSchemaVersion},{" "}
          {formatRelativeTimeLabel(rollback.at)}
        </p>
      ) : null}
      {secretsOpen ? (
        <WatchConnectorSecretDialog
          instance={instance}
          secretKeys={declaredSecrets}
          onSubmit={(secrets) => {
            setSecretsOpen(false);
            void run("secrets", undefined, secrets);
          }}
          onClose={() => setSecretsOpen(false)}
        />
      ) : null}
      {configOpen ? (
        <WatchConnectorConfigDialog
          instance={instance}
          manifest={pack?.manifest}
          onSubmit={(config) => {
            setConfigOpen(false);
            void run("config", config);
          }}
          onClose={() => setConfigOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * One row per live connector instance: health, auth/secret state, last
 * fetch, pinned version, and the sticky rollback record. Reconnect rides the
 * `setInstanceConfig` write — the config is resent untouched, which restarts
 * the poller and forces a fetch.
 */
export function WatchConnectorStatusWidget(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly instances: ReadonlyArray<WatchConnectorInstance>;
  readonly packs: ReadonlyArray<WatchConnectorPack>;
  /** Pending install/upgrade requests a human still has to rule on. */
  readonly installRequests: ReadonlyArray<WatchConnectorInstallRequest>;
  /** False until the connectors query has produced data — unknown, not empty. */
  readonly connectorsReady: boolean;
  /** Settled connectors-query failure text; stale rows keep rendering. */
  readonly connectorsError: string | null;
  /** Opens the install/upgrade confirm dialog for a pending request. */
  readonly onReviewInstallRequest: (request: WatchConnectorInstallRequest) => void;
}) {
  useNowMinute();
  const versionsByPackId = useMemo(() => {
    const map = new Map<string, Array<WatchConnectorPack>>();
    for (const pack of props.packs) {
      if (pack.archivedAt !== null) continue;
      const list = map.get(pack.packId) ?? [];
      list.push(pack);
      map.set(pack.packId, list);
    }
    return map;
  }, [props.packs]);
  const live = props.instances.filter((instance) => instance.archivedAt === null);
  const pending = props.installRequests.filter((request) => request.status === "pending");

  if (live.length === 0 && pending.length === 0) {
    // Pending is not "none installed" — the query has to settle before the
    // empty state is honest.
    if (!props.connectorsReady) return <WatchWidgetEmpty text="Loading connectors…" />;
    if (props.connectorsError !== null) {
      return <WatchWidgetEmpty text="Could not load connectors" />;
    }
    return <WatchWidgetEmpty text="No connectors installed" />;
  }
  return (
    <WatchWidgetRows>
      {pending.map((request) => (
        <PendingRequestRow
          key={request.id}
          request={request}
          onReview={props.onReviewInstallRequest}
        />
      ))}
      {live.map((instance) => (
        <ConnectorRow
          key={instance.id}
          environmentId={props.environmentId}
          instance={instance}
          versions={versionsByPackId.get(instance.packId) ?? []}
        />
      ))}
    </WatchWidgetRows>
  );
}
