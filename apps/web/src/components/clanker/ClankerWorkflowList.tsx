import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ClankerWorkflowPath,
  ClankerWorkflowSummary,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  FileCode2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { clankerEnvironment } from "~/state/clanker";
import { useAtomCommand } from "~/state/use-atom-command";

import { RelativeTime } from "../RelativeTime";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";

function WorkflowListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {["a", "b", "c"].map((row) => (
        <div
          key={row}
          className="flex items-center gap-3 rounded-xl border border-border/60 px-4 py-3"
        >
          <Skeleton className="size-9" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-12" />
        </div>
      ))}
    </div>
  );
}

function WorkflowRow({
  environmentId,
  projectId,
  workflow,
  canWrite,
  canRun,
  onEdit,
  onRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workflow: ClankerWorkflowSummary;
  readonly canWrite: boolean;
  readonly canRun: boolean;
  readonly onEdit: () => void;
  readonly onRun: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const deleteWorkflow = useAtomCommand(clankerEnvironment.deleteWorkflow, {
    label: "clanker workflow delete",
    reportFailure: false,
  });

  const remove = async () => {
    if (busy) return;
    const confirmed = await requestConfirmDialog(
      `Delete "${workflow.name}"?\n${workflow.path} is removed from disk. This cannot be undone.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await deleteWorkflow({
      environmentId,
      input: { projectId, path: workflow.path },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not delete workflow",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  return (
    <div className="group flex items-center gap-3 rounded-xl border border-border/60 px-4 py-3 transition-colors [:hover]:bg-accent/40">
      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-md border bg-card not-dark:bg-clip-padding text-foreground shadow-sm/5">
          <FileCode2Icon className="size-4.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium">{workflow.name}</span>
            {workflow.version !== undefined ? (
              <span className="shrink-0 text-xs text-muted-foreground">v{workflow.version}</span>
            ) : null}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{workflow.path}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">
              {workflow.stepCount} {workflow.stepCount === 1 ? "step" : "steps"}
            </span>
            {workflow.modifiedAt !== null ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0">
                  <RelativeTime timestamp={workflow.modifiedAt} />
                </span>
              </>
            ) : null}
          </span>
        </span>
      </button>
      {workflow.issueCount > 0 ? (
        <Badge variant="error">
          {workflow.issueCount} {workflow.issueCount === 1 ? "issue" : "issues"}
        </Badge>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Actions for ${workflow.name}`}
            />
          }
        >
          <MoreHorizontalIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem disabled={!canRun} onClick={onRun}>
            <PlayIcon />
            Run
          </MenuItem>
          <MenuItem onClick={onEdit}>
            <PencilIcon />
            Edit
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!canWrite} onClick={() => void remove()}>
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function ClankerWorkflowList({
  project,
  canWrite,
  canRun,
  onOpenFile,
  onRunWorkflow,
  onNewWorkflow,
}: {
  readonly project: ScopedProjectRef;
  readonly canWrite: boolean;
  readonly canRun: boolean;
  readonly onOpenFile: (path: ClankerWorkflowPath) => void;
  readonly onRunWorkflow: (path: ClankerWorkflowPath) => void;
  readonly onNewWorkflow: () => void;
}) {
  const listResult = useAtomValue(
    clankerEnvironment.workflowsLive({
      environmentId: project.environmentId,
      input: { projectId: project.projectId },
    }),
  );
  const workflows = Option.getOrNull(AsyncResult.value(listResult))?.workflows ?? null;

  if (listResult._tag === "Failure" && workflows === null) {
    return (
      <Alert variant="error">
        <AlertDescription>Could not load clanker workflows for this project.</AlertDescription>
      </Alert>
    );
  }
  if (workflows === null) return <WorkflowListSkeleton />;
  if (workflows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No clanker workflows yet</EmptyTitle>
          <EmptyDescription>
            Workflows live in <span className="font-mono">.clanker/workflows</span> and run steps as
            parallel DAG waves.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" disabled={!canWrite} onClick={onNewWorkflow}>
            <PlusIcon />
            New workflow
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <div className="space-y-2">
      {workflows.map((workflow) => (
        <WorkflowRow
          key={workflow.path}
          environmentId={project.environmentId}
          projectId={project.projectId}
          workflow={workflow}
          canWrite={canWrite}
          canRun={canRun}
          onEdit={() => onOpenFile(workflow.path)}
          onRun={() => onRunWorkflow(workflow.path)}
        />
      ))}
    </div>
  );
}
