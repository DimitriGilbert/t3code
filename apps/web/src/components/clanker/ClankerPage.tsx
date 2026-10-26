import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import { ClankerRunId, ClankerWorkflowPath } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { PlayIcon, PlusIcon, WorkflowIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { useSidebarProjectGroups } from "~/hooks/useSidebarProjectGroups";
import { isElectron } from "~/env";
import { clankerEnvironment } from "~/state/clanker";
import { useEnvironments } from "~/state/environments";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ClankerProjectSelect } from "./ClankerProjectSelect";
import { ClankerRunDetail } from "./ClankerRunDetail";
import { ClankerRunList } from "./ClankerRunList";
import { ClankerWorkflowEditor } from "./ClankerWorkflowEditor";
import { ClankerWorkflowList } from "./ClankerWorkflowList";
import { NewClankerWorkflowDialog } from "./NewClankerWorkflowDialog";
import { StartClankerRunDialog } from "./StartClankerRunDialog";
import type { ClankerProjectOption } from "./clankerView";

const DENIED_ATOM = Atom.make(false).pipe(Atom.withLabel("clanker-permission:denied"));

export type ClankerTab = "workflows" | "runs";

export interface ClankerSearch {
  readonly project?: string;
  readonly file?: string;
  readonly tab?: ClankerTab;
  readonly run?: string;
}

function useClankerProjectOptions(): ReadonlyArray<ClankerProjectOption> {
  const groups = useSidebarProjectGroups();
  const seen = new Set<string>();
  return groups.flatMap((group) =>
    group.memberProjects.flatMap((member) => {
      if (member.isScratch) return [];
      const ref = scopeProjectRef(member.environmentId, member.id);
      const key = scopedProjectKey(ref);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, ref, label: group.displayName, environmentId: member.environmentId }];
    }),
  );
}

export function ClankerPage() {
  const search = useSearch({ from: "/_chat/clanker" });
  const navigate = useNavigate({ from: "/clanker" });
  const { environments } = useEnvironments();
  const options = useClankerProjectOptions();
  const [newWorkflowOpen, setNewWorkflowOpen] = useState(false);
  // Non-null while the start dialog is open; the inner value is the workflow it
  // was opened for, or null when the dialog has to ask for one.
  const [runTarget, setRunTarget] = useState<{ path: ClankerWorkflowPath | null } | null>(null);

  const requestedRef = search.project !== undefined ? parseScopedProjectKey(search.project) : null;
  const selectedOption =
    options.find(
      (option) =>
        option.ref.environmentId === requestedRef?.environmentId &&
        option.ref.projectId === requestedRef.projectId,
    ) ??
    options[0] ??
    null;
  const tab: ClankerTab = search.tab ?? "workflows";

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const multipleEnvironments = new Set(options.map((option) => option.environmentId)).size > 1;
  const environmentLabel = (environmentId: EnvironmentId): string | null =>
    multipleEnvironments ? (environmentLabelById.get(environmentId) ?? null) : null;

  const canWrite = useAtomValue(
    selectedOption === null
      ? DENIED_ATOM
      : clankerEnvironment.updateWorkflow.permissionAtom(selectedOption.ref.environmentId),
  );
  const canRun = useAtomValue(
    selectedOption === null
      ? DENIED_ATOM
      : clankerEnvironment.startRun.permissionAtom(selectedOption.ref.environmentId),
  );

  // Every navigation keeps the project, so switching views never silently
  // changes which project is in front of the user.
  const go = (next: Omit<ClankerSearch, "project">) => {
    void navigate({
      search: (previous: ClankerSearch): ClankerSearch => ({
        ...(previous.project !== undefined ? { project: previous.project } : {}),
        ...next,
      }),
    });
  };
  const selectProject = (key: string) => {
    void navigate({
      search: { project: key, ...(search.tab === undefined ? {} : { tab: search.tab }) },
    });
  };
  const openFile = (path: ClankerWorkflowPath) => go({ file: path });
  const openRun = (runId: ClankerRunId) => go({ tab: "runs", run: runId });
  const selectTab = (next: ClankerTab) => go(next === "workflows" ? {} : { tab: next });

  const runId = search.run !== undefined ? ClankerRunId.make(search.run) : null;

  if (selectedOption !== null && runId !== null) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <ClankerRunDetail
          key={`${selectedOption.key}:${runId}`}
          environmentId={selectedOption.ref.environmentId}
          projectId={selectedOption.ref.projectId}
          runId={runId}
          projectLabel={selectedOption.label}
          onBack={() => selectTab("runs")}
          onOpenWorkflow={openFile}
        />
      </SidebarInset>
    );
  }

  if (selectedOption !== null && search.file !== undefined) {
    const path = ClankerWorkflowPath.make(search.file);
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <ClankerWorkflowEditor
          key={`${selectedOption.key}:${path}`}
          environmentId={selectedOption.ref.environmentId}
          projectId={selectedOption.ref.projectId}
          path={path}
          projectLabel={selectedOption.label}
          canRun={canRun}
          onBack={() => selectTab("workflows")}
          onRun={() => setRunTarget({ path })}
        />
        <StartClankerRunDialog
          open={runTarget !== null}
          onOpenChange={(open) => setRunTarget(open ? runTarget : null)}
          environmentId={selectedOption.ref.environmentId}
          projectId={selectedOption.ref.projectId}
          workflowPath={runTarget?.path ?? null}
          onStarted={openRun}
        />
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Clanker breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Clanker</h1>
            </WorkspaceBreadcrumbItem>
            {selectedOption !== null || options.length > 1 ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem className="shrink">
                  <ClankerProjectSelect
                    options={options}
                    selected={selectedOption}
                    environmentLabel={environmentLabel}
                    onSelectProject={selectProject}
                  />
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <ToggleGroup
            aria-label="Clanker section"
            value={[tab]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "workflows" || next === "runs") selectTab(next);
            }}
          >
            <Toggle value="workflows">
              <WorkflowIcon />
              Workflows
            </Toggle>
            <Toggle value="runs">
              <PlayIcon />
              Runs
            </Toggle>
          </ToggleGroup>
          {selectedOption !== null ? (
            tab === "runs" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canRun}
                onClick={() => setRunTarget({ path: null })}
              >
                <PlayIcon />
                Run workflow
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite}
                onClick={() => setNewWorkflowOpen(true)}
              >
                <PlusIcon />
                New workflow
              </Button>
            )
          ) : null}
        </WorkspacePageHeader>

        <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="wide" className="min-h-full">
            {selectedOption === null ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <WorkflowIcon aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>No project selected</EmptyTitle>
                  <EmptyDescription>
                    Add a project to manage its clanker workflows and runs.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : tab === "runs" ? (
              <ClankerRunList
                key={selectedOption.key}
                project={selectedOption.ref}
                canStart={canRun}
                onOpenRun={openRun}
                onStartRun={() => setRunTarget({ path: null })}
              />
            ) : (
              <ClankerWorkflowList
                key={selectedOption.key}
                project={selectedOption.ref}
                canWrite={canWrite}
                canRun={canRun}
                onOpenFile={openFile}
                onRunWorkflow={(path) => setRunTarget({ path })}
                onNewWorkflow={() => setNewWorkflowOpen(true)}
              />
            )}
          </WorkspacePageContainer>
        </div>
      </div>

      {selectedOption !== null ? (
        <>
          <NewClankerWorkflowDialog
            open={newWorkflowOpen}
            onOpenChange={setNewWorkflowOpen}
            environmentId={selectedOption.ref.environmentId}
            projectId={selectedOption.ref.projectId}
            onCreated={openFile}
          />
          <StartClankerRunDialog
            open={runTarget !== null}
            onOpenChange={(open) => setRunTarget(open ? runTarget : null)}
            environmentId={selectedOption.ref.environmentId}
            projectId={selectedOption.ref.projectId}
            workflowPath={runTarget?.path ?? null}
            onStarted={openRun}
          />
        </>
      ) : null}
    </SidebarInset>
  );
}
