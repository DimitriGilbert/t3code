import { useAtomValue } from "@effect/atom-react";
import type {
  ClankerWorkflowListResult,
  ClankerWorkflowPath,
  ClankerWorkflowSummary,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  FileCode2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { isElectron } from "~/env";
import { requestConfirmDialog } from "~/confirmDialog";
import { clankerEnvironment } from "~/state/clanker";
import { useAtomCommand } from "~/state/use-atom-command";

import { RelativeTime } from "../RelativeTime";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { NewClankerWorkflowDialog } from "./NewClankerWorkflowDialog";
import type { ClankerProjectOption } from "./clankerView";

const EMPTY_LIST_RESULT_ATOM = Atom.make(
  AsyncResult.initial<ClankerWorkflowListResult, never>(false),
).pipe(Atom.withLabel("clanker-workflow-list:empty"));
const DENIED_ATOM = Atom.make(false).pipe(Atom.withLabel("clanker-permission:denied"));

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
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workflow: ClankerWorkflowSummary;
  readonly canWrite: boolean;
  readonly onEdit: () => void;
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
  options,
  selected,
  environmentLabel,
  onSelectProject,
  onOpenFile,
}: {
  readonly options: ReadonlyArray<ClankerProjectOption>;
  readonly selected: ClankerProjectOption | null;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly onSelectProject: (key: string) => void;
  readonly onOpenFile: (path: ClankerWorkflowPath | undefined) => void;
}) {
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const listResult = useAtomValue(
    selected === null
      ? EMPTY_LIST_RESULT_ATOM
      : clankerEnvironment.workflowsLive({
          environmentId: selected.ref.environmentId,
          input: { projectId: selected.ref.projectId },
        }),
  );
  const canWrite = useAtomValue(
    selected === null
      ? DENIED_ATOM
      : clankerEnvironment.updateWorkflow.permissionAtom(selected.ref.environmentId),
  );
  const workflows = Option.getOrNull(AsyncResult.value(listResult))?.workflows ?? null;
  const loadError =
    listResult._tag === "Failure" ? "Could not load clanker workflows for this project." : null;
  const loading = workflows === null && loadError === null;

  const toolbar: ReactNode =
    options.length > 1 ? (
      <Select
        value={selected?.key ?? ""}
        onValueChange={(key) => {
          if (key !== null) onSelectProject(key);
        }}
      >
        <SelectTrigger size="compact" aria-label="Project">
          <SelectValue>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{selected?.label ?? "Project"}</span>
              {selected !== null && environmentLabel(selected.environmentId) !== null ? (
                <span className="truncate text-muted-foreground">
                  {environmentLabel(selected.environmentId)}
                </span>
              ) : null}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key} label={option.label}>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{option.label}</span>
                {environmentLabel(option.environmentId) !== null ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {environmentLabel(option.environmentId)}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : selected !== null ? (
      <span className="truncate text-sm text-muted-foreground">{selected.label}</span>
    ) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <WorkspaceBreadcrumb ariaLabel="Clanker workflows breadcrumb">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">Clanker</h1>
          </WorkspaceBreadcrumbItem>
          {toolbar !== null ? (
            <>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem className="shrink">{toolbar}</WorkspaceBreadcrumbItem>
            </>
          ) : null}
        </WorkspaceBreadcrumb>
        <div className="min-w-0 flex-1" />
        {selected !== null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite}
            onClick={() => setNewDialogOpen(true)}
          >
            <PlusIcon />
            New workflow
          </Button>
        ) : null}
      </WorkspacePageHeader>

      <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide" className="min-h-full">
          {selected === null ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <WorkflowIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No project selected</EmptyTitle>
                <EmptyDescription>Add a project to manage its clanker workflows.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : loading ? (
            <WorkflowListSkeleton />
          ) : loadError !== null ? (
            <Alert variant="error">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : workflows === null || workflows.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <WorkflowIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No clanker workflows yet</EmptyTitle>
                <EmptyDescription>
                  Workflows live in <span className="font-mono">.clanker/workflows</span> and run
                  steps as parallel DAG waves.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" disabled={!canWrite} onClick={() => setNewDialogOpen(true)}>
                  <PlusIcon />
                  New workflow
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <div className="space-y-2">
              {workflows.map((workflow) => (
                <WorkflowRow
                  key={workflow.path}
                  environmentId={selected.ref.environmentId}
                  projectId={selected.ref.projectId}
                  workflow={workflow}
                  canWrite={canWrite}
                  onEdit={() => onOpenFile(workflow.path)}
                />
              ))}
            </div>
          )}
        </WorkspacePageContainer>
      </div>

      {selected !== null ? (
        <NewClankerWorkflowDialog
          open={newDialogOpen}
          onOpenChange={setNewDialogOpen}
          environmentId={selected.ref.environmentId}
          projectId={selected.ref.projectId}
          onCreated={(path) => onOpenFile(path)}
        />
      ) : null}
    </div>
  );
}
