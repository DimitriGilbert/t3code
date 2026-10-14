import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { watchConnectorHealthErrorState } from "@t3tools/client-runtime/state/watch-widgets";
import type {
  EnvironmentId,
  WatchConnectorInstance,
  WatchConnectorPack,
  WatchWidget,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { KeyRoundIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { watchEnvironment } from "~/state/watch";
import { formatRelativeTimeLabel } from "~/timestampFormat";

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

function originLabel(instance: WatchConnectorInstance): string {
  if (instance.origin.kind === "localPath") return instance.origin.path;
  try {
    return new URL(instance.origin.url).host;
  } catch {
    return instance.origin.url;
  }
}

function ConnectorRow(props: {
  readonly environmentId: EnvironmentId;
  readonly instance: WatchConnectorInstance;
  readonly pack: WatchConnectorPack | undefined;
  readonly timestampFormat: TimestampFormat;
}) {
  const { instance } = props;
  const setInstanceConfig = useOrchestrationCommand(watchEnvironment.setConnectorInstanceConfig, {
    reportFailure: false,
  });
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [busy, setBusy] = useState<"reconnect" | null>(null);

  const health = instance.health;
  const presentation = HEALTH_BADGE[health.status];
  const error = watchConnectorHealthErrorState(instance);
  const declaredSecrets = props.pack?.manifest.secretKeys ?? [];
  const missingSecrets = declaredSecrets.filter(
    (key) => !instance.configuredSecretKeys.includes(key),
  );
  const lastFetch =
    health.lastFetchAt === null ? "never fetched" : formatRelativeTimeLabel(health.lastFetchAt);
  const rollback = health.lastRollback;

  const run = async (intent: "reconnect" | "secrets", secrets?: Record<string, string>) => {
    setBusy("reconnect");
    try {
      // Re-sending config bumps updatedAt; the poller restarts and fetches.
      const result = await setInstanceConfig({
        environmentId: props.environmentId,
        input: {
          instanceId: instance.id,
          config: instance.config,
          ...(secrets === undefined ? {} : { secrets }),
        },
      });
      if (!AsyncResult.isSuccess(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: intent === "secrets" ? "Could not update secrets" : "Could not reconnect",
          description: failure instanceof Error ? failure.message : "The connector request failed.",
        });
      }
    } finally {
      setBusy(null);
    }
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
                  disabled={busy === "reconnect"}
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
      </div>
      <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="truncate">{originLabel(instance)}</span>
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
            void run("secrets", secrets);
          }}
          onClose={() => setSecretsOpen(false)}
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
  readonly timestampFormat: TimestampFormat;
  /** False until the connectors query has produced data — unknown, not empty. */
  readonly connectorsReady: boolean;
  /** Settled connectors-query failure text; stale rows keep rendering. */
  readonly connectorsError: string | null;
}) {
  useNowMinute();
  const packById = useMemo(
    () => new Map(props.packs.map((pack) => [pack.packId, pack])),
    [props.packs],
  );
  const live = props.instances.filter((instance) => instance.archivedAt === null);

  if (live.length === 0) {
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
      {live.map((instance) => (
        <ConnectorRow
          key={instance.id}
          environmentId={props.environmentId}
          instance={instance}
          pack={packById.get(instance.packId)}
          timestampFormat={props.timestampFormat}
        />
      ))}
    </WatchWidgetRows>
  );
}
