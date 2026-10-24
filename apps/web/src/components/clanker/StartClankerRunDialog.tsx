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
  ProjectId,
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

export function StartClankerRunDialog({
  open,
  onOpenChange,
  environmentId,
  projectId,
  workflowPath,
  onStarted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Fixed when opened from a workflow; `null` lets the dialog pick one. */
  readonly workflowPath: ClankerWorkflowPath | null;
  readonly onStarted: (runId: ClankerRunId) => void;
}) {
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [pickedWorkflow, setPickedWorkflow] = useState<ClankerWorkflowPath | null>(null);
  const [starting, setStarting] = useState(false);

  const workflowsResult = useAtomValue(
    clankerEnvironment.workflowsLive({ environmentId, input: { projectId } }),
  );
  const workflows = Option.getOrNull(AsyncResult.value(workflowsResult))?.workflows ?? [];
  const targetPath = workflowPath ?? pickedWorkflow ?? workflows[0]?.path ?? null;
  const target = workflows.find((workflow) => workflow.path === targetPath) ?? null;

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const project =
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
      : scheduledTaskDefaultModel(settings, project, instanceEntries);
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
    onStarted(result.value.runId);
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
            Each step runs in its own thread on this project, in dependency wave order.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1.5">
            <Label>Workflow</Label>
            {workflowPath !== null ? (
              <p className="flex min-w-0 items-baseline gap-2 text-sm">
                <span className="truncate font-medium">{target?.name ?? workflowPath}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {workflowPath}
                </span>
              </p>
            ) : workflows.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                This project has no workflows in{" "}
                <span className="font-mono">.clanker/workflows</span> yet.
              </p>
            ) : (
              <Select
                value={targetPath ?? ""}
                onValueChange={(value) => {
                  if (value !== null) setPickedWorkflow(ClankerWorkflowPath.make(value));
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
