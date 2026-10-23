import type { EnvironmentId, ServerConfig, WatchWidget } from "@t3tools/contracts";
import { watchAgentSourceId } from "@t3tools/client-runtime/state/watch-mounts";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";

/**
 * Whole-surface gate: the environment's server config must opt into the
 * watch screen. Absent or false hides both the entry point and the screen.
 */
export function watchScreenSupported(serverConfig: ServerConfig | null | undefined): boolean {
  return serverConfig?.watchScreen === true;
}

/**
 * The mobile sandbox kill switch. WebView enforcement has a documented
 * Android fails-open window (the load-gate callback can time out), so agent
 * widgets only mount when the server explicitly opts in. When the flag is
 * off, agent/pack widget rows drop out entirely — capability absence is not
 * a widget error and renders no placeholder.
 */
export function watchAgentWidgetsMobileSupported(
  serverConfig: ServerConfig | null | undefined,
): boolean {
  return serverConfig?.watchAgentWidgetsMobile === true;
}

/** The mobile stack minus agent-authored widgets when the kill switch is off. */
export function watchMobileVisibleWidgets(
  widgets: ReadonlyArray<WatchWidget>,
  agentWidgetsEnabled: boolean,
): WatchWidget[] {
  if (agentWidgetsEnabled) return [...widgets];
  return widgets.filter((widget) => watchAgentSourceId(widget.kind) === undefined);
}

/**
 * Which environment the Watch entry point opens: the environment the user is
 * filtering Home on when it supports the screen, otherwise the first enabled
 * environment whose server config advertises it. `null` hides the entry.
 */
export function resolveWatchEntryEnvironmentId(input: {
  readonly environments: ReadonlyArray<WorkspaceEnvironment>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly preferredEnvironmentId?: EnvironmentId | null;
}): EnvironmentId | null {
  const enabled = input.environments.filter((environment) => environment.isEnabled);
  const supported = (environmentId: EnvironmentId) =>
    watchScreenSupported(input.serverConfigs.get(environmentId));
  const preferred = input.preferredEnvironmentId;
  if (
    preferred !== null &&
    preferred !== undefined &&
    enabled.some((environment) => environment.environmentId === preferred) &&
    supported(preferred)
  ) {
    return preferred;
  }
  return enabled.find((environment) => supported(environment.environmentId))?.environmentId ?? null;
}
