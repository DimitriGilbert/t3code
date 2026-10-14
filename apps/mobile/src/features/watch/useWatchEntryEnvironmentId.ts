import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useServerConfigs } from "../../state/entities";
import { useWorkspaceEnvironments } from "../../state/workspace";

import { resolveWatchEntryEnvironmentId } from "./watchMobile";

/**
 * The environment a Watch entry point opens, or `null` when none advertises
 * the capability — the entry point stays hidden entirely (no disabled row).
 */
export function useWatchEntryEnvironmentId(
  preferredEnvironmentId?: EnvironmentId | null,
): EnvironmentId | null {
  const environments = useWorkspaceEnvironments();
  const serverConfigs = useServerConfigs();
  return useMemo(
    () =>
      resolveWatchEntryEnvironmentId({
        environments,
        serverConfigs,
        preferredEnvironmentId,
      }),
    [environments, preferredEnvironmentId, serverConfigs],
  );
}
