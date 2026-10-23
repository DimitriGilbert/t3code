import { useRouter } from "@tanstack/react-router";
import {
  watchScheduledTaskItems,
  watchScheduledTaskScheduleLabel,
  watchScheduledTaskTimingLabel,
  watchWidgetSettingNumber,
} from "@t3tools/client-runtime/state/watch-widgets";
import type { EnvironmentId, ProjectId, ScheduledTask, WatchWidget } from "@t3tools/contracts";

import { Badge } from "~/components/ui/badge";
import { useNowMinute } from "~/hooks/useNowMinute";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";

import { WatchWidgetEmpty, WatchWidgetRow, WatchWidgetRows } from "./shared";

const STATUS_BADGE: Record<
  ScheduledTask["lastRunStatus"],
  { readonly label: string; readonly variant: "success" | "error" | "info" | "outline" } | null
> = {
  never: null,
  running: { label: "Running", variant: "info" },
  succeeded: { label: "Succeeded", variant: "success" },
  failed: { label: "Failed", variant: "error" },
};

/**
 * The environment's scheduled tasks as watch rows: failures lead, then
 * enabled tasks by soonest run, paused tasks last. The list rides the
 * existing `scheduledTasksLive` subscription — the widget adds no wire
 */
export function WatchScheduledTasksWidget(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
}) {
  const router = useRouter();
  const nowIso = useNowMinute();
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );

  if (tasksQuery.data === null) {
    return (
      <WatchWidgetEmpty
        text={
          tasksQuery.error !== null ? "Could not load scheduled tasks" : "Loading scheduled tasks…"
        }
      />
    );
  }
  const items = watchScheduledTaskItems(tasksQuery.data.tasks, {
    projectId: props.projectId,
    maxItems,
  });
  if (items.length === 0) {
    return <WatchWidgetEmpty text="No scheduled tasks" />;
  }
  // Minute-granularity ticks keep the "In 5m" countdowns honest without polling.
  const nowMs = Date.parse(`${nowIso}:00.000Z`);
  return (
    <WatchWidgetRows>
      {items.map((task) => {
        const status = STATUS_BADGE[task.lastRunStatus];
        return (
          <WatchWidgetRow
            key={task.id}
            title={task.title}
            onOpen={() =>
              void router.navigate({
                to: "/settings/scheduled-tasks",
                search: { environmentId: props.environmentId, taskId: task.id },
              })
            }
            meta={
              <>
                {props.showProjectBadge ? (
                  <span className="max-w-24 shrink-0 truncate text-2xs text-muted-foreground">
                    {props.projectTitleById.get(task.projectId) ?? ""}
                  </span>
                ) : null}
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {watchScheduledTaskScheduleLabel(task.schedule)}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {watchScheduledTaskTimingLabel(task, nowMs)}
                </span>
                {status !== null && (
                  <Badge size="sm" variant={status.variant}>
                    {status.label}
                  </Badge>
                )}
                {task.lastRunError !== null && (
                  <span className="shrink-0 truncate text-2xs text-error-foreground">
                    {task.lastRunError}
                  </span>
                )}
              </>
            }
          />
        );
      })}
    </WatchWidgetRows>
  );
}
