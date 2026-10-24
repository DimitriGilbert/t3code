import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ClankerRunId,
  ClankerStepState,
  ClankerWorkflowPath,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { isElectron } from "~/env";
import { clankerEnvironment } from "~/state/clanker";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ClankerDuration } from "./ClankerDuration";
import { ClankerRunProgressBar } from "./ClankerRunProgressBar";
import { ClankerRunStatusBadge, ClankerStepStatusIcon } from "./ClankerStatus";
import {
  CLANKER_STEP_STATUS_LABEL,
  clampClankerText,
  clankerRunDurationRange,
  clankerRunIsResumable,
  clankerRunProgress,
  clankerStepDurationRange,
  clankerStepRows,
  clankerWaveGroups,
  type ClankerStepRow,
} from "./clankerRunView";

function OpenThreadLink({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(scopeThreadRef(environmentId, threadId))}
        />
      }
    >
      <ExternalLinkIcon />
      Open thread
    </Button>
  );
}

function StepOutputs({ outputs }: { readonly outputs: Readonly<Record<string, string>> }) {
  const entries = Object.entries(outputs);
  if (entries.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Outputs
      </h4>
      <dl className="space-y-1">
        {entries.map(([key, value]) => {
          const clamped = clampClankerText(value, 400);
          return (
            <div key={key} className="flex min-w-0 gap-2 text-xs">
              <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-words font-mono">
                {clamped.text}
                {clamped.hiddenChars > 0 ? "…" : ""}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function StepResponse({ state }: { readonly state: ClankerStepState }) {
  const last = state.responses.at(-1);
  if (last === undefined) return null;
  const clamped = clampClankerText(last.response);
  return (
    <section className="space-y-1.5">
      <h4 className="flex items-baseline gap-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Last response
        <span className="normal-case tracking-normal text-muted-foreground/80">
          {last.model_id}
          {state.responses.length > 1 ? ` · ${state.responses.length} turns` : ""}
        </span>
      </h4>
      <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/30 p-2.5 text-xs leading-5">
        {clamped.text}
      </p>
      {clamped.hiddenChars > 0 ? (
        <p className="text-2xs text-muted-foreground">
          {clamped.hiddenChars.toLocaleString()} more characters. Open the thread for the full
          response.
        </p>
      ) : null}
    </section>
  );
}

function StepCard({
  row,
  environmentId,
  threadId,
}: {
  readonly row: ClankerStepRow;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | undefined;
}) {
  const state = row.state;
  const status = state?.status ?? "pending";
  const range = state === null ? null : clankerStepDurationRange(state);
  const hasDetail =
    state !== null &&
    (state.error !== undefined ||
      state.responses.length > 0 ||
      Object.keys(state.outputs).length > 0);

  return (
    <div className="rounded-xl border border-border/60 has-data-open:bg-accent/20">
      <Collapsible disabled={!hasDetail}>
        <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
          <CollapsibleTrigger
            className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            disabled={!hasDetail}
          >
            <ClankerStepStatusIcon status={status} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.stepName}</span>
            {state !== null && state.retryCount > 0 ? (
              <Badge variant="warning" size="sm">
                {state.retryCount} {state.retryCount === 1 ? "retry" : "retries"}
              </Badge>
            ) : null}
            <span className="shrink-0 text-xs text-muted-foreground">
              {range === null ? (
                CLANKER_STEP_STATUS_LABEL[status]
              ) : (
                <ClankerDuration range={range} />
              )}
            </span>
            {hasDetail ? (
              <ChevronDownIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
              />
            ) : null}
          </CollapsibleTrigger>
          {threadId !== undefined ? (
            <OpenThreadLink environmentId={environmentId} threadId={threadId} />
          ) : null}
        </div>
        {hasDetail && state !== null ? (
          <CollapsiblePanel>
            <div className="space-y-3 border-t border-border/60 px-3 py-3">
              {state.error !== undefined ? (
                <Alert variant="error">
                  <AlertDescription>
                    <span className="whitespace-pre-wrap break-words">
                      {clampClankerText(state.error, 1_000).text}
                    </span>
                  </AlertDescription>
                </Alert>
              ) : null}
              <StepOutputs outputs={state.outputs} />
              <StepResponse state={state} />
            </div>
          </CollapsiblePanel>
        ) : null}
      </Collapsible>
    </div>
  );
}

export function ClankerRunDetail({
  environmentId,
  projectId,
  runId,
  projectLabel,
  onBack,
  onOpenWorkflow,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly runId: ClankerRunId;
  readonly projectLabel: string;
  readonly onBack: () => void;
  readonly onOpenWorkflow: (path: ClankerWorkflowPath) => void;
}) {
  const detailQuery = useEnvironmentQuery(
    clankerEnvironment.run({ environmentId, input: { projectId, runId } }),
  );
  const detail = detailQuery.data;

  // The run RPC has no per-run stream; the project's run subscription is the
  // change signal. Refetching only while the summary is ahead of the detail we
  // hold keeps this to one request per server-side transition.
  const listResult = useAtomValue(
    clankerEnvironment.runsLive({ environmentId, input: { projectId } }),
  );
  const summary =
    Option.getOrNull(AsyncResult.value(listResult))?.runs.find((run) => run.runId === runId) ??
    null;
  const summaryUpdatedAt = summary?.updatedAt ?? null;
  const detailUpdatedAt = detail?.updatedAt ?? null;
  const refreshDetail = detailQuery.refresh;
  useEffect(() => {
    if (summaryUpdatedAt === null || detailUpdatedAt === null) return;
    if (Date.parse(summaryUpdatedAt) <= Date.parse(detailUpdatedAt)) return;
    refreshDetail();
  }, [summaryUpdatedAt, detailUpdatedAt, refreshDetail]);

  const workflowPath = detail?.workflowPath ?? null;
  const documentQuery = useEnvironmentQuery(
    workflowPath === null
      ? null
      : clankerEnvironment.workflow({ environmentId, input: { projectId, path: workflowPath } }),
  );
  const waves = documentQuery.data?.waves ?? [];

  const canOperate = useAtomValue(clankerEnvironment.cancelRun.permissionAtom(environmentId));
  const cancelRun = useAtomCommand(clankerEnvironment.cancelRun, {
    label: "clanker run cancel",
    reportFailure: false,
  });
  const resumeRun = useAtomCommand(clankerEnvironment.resumeRun, {
    label: "clanker run resume",
    reportFailure: false,
  });

  const cancel = async () => {
    const confirmed = await requestConfirmDialog(
      "Cancel this run?\nSteps still in flight stop after their current turn. You can resume the run afterwards.",
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const result = await cancelRun({ environmentId, input: { projectId, runId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not cancel run",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  const resume = async (startFromStep: string | null) => {
    const result = await resumeRun({
      environmentId,
      input: {
        projectId,
        runId,
        ...(startFromStep === null ? {} : { startFromStep }),
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not resume run",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    refreshDetail();
  };

  const rows = detail === null ? [] : clankerStepRows(detail.steps, waves);
  const groups = clankerWaveGroups(rows);
  const threadByStep = new Map(
    (detail?.stepThreads ?? []).flatMap((entry) =>
      entry.threadId === undefined ? [] : [[entry.stepName, entry.threadId] as const],
    ),
  );
  const status = detail?.status ?? summary?.status ?? null;
  // Counted off the detail rather than the summary so the progress bar can
  // never disagree with the step cards below it.
  const stepStates = detail === null ? [] : Object.values(detail.steps);
  const progress = clankerRunProgress({
    stepTotal: stepStates.length,
    passedSteps: stepStates.filter(
      (state) => state.status === "passed" || state.status === "skipped",
    ).length,
    failedSteps: stepStates.filter((state) => state.status === "failed").length,
  });
  const title = detail?.workflowName ?? summary?.workflowName ?? "Run";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <Button size="icon-sm" variant="ghost" aria-label="Back to clanker runs" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <WorkspaceBreadcrumb ariaLabel="Clanker run breadcrumb">
          <WorkspaceBreadcrumbItem>
            <button type="button" className="truncate" onClick={onBack}>
              Runs
            </button>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{title}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="min-w-0 flex-1" />
        {status !== null ? <ClankerRunStatusBadge status={status} /> : null}
        {status === "running" ? (
          <Button size="sm" variant="outline" disabled={!canOperate} onClick={() => void cancel()}>
            <SquareIcon />
            Cancel
          </Button>
        ) : null}
        {status !== null && clankerRunIsResumable(status) ? (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" disabled={!canOperate} />}>
              <RotateCcwIcon />
              Resume
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => void resume(null)}>Resume where it stopped</MenuItem>
              {rows.length > 0 ? <MenuSeparator /> : null}
              {rows.map((row) => (
                <MenuItem key={row.stepName} onClick={() => void resume(row.stepName)}>
                  Restart from {row.stepName}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </WorkspacePageHeader>

      <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide" className="min-h-full">
          {detail === null && detailQuery.error !== null ? (
            <Alert variant="error">
              <AlertDescription>{detailQuery.error}</AlertDescription>
            </Alert>
          ) : detail === null ? (
            <div className="space-y-3" aria-hidden>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (
            <>
              <section className="space-y-3 rounded-xl border border-border/60 px-4 py-3.5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="tabular-nums text-foreground">
                    {progress.settled}/{progress.total} steps
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    started <RelativeTime timestamp={detail.startedAt} />
                  </span>
                  <span aria-hidden>·</span>
                  <ClankerDuration range={clankerRunDurationRange(detail)} />
                  <span aria-hidden>·</span>
                  <span className="truncate">{projectLabel}</span>
                </div>
                <ClankerRunProgressBar
                  percent={progress.percent}
                  tone={
                    detail.status === "failed"
                      ? "failed"
                      : detail.status === "completed"
                        ? "done"
                        : "default"
                  }
                />
                {workflowPath !== null ? (
                  <div className="-ml-2 flex min-w-0">
                    <Button size="sm" variant="ghost" onClick={() => onOpenWorkflow(workflowPath)}>
                      <FileCode2Icon />
                      <span className="truncate font-mono">{workflowPath}</span>
                    </Button>
                  </div>
                ) : null}
              </section>

              {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">This run has no steps.</p>
              ) : (
                <div className="space-y-5">
                  {groups.map((group) => (
                    <section key={group.wave ?? "detached"} className="space-y-2">
                      {/* Without the workflow's waves there is no grouping to
                          name, so the steps render as one plain list. */}
                      {waves.length === 0 ? null : (
                        <h2 className="text-2xs font-medium tracking-wide text-muted-foreground/80 uppercase">
                          {group.wave === null ? "No longer in the workflow" : `Wave ${group.wave}`}
                        </h2>
                      )}
                      {group.rows.map((row) => (
                        <StepCard
                          key={row.stepName}
                          row={row}
                          environmentId={environmentId}
                          threadId={threadByStep.get(row.stepName)}
                        />
                      ))}
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}
