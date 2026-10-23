import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  watchSubagentRunItems,
  watchWidgetSettingNumber,
  type WatchSubagentRunItem,
  type WatchSubagentRunStatus,
} from "@t3tools/client-runtime/state/watch-widgets";
import type { EnvironmentId, ProjectId, ScopedThreadRef, WatchWidget } from "@t3tools/contracts";
import { ArrowUpLeftIcon } from "lucide-react";
import { useMemo } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useThreadProjection } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { WatchElapsed, WatchWidgetEmpty, WatchWidgetRow, WatchWidgetRows } from "./shared";

const STATUS_BADGE: Record<
  WatchSubagentRunStatus,
  { readonly label: string; readonly variant: "info" | "warning" | "success" | "error" | "outline" }
> = {
  running: { label: "Running", variant: "info" },
  waiting: { label: "Waiting", variant: "warning" },
  completed: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  stopped: { label: "Stopped", variant: "outline" },
};

/**
 * Rows hold a projection subscription on the *parent* thread — that is where
 * the workflow phase lives — capped the same way recent-activity caps its
 * detail streams: past the cap a row renders shell data only.
 */
const MAX_DETAIL_SUBSCRIPTIONS = 4;

function SubagentRunRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WatchSubagentRunItem;
  readonly projectTitle: string | null;
  /** False past the subscription cap — no parent projection is opened. */
  readonly withDetail: boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const { item } = props;
  const parentRef =
    item.parentThread === null ? null : scopeThreadRef(props.environmentId, item.parentThread.id);
  const detail = useThreadProjection(props.withDetail ? parentRef : null);
  // The parent's projection is where workflow membership lives: find this
  // run by its child thread (or its background-task id when it has none) to
  // show the phase, e.g. "Refactor · Phase 2".
  const workflowLabel = useMemo(() => {
    if (detail === null) return null;
    const agents = projectedSubagentsToRuntime(detail.projection.subagents);
    const agent =
      (item.thread !== null
        ? agents.find((entry) => entry.childThreadId === item.thread?.id)
        : undefined) ??
      (item.taskId !== null ? agents.find((entry) => entry.id === item.taskId) : undefined);
    if (agent === undefined) return null;
    if (agent.workflowName !== null && agent.phaseTitle !== null) {
      return `${agent.workflowName} · ${agent.phaseTitle}`;
    }
    return agent.workflowName ?? agent.phaseTitle;
  }, [detail, item.thread, item.taskId]);

  const target = item.thread ?? item.parentThread;
  const status = STATUS_BADGE[item.status];
  const relative = formatRelativeTimeLabel(item.completedAt ?? item.updatedAt);

  return (
    <WatchWidgetRow
      title={item.title}
      onOpen={() => {
        if (target !== null) props.onOpen(scopeThreadRef(props.environmentId, target.id));
      }}
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
          {workflowLabel !== null && (
            <span className="shrink-0 truncate text-2xs text-muted-foreground">
              {workflowLabel}
            </span>
          )}
          {item.parentThread !== null && (
            <span className="shrink-0 truncate text-2xs text-muted-foreground">
              {item.parentThread.title}
            </span>
          )}
          {item.status === "running" || item.status === "waiting" ? (
            <WatchElapsed startedAt={item.startedAt} />
          ) : (
            relative !== "" && (
              <span className="shrink-0 text-2xs text-muted-foreground">{relative}</span>
            )
          )}
        </>
      }
      actions={
        item.thread !== null && item.parentThread !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  aria-label={`Open parent thread ${item.parentThread.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (item.parentThread !== null) {
                      props.onOpen(scopeThreadRef(props.environmentId, item.parentThread.id));
                    }
                  }}
                />
              }
            >
              <ArrowUpLeftIcon />
            </TooltipTrigger>
            <TooltipPopup>Open parent thread</TooltipPopup>
          </Tooltip>
        ) : undefined
      }
    />
  );
}

/**
 * Subagent runs on the bound projects — live runs first, then recently
 * settled ones. Rows open the subagent's own thread; a run without one opens
 * its parent, and every row keeps the parent reachable through the corner
 * action.
 */
export function WatchSubagentRunsWidget(props: {
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
  const items = watchSubagentRunItems(props.threads, {
    projectId: props.projectId,
    maxItems,
  });

  if (items.length === 0) {
    return <WatchWidgetEmpty text="No subagent runs" />;
  }
  return (
    <WatchWidgetRows>
      {items.map((item, index) => (
        <SubagentRunRow
          key={item.id}
          environmentId={props.environmentId}
          item={item}
          projectTitle={
            props.showProjectBadge
              ? (props.projectTitleById.get((item.thread ?? item.parentThread)?.projectId ?? "") ??
                null)
              : null
          }
          withDetail={index < MAX_DETAIL_SUBSCRIPTIONS}
          onOpen={props.onOpenThread}
        />
      ))}
    </WatchWidgetRows>
  );
}
