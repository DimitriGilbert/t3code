import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  watchRecentActivityThreads,
  watchWidgetSettingNumber,
} from "@t3tools/client-runtime/state/watch-widgets";
import type { EnvironmentId, ProjectId, ScopedThreadRef, WatchWidget } from "@t3tools/contracts";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { FileDiffIcon } from "lucide-react";
import { useMemo } from "react";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadProjection } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { WatchWidgetEmpty, WatchWidgetRow, WatchWidgetRows } from "./shared";

/**
 * Same detail-subscription cap as recent-activity: each capped row holds a
 * thread projection open just to read its checkpoint totals.
 */
const MAX_DETAIL_SUBSCRIPTIONS = 4;

function RecentDiffRow(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell;
  readonly projectTitle: string | null;
  /** False past the subscription cap — the row renders without diff totals. */
  readonly withDetail: boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.thread.id);
  const detail = useThreadProjection(props.withDetail ? threadRef : null);
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

  // A subscribed row that proved to have no diff drops out — under "Recent
  // diffs" a diffless turn is noise. Rows that never subscribed keep a plain
  // open-thread row rather than guessing.
  if (props.withDetail && detail !== null && diffTotals === null) return null;

  const openDiff = () => {
    if (latestCheckpoint === null || diffTotals === null) {
      props.onOpen(threadRef);
      return;
    }
    useDiffPanelStore.getState().selectTurn(threadRef, latestCheckpoint.runId);
    useRightPanelStore.getState().open(threadRef, "diff");
    props.onOpen(threadRef);
  };

  const relative = formatRelativeTimeLabel(
    props.thread.latestRun?.completedAt ?? props.thread.updatedAt,
  );

  return (
    <WatchWidgetRow
      title={props.thread.title}
      onOpen={openDiff}
      meta={
        <>
          {props.projectTitle === null ? null : (
            <span className="max-w-24 shrink-0 truncate text-2xs text-muted-foreground">
              {props.projectTitle}
            </span>
          )}
          {diffTotals !== null ? (
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              +{formatDiffCount(diffTotals.additions)} −{formatDiffCount(diffTotals.deletions)} ·{" "}
              {diffTotals.files} {diffTotals.files === 1 ? "file" : "files"}
            </span>
          ) : (
            <FileDiffIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          {relative !== "" && (
            <span className="shrink-0 text-2xs text-muted-foreground">{relative}</span>
          )}
        </>
      }
    />
  );
}

/**
 * The latest checkpoint diff per recently finished thread on the bound
 * projects. Row order reuses the recent-activity derivation — the diff
 * detail itself comes from each row's (capped) projection subscription, and
 * the row click lands on the diff view, not just the thread.
 */
export function WatchRecentDiffsWidget(props: {
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
  const items = watchRecentActivityThreads(props.threads, {
    projectId: props.projectId,
    maxItems,
  });

  if (items.length === 0) {
    return <WatchWidgetEmpty text="No diffs yet" />;
  }
  return (
    <WatchWidgetRows>
      {items.map((thread, index) => (
        <RecentDiffRow
          key={thread.id}
          environmentId={props.environmentId}
          thread={thread}
          projectTitle={
            props.showProjectBadge ? (props.projectTitleById.get(thread.projectId) ?? null) : null
          }
          withDetail={index < MAX_DETAIL_SUBSCRIPTIONS}
          onOpen={props.onOpenThread}
        />
      ))}
    </WatchWidgetRows>
  );
}
