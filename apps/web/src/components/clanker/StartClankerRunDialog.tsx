import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ClankerWorkflowPath } from "@t3tools/contracts";
import type {
  ClankerRunId,
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { clankerEnvironment } from "~/state/clanker";
import { useProjects } from "~/state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
// The project's headless launch model, shared with scheduled tasks: both start
// agent turns with no composer to inherit a selection from.
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ClankerProjectSelect } from "./ClankerProjectSelect";
import type { ClankerProjectOption } from "./clankerView";

export function StartClankerRunDialog({
  open,
  onOpenChange,
  projects,
  project: pageProject,
  environmentLabel,
  workflowPath,
  onStarted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projects: ReadonlyArray<ClankerProjectOption>;
  /** The project the page is showing; the dialog starts there. */
  readonly project: ClankerProjectOption;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  /** Fixed when opened from a workflow, which also locks the project. */
  readonly workflowPath: ClankerWorkflowPath | null;
  readonly onStarted: (project: ClankerProjectOption, runId: ClankerRunId) => void;
}) {
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [pickedProjectKey, setPickedProjectKey] = useState<string | null>(null);
  const [pickedWorkflow, setPickedWorkflow] = useState<{
    readonly projectKey: string;
    readonly path: ClankerWorkflowPath;
  } | null>(null);
  const [starting, setStarting] = useState(false);

  // The workflow file belongs to the page project; switching projects unlocks
  // the workflow field for the new project instead of locking the picker.
  const project =
    (pickedProjectKey === null
      ? null
      : (projects.find((candidate) => candidate.key === pickedProjectKey) ?? null)) ?? pageProject;
  const workflowLocked = workflowPath !== null && project.key === pageProject.key;
  const effectiveWorkflowPath = workflowLocked ? workflowPath : null;
  const environmentId = project.ref.environmentId;
  const projectId = project.ref.projectId;

  const workflowsResult = useAtomValue(
    clankerEnvironment.workflowsLive({ environmentId, input: { projectId } }),
  );
  const loadedWorkflows = Option.getOrNull(AsyncResult.value(workflowsResult));
  const workflows = loadedWorkflows?.workflows ?? [];
  const pickedPath = pickedWorkflow?.projectKey === project.key ? pickedWorkflow.path : null;
  const targetPath = effectiveWorkflowPath ?? pickedPath ?? workflows[0]?.path ?? null;
  const target = workflows.find((workflow) => workflow.path === targetPath) ?? null;

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const projectEntity =
    useProjects().find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    ) ?? null;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const selection =
    picked !== null &&
    instanceEntries.some((entry) => entry.instanceId === picked.instanceId && entry.enabled)
      ? picked
      : scheduledTaskDefaultModel(settings, projectEntity, instanceEntries);
  const activeInstanceId = selection?.instanceId ?? instanceEntries[0]?.instanceId ?? null;
  const activeModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );

  const canStart = useAtomValue(clankerEnvironment.startRun.permissionAtom(environmentId));
  const startRun = useAtomCommand(clankerEnvironment.startRun, {
    label: "clanker run start",
    reportFailure: false,
  });

  const reset = () => {
    setPicked(null);
    setPickedProjectKey(null);
    setPickedWorkflow(null);
  };

  const start = async () => {
    if (starting || targetPath === null) return;
    setStarting(true);
    const result = await startRun({
      environmentId,
      input: {
        projectId,
        workflowPath: targetPath,
        ...(selection === null
          ? {}
          : { providerInstanceId: selection.instanceId, model: selection.model }),
      },
    });
    setStarting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start run",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    reset();
    onOpenChange(false);
    onStarted(project, result.value.runId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Run workflow</DialogTitle>
          <DialogDescription>
            Each step runs in its own thread, in dependency wave order.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1.5">
            <Label>Project</Label>
            {projects.length <= 1 ? (
              <p className="flex min-w-0 items-baseline gap-2 text-sm">
                <span className="truncate font-medium">{project.label}</span>
                {environmentLabel(environmentId) !== null ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {environmentLabel(environmentId)}
                  </span>
                ) : null}
              </p>
            ) : (
              <ClankerProjectSelect
                options={projects}
                selected={project}
                environmentLabel={environmentLabel}
                size="default"
                disabled={starting}
                onSelectProject={setPickedProjectKey}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Steps run as threads on this project's worktree.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Workflow</Label>
            {effectiveWorkflowPath !== null ? (
              <p className="flex min-w-0 items-baseline gap-2 text-sm">
                <span className="truncate font-medium">
                  {target?.name ?? effectiveWorkflowPath}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {effectiveWorkflowPath}
                </span>
              </p>
            ) : loadedWorkflows === null ? (
              <p className="text-xs text-muted-foreground">Loading workflows…</p>
            ) : workflows.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {project.label} has no workflows in{" "}
                <span className="font-mono">.clanker/workflows</span> yet.
              </p>
            ) : (
              <Select
                value={targetPath ?? ""}
                disabled={starting}
                onValueChange={(value) => {
                  if (value !== null) {
                    setPickedWorkflow({
                      projectKey: project.key,
                      path: ClankerWorkflowPath.make(value),
                    });
                  }
                }}
              >
                <SelectTrigger aria-label="Workflow">
                  <SelectValue>
                    <span className="truncate">{target?.name ?? "Choose a workflow"}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {workflows.map((workflow) => (
                    <SelectItem key={workflow.path} value={workflow.path} label={workflow.name}>
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate">{workflow.name}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {workflow.path}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Model</Label>
            {activeInstanceId === null ? (
              <p className="text-xs text-muted-foreground">
                No provider is set up on this environment yet.
              </p>
            ) : (
              <div className="flex">
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  disabled={starting || !canStart}
                  onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
                    setPicked({ instanceId, model })
                  }
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Every step runs on this model unless the workflow names its own.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={starting} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={starting || !canStart || targetPath === null}
            onClick={() => void start()}
          >
            <PlayIcon />
            {starting ? "Starting…" : "Start run"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
