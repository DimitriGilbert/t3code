import { useAtomValue } from "@effect/atom-react";
import type { ClankerRunId, ClankerRunSummary, ScopedProjectRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlayIcon } from "lucide-react";
import type { ReactNode } from "react";

import { clankerEnvironment } from "~/state/clanker";

import { RelativeTime } from "../RelativeTime";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { ClankerDuration } from "./ClankerDuration";
import { ClankerRunProgressBar } from "./ClankerRunProgressBar";
import { ClankerRunStatusBadge } from "./ClankerStatus";
import { clankerRunDurationRange, clankerRunProgress } from "./clankerRunView";
import { clankerWorkflowFileName } from "./clankerView";

function RunListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {["a", "b", "c"].map((row) => (
        <div key={row} className="space-y-2.5 rounded-xl border border-border/60 px-4 py-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4.5 w-20" />
            <Skeleton className="h-3.5 w-40" />
          </div>
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

function RunRow({ run, onOpen }: { readonly run: ClankerRunSummary; readonly onOpen: () => void }) {
  const progress = clankerRunProgress(run);
  const runningStep = run.runningStepNames[0];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 rounded-xl border border-border/60 px-4 py-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ClankerRunStatusBadge status={run.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.workflowName}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {progress.settled}/{progress.total}
        </span>
      </span>
      <ClankerRunProgressBar
        percent={progress.percent}
        tone={run.failedSteps > 0 ? "failed" : "default"}
      />
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0">
          <RelativeTime timestamp={run.startedAt} />
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0">
          <ClankerDuration range={clankerRunDurationRange(run)} />
        </span>
        {runningStep !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <span className="truncate text-info-foreground">
              {runningStep}
              {run.runningStepNames.length > 1 ? ` +${run.runningStepNames.length - 1} more` : ""}
            </span>
          </>
        ) : run.workflowPath !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <span className="truncate font-mono">{clankerWorkflowFileName(run.workflowPath)}</span>
          </>
        ) : null}
      </span>
    </button>
  );
}

export function ClankerRunList({
  project,
  onOpenRun,
  projectLabel,
  projectSelect,
  onStartRun,
  canStart,
}: {
  readonly project: ScopedProjectRef;
  readonly projectLabel: string;
  /** Project switcher for the empty state; `null` with a single project. */
  readonly projectSelect: ReactNode;
  readonly onOpenRun: (runId: ClankerRunId) => void;
  readonly onStartRun: () => void;
  readonly canStart: boolean;
}) {
  const listResult = useAtomValue(
    clankerEnvironment.runsLive({
      environmentId: project.environmentId,
      input: { projectId: project.projectId },
    }),
  );
  const runs = Option.getOrNull(AsyncResult.value(listResult))?.runs ?? null;
  if (listResult._tag === "Failure" && runs === null) {
    return (
      <Alert variant="error">
        <AlertDescription>Could not load clanker runs for this project.</AlertDescription>
      </Alert>
    );
  }
  if (runs === null) return <RunListSkeleton />;
  if (runs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PlayIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No runs in {projectLabel}</EmptyTitle>
          <EmptyDescription>
            Run a workflow and every step shows up here with its own thread.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {projectSelect !== null ? (
            <div className="flex flex-col items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Or pick another project</span>
              {projectSelect}
            </div>
          ) : null}
          <Button size="sm" disabled={!canStart} onClick={onStartRun}>
            <PlayIcon />
            Run a workflow
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <RunRow key={run.runId} run={run} onOpen={() => onOpenRun(run.runId)} />
      ))}
    </div>
  );
}
