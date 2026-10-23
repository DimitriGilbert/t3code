import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { useSidebarProjectGroups } from "~/hooks/useSidebarProjectGroups";
import { useEnvironments } from "~/state/environments";

import { SidebarInset } from "../ui/sidebar";
import { ClankerWorkflowEditor } from "./ClankerWorkflowEditor";
import { ClankerWorkflowList } from "./ClankerWorkflowList";
import type { ClankerProjectOption } from "./clankerView";

export interface ClankerSearch {
  readonly project?: string;
  readonly file?: string;
}

export function useClankerProjectOptions(): ReadonlyArray<ClankerProjectOption> {
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

  const requestedRef = search.project !== undefined ? parseScopedProjectKey(search.project) : null;
  const selectedOption =
    options.find(
      (option) =>
        option.ref.environmentId === requestedRef?.environmentId &&
        option.ref.projectId === requestedRef.projectId,
    ) ??
    options[0] ??
    null;

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const multipleEnvironments = new Set(options.map((option) => option.environmentId)).size > 1;
  const environmentLabel = (environmentId: EnvironmentId): string | null =>
    multipleEnvironments ? (environmentLabelById.get(environmentId) ?? null) : null;

  const selectProject = (key: string) => {
    void navigate({ search: { project: key } });
  };
  const openFile = (path: string | undefined) => {
    void navigate({
      search: (previous: ClankerSearch): ClankerSearch => ({
        ...(previous.project !== undefined ? { project: previous.project } : {}),
        ...(path !== undefined ? { file: path } : {}),
      }),
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {selectedOption !== null && search.file !== undefined ? (
        <ClankerWorkflowEditor
          key={`${selectedOption.key}:${search.file}`}
          environmentId={selectedOption.ref.environmentId}
          projectId={selectedOption.ref.projectId}
          path={search.file}
          projectLabel={selectedOption.label}
          onBack={() => openFile(undefined)}
        />
      ) : (
        <ClankerWorkflowList
          options={options}
          selected={selectedOption}
          environmentLabel={environmentLabel}
          onSelectProject={selectProject}
          onOpenFile={openFile}
        />
      )}
    </SidebarInset>
  );
}
