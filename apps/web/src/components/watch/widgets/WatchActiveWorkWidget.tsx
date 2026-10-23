import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  watchActiveWorkItems,
  watchWidgetSettingBoolean,
  watchWidgetSettingNumber,
  type WatchActiveWorkKind,
} from "@t3tools/client-runtime/state/watch-widgets";
import type { EnvironmentId, ProjectId, ScopedThreadRef, WatchWidget } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  OctagonXIcon,
  ShieldAlertIcon,
  SquareIcon,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { useNowMinute } from "~/hooks/useNowMinute";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { threadEnvironment } from "~/state/threads";

import { WatchElapsed, WatchWidgetEmpty, WatchWidgetRow, WatchWidgetRows } from "./shared";

const KIND_PRESENTATION: Record<
  WatchActiveWorkKind,
  { readonly label: string; readonly badge: "info" | "warning" | "success" | "error" }
> = {
  "awaiting-input": { label: "Awaiting input", badge: "warning" },
  "awaiting-approval": { label: "Needs approval", badge: "warning" },
  "plan-ready": { label: "Plan ready", badge: "info" },
  running: { label: "Running", badge: "info" },
};

const KIND_ICON: Record<WatchActiveWorkKind, typeof SquareIcon> = {
  "awaiting-input": MessageCircleQuestionIcon,
  "awaiting-approval": ShieldAlertIcon,
  "plan-ready": CircleCheckIcon,
  running: SquareIcon,
};

function ActiveWorkRow(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell;
  readonly kind: WatchActiveWorkKind;
  readonly startedAt: string | null;
  readonly projectTitle: string | null;
  readonly showStop: boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const { thread } = props;
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const presentation = KIND_PRESENTATION[props.kind];
  const KindIcon = KIND_ICON[props.kind];
  const stoppable = threadRuntimeIsActive(thread.runtime);

  const onStop = async () => {
    const result = await interruptTurn({
      environmentId: props.environmentId,
      input: { threadId: thread.id },
    });
    if (!AsyncResult.isSuccess(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not stop the thread",
        description: error instanceof Error ? error.message : "The interrupt request failed.",
      });
    }
  };

  return (
    <WatchWidgetRow
      title={thread.title}
      onOpen={() => props.onOpen(scopeThreadRef(props.environmentId, thread.id))}
      meta={
        <>
          {props.projectTitle === null ? null : (
            <span className="max-w-24 shrink-0 truncate text-2xs text-muted-foreground">
              {props.projectTitle}
            </span>
          )}
          <Badge size="sm" variant={presentation.badge}>
            <KindIcon className="size-2.5" />
            {presentation.label}
          </Badge>
          <WatchElapsed startedAt={props.startedAt} />
        </>
      }
      actions={
        props.showStop && stoppable ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-destructive"
                  size="icon-tiny"
                  aria-label={`Stop ${thread.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onStop();
                  }}
                />
              }
            >
              <OctagonXIcon />
            </TooltipTrigger>
            <TooltipPopup>Stop the active run</TooltipPopup>
          </Tooltip>
        ) : undefined
      }
    />
  );
}

/**
 * Threads in flight on this widget's project scope: running runs first-row
 * with elapsed time, plus threads parked on a user decision. Rows open the
 * thread; the stop affordance interrupts the active run in place.
 */
export function WatchActiveWorkWidget(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  // Tick the minute clock so elapsed/wait labels stay honest without polling.
  useNowMinute();
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const showStop = watchWidgetSettingBoolean(props.widget, "showStop", true);
  const items = watchActiveWorkItems(props.threads, {
    projectId: props.projectId,
    maxItems,
  });

  if (items.length === 0) {
    return <WatchWidgetEmpty text="No active work" />;
  }
  return (
    <WatchWidgetRows>
      {items.map((item) => (
        <ActiveWorkRow
          key={item.thread.id}
          environmentId={props.environmentId}
          thread={item.thread}
          kind={item.kind}
          startedAt={item.startedAt}
          projectTitle={
            props.showProjectBadge
              ? (props.projectTitleById.get(item.thread.projectId) ?? null)
              : null
          }
          showStop={showStop}
          onOpen={props.onOpenThread}
        />
      ))}
    </WatchWidgetRows>
  );
}
