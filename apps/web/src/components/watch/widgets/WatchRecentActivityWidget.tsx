import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  watchRecentActivityThreads,
  watchWidgetSettingBoolean,
  watchWidgetSettingNumber,
} from "@t3tools/client-runtime/state/watch-widgets";
import type { EnvironmentId, ProjectId, ScopedThreadRef, WatchWidget } from "@t3tools/contracts";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { FileDiffIcon } from "lucide-react";
import { useMemo } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useDiffPanelStore } from "~/diffPanelStore";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadProjection } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { WatchWidgetEmpty, WatchWidgetRow, WatchWidgetRows } from "./shared";

const RUN_STATUS_BADGE: Record<
  string,
  { label: string; variant: "success" | "error" | "outline" }
> = {
  completed: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  interrupted: { label: "Stopped", variant: "outline" },
  cancelled: { label: "Cancelled", variant: "outline" },
  rolled_back: { label: "Rolled back", variant: "outline" },
};
const DEFAULT_RUN_STATUS_BADGE = { label: "Done", variant: "success" } as const;

/**
 * Detail streams are the widget's expensive part: each one subscribes a
 * thread projection. Cap how many rows hold one open — past the cap a row
 * renders without diff totals rather than keeping an extra projection live.
 */
const MAX_DETAIL_SUBSCRIPTIONS = 4;

function RecentActivityRow(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell;
  readonly projectTitle: string | null;
  /** False without diff opt-in or past the subscription cap — no projection. */
  readonly withDetail: boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.thread.id);
  const detail = useThreadProjection(props.withDetail ? threadRef : null);
  // Checkpoint summaries give the last completed turn's diff totals and let
  // the row's diff action land on a real turn, not just the thread.
  const latestCheckpoint = useMemo(() => {
    if (detail === null) return null;
    return deriveThreadCheckpointSummaries(detail.projection).at(-1) ?? null;
  }, [detail]);

  const diffTotals = useMemo(() => {
    if (latestCheckpoint === null || latestCheckpoint.files.length === 0) return null;
    let additions = 0;
    let deletions = 0;
    for (const file of latestCheckpoint.files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions, files: latestCheckpoint.files.length };
  }, [latestCheckpoint]);

  const runStatus = props.thread.latestRun?.status ?? "completed";
  const status = RUN_STATUS_BADGE[runStatus] ?? DEFAULT_RUN_STATUS_BADGE;
  const completedAt = props.thread.latestRun?.completedAt ?? props.thread.updatedAt;
  const relative = formatRelativeTimeLabel(completedAt);

  const openDiff = () => {
    if (latestCheckpoint === null) return;
    useDiffPanelStore.getState().selectTurn(threadRef, latestCheckpoint.runId);
    useRightPanelStore.getState().open(threadRef, "diff");
    props.onOpen(threadRef);
  };

  return (
    <WatchWidgetRow
      title={props.thread.title}
      onOpen={() => props.onOpen(threadRef)}
      meta={
        <>
          {props.projectTitle === null ? null : (
            <span className="max-w-24 shrink-0 truncate text-2xs text-muted-foreground">
              {props.projectTitle}
            </span>
          )}
          <Badge size="sm" variant={status.variant}>
            {status.label}
          </Badge>
          {diffTotals !== null && (
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              +{formatDiffCount(diffTotals.additions)} −{formatDiffCount(diffTotals.deletions)} ·{" "}
              {diffTotals.files} {diffTotals.files === 1 ? "file" : "files"}
            </span>
          )}
          {relative !== "" && (
            <span className="shrink-0 text-2xs text-muted-foreground">{relative}</span>
          )}
        </>
      }
      actions={
        latestCheckpoint !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  aria-label={`Open diff for ${props.thread.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openDiff();
                  }}
                />
              }
            >
              <FileDiffIcon />
            </TooltipTrigger>
            <TooltipPopup>Open the turn's changes</TooltipPopup>
          </Tooltip>
        ) : undefined
      }
    />
  );
}

/**
 * Recently completed runs on the bound projects, newest first. Rows carry
 * the turn's diff totals when `showDiffs` is on — only the first
 * `MAX_DETAIL_SUBSCRIPTIONS` rows open a projection stream; the rest render
 * status and timing without one.
 */
export function WatchRecentActivityWidget(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  useNowMinute();
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const showDiffs = watchWidgetSettingBoolean(props.widget, "showDiffs", true);
  const items = watchRecentActivityThreads(props.threads, {
    projectId: props.projectId,
    maxItems,
  });

  if (items.length === 0) {
    return <WatchWidgetEmpty text="No completed runs yet" />;
  }
  return (
    <WatchWidgetRows>
      {items.map((thread, index) => (
        <RecentActivityRow
          key={thread.id}
          environmentId={props.environmentId}
          thread={thread}
          projectTitle={
            props.showProjectBadge ? (props.projectTitleById.get(thread.projectId) ?? null) : null
          }
          withDetail={showDiffs && index < MAX_DETAIL_SUBSCRIPTIONS}
          onOpen={props.onOpenThread}
        />
      ))}
    </WatchWidgetRows>
  );
}
