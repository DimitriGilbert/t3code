import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createClankerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const fileScheduler = createAtomCommandScheduler();
  // Writes to the same project's `.clanker/workflows` directory serialize;
  // different projects (or environments) stay parallel.
  const fileConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    workflows: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:clanker:workflows",
      tag: WS_METHODS.clankerWorkflowsList,
      staleTimeMs: 15_000,
    }),
    workflowsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:clanker:workflows-live",
      tag: WS_METHODS.clankerWorkflowsSubscribe,
    }),
    workflow: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:clanker:workflow",
      tag: WS_METHODS.clankerWorkflowsGet,
      staleTimeMs: 5_000,
    }),
    createWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:clanker:workflow-create",
      tag: WS_METHODS.clankerWorkflowsCreate,
      scheduler: fileScheduler,
      concurrency: fileConcurrency,
    }),
    updateWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:clanker:workflow-update",
      tag: WS_METHODS.clankerWorkflowsUpdate,
      scheduler: fileScheduler,
      concurrency: fileConcurrency,
    }),
    deleteWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:clanker:workflow-delete",
      tag: WS_METHODS.clankerWorkflowsDelete,
      scheduler: fileScheduler,
      concurrency: fileConcurrency,
    }),
    validateWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:clanker:workflow-validate",
      tag: WS_METHODS.clankerWorkflowsValidate,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
    }),
    runs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:clanker:runs",
      tag: WS_METHODS.clankerRunsList,
      staleTimeMs: 15_000,
    }),
    runsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:clanker:runs-live",
      tag: WS_METHODS.clankerRunsSubscribe,
    }),
    run: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:clanker:run",
      tag: WS_METHODS.clankerRunsGet,
      staleTimeMs: 5_000,
    }),
    startRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:clanker:run-start",
      tag: WS_METHODS.clankerRunsStart,
    }),
    cancelRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:clanker:run-cancel",
      tag: WS_METHODS.clankerRunsCancel,
    }),
    resumeRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:clanker:run-resume",
      tag: WS_METHODS.clankerRunsResume,
    }),
  };
}
