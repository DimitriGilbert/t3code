import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { watchConnectorOriginLabel } from "@t3tools/client-runtime/state/watch-connectors";
import {
  watchAgentSourceId,
  type WatchAppMountState,
} from "@t3tools/client-runtime/state/watch-mounts";
import {
  resolveWatchThreadsProjectBinding,
  watchFirstPartyWidgetSpec,
} from "@t3tools/client-runtime/state/watch-pages";
import {
  resolveWatchConnectorSourceError,
  resolveWatchThreadsProjectError,
  watchActiveWorkItems,
  watchAttentionItems,
  watchConnectorHealthErrorState,
  watchRecentActivityThreads,
  watchScheduledTaskItems,
  watchScheduledTaskScheduleLabel,
  watchScheduledTaskTimingLabel,
  watchSubagentRunItems,
  watchWidgetSettingBoolean,
  watchWidgetSettingNumber,
  type WatchActiveWorkKind,
  type WatchAttentionReason,
  type WatchSubagentRunStatus,
} from "@t3tools/client-runtime/state/watch-widgets";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { ProjectId } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ScopedThreadRef,
  WatchConnectorInstance,
  WatchConnectorInstallRequest,
  WatchPackWidgetSource,
  WatchPage,
  WatchWidget,
  WatchWidgetId,
} from "@t3tools/contracts";
import { Alert } from "react-native";
import { View } from "react-native";
import type { ReactNode } from "react";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { RowPressable } from "../../components/RowPressable";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { watchEnvironment } from "../../state/watch";

import { WatchAppWidget } from "./WatchAppWidget";
import { WatchWidgetErrorBody } from "./WatchWidgetSection";

/**
 * The mount governance an `agent:<sourceId>` widget obeys — wired by the
 * screen through `useWatchAppMounts`.
 */
export interface WatchAppMountControls {
  readonly stateOf: (widgetId: WatchWidgetId) => WatchAppMountState;
  readonly reportVisibility: (widgetId: WatchWidgetId, visible: boolean) => void;
  readonly requestMount: (widgetId: WatchWidgetId) => void;
}

/**
 * The live body of one first-party widget, rendered as native list rows —
 * the mobile twin of web's `WatchWidgetBody`. Source errors degrade to the
 * typed `WatchWidgetErrorBody`; agent kinds are rendered by `WatchAppWidget`
 * (the caller gates them on `watchAgentWidgetsMobile` before they reach here).
 */

// ── Shared rows ───────────────────────────────────────────────────────

const PILL_TONES = {
  neutral: {
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-secondary",
  },
  info: {
    pillClassName: "bg-update",
    textClassName: "text-update-foreground",
  },
  warning: {
    pillClassName: "bg-warning",
    textClassName: "text-warning-foreground",
  },
  danger: {
    pillClassName: "bg-danger",
    textClassName: "text-danger-foreground",
  },
  success: {
    pillClassName: "bg-adaptive-emerald-500-a12-a16",
    textClassName: "text-adaptive-emerald-700-300",
  },
} as const;

type WatchPillTone = keyof typeof PILL_TONES;

function WatchWidgetEmpty(props: { readonly text: string }) {
  return (
    <View className="items-center px-4 py-6">
      <Text className="text-xs text-foreground-muted">{props.text}</Text>
    </View>
  );
}

function WatchWidgetRow(props: {
  readonly title: string;
  readonly meta?: ReactNode;
  /** Detail line under the title (e.g. an error or rollback note). */
  readonly detail?: ReactNode;
  readonly right?: ReactNode;
  readonly dimmed?: boolean;
  readonly onPress?: () => void;
}) {
  return (
    <RowPressable
      onPress={props.onPress}
      disabled={props.onPress === undefined}
      className={cn("flex-row items-center gap-2 px-3 py-2.5", props.dimmed && "opacity-60")}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.meta === undefined ? null : (
          <View className="flex-row items-center gap-1.5">{props.meta}</View>
        )}
        {props.detail}
      </View>
      {props.right}
    </RowPressable>
  );
}

function WatchPill(props: { readonly label: string; readonly tone: WatchPillTone }) {
  const tone = PILL_TONES[props.tone];
  return (
    <StatusPill
      label={props.label}
      pillClassName={tone.pillClassName}
      textClassName={tone.textClassName}
      size="compact"
    />
  );
}

function ProjectBadge(props: { readonly title: string | null }) {
  if (props.title === null) return null;
  return (
    <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
      {props.title}
    </Text>
  );
}

// ── Active work ────────────────────────────────────────────────────────

const ACTIVE_WORK_PRESENTATION: Record<
  WatchActiveWorkKind,
  { readonly label: string; readonly tone: WatchPillTone }
> = {
  "awaiting-input": { label: "Awaiting input", tone: "warning" },
  "awaiting-approval": { label: "Needs approval", tone: "warning" },
  "plan-ready": { label: "Plan ready", tone: "info" },
  running: { label: "Running", tone: "info" },
};

function WatchActiveWorkRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ReturnType<typeof watchActiveWorkItems>[number];
  readonly projectTitle: string | null;
  readonly showStop: boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const { thread, kind, startedAt } = props.item;
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const presentation = ACTIVE_WORK_PRESENTATION[kind];
  const stoppable = threadRuntimeIsActive(thread.runtime);

  const onStop = async () => {
    const result = await interruptTurn({
      environmentId: props.environmentId,
      input: { threadId: thread.id },
    });
    if (!AsyncResult.isSuccess(result)) {
      const error = squashAtomCommandFailure(result);
      Alert.alert(
        "Could not stop the thread",
        error instanceof Error ? error.message : "The interrupt request failed.",
      );
    }
  };

  return (
    <WatchWidgetRow
      title={thread.title}
      onPress={() => props.onOpen(scopeThreadRef(props.environmentId, thread.id))}
      meta={
        <>
          <WatchPill label={presentation.label} tone={presentation.tone} />
          <ProjectBadge title={props.projectTitle} />
          {startedAt === null ? null : (
            <Text className="text-2xs text-foreground-muted">{relativeTime(startedAt)}</Text>
          )}
        </>
      }
      right={
        props.showStop && stoppable ? (
          <RowPressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${thread.title}`}
            onPress={() => void onStop()}
            className="size-8 items-center justify-center rounded-full"
          >
            <SymbolView name="stop.fill" size={14} tintColorClassName="accent-danger-foreground" />
          </RowPressable>
        ) : undefined
      }
    />
  );
}

// ── Needs attention ────────────────────────────────────────────────────

const ATTENTION_PRESENTATION: Record<
  WatchAttentionReason,
  { readonly label: string; readonly tone: WatchPillTone }
> = {
  failed: { label: "Failed", tone: "danger" },
  approval: { label: "Needs approval", tone: "warning" },
  input: { label: "Awaiting input", tone: "warning" },
  plan: { label: "Plan ready", tone: "info" },
  unread: { label: "Unread", tone: "info" },
  stale: { label: "Stale", tone: "warning" },
};

// ── Recent activity ────────────────────────────────────────────────────

const RUN_STATUS_TONE: Record<string, { readonly label: string; readonly tone: WatchPillTone }> = {
  completed: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  interrupted: { label: "Stopped", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  rolled_back: { label: "Rolled back", tone: "neutral" },
};

// ── Widget bodies ──────────────────────────────────────────────────────

function ActiveWorkBody(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const showStop = watchWidgetSettingBoolean(props.widget, "showStop", true);
  const items = watchActiveWorkItems(props.threads, { projectId: props.projectId, maxItems });
  if (items.length === 0) return <WatchWidgetEmpty text="No active work" />;
  return (
    <View>
      {items.map((item) => (
        <WatchActiveWorkRow
          key={item.thread.id}
          environmentId={props.environmentId}
          item={item}
          projectTitle={
            props.showProjectBadge
              ? (props.projectTitleById.get(item.thread.projectId) ?? null)
              : null
          }
          showStop={showStop}
          onOpen={props.onOpenThread}
        />
      ))}
    </View>
  );
}

function NeedsAttentionBody(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const staleAfterHours = watchWidgetSettingNumber(props.widget, "staleAfterHours", 24, {
    min: 1,
    max: 720,
  });
  const showSnoozed = watchWidgetSettingBoolean(props.widget, "showSnoozed", true);
  const { items, snoozed } = watchAttentionItems(props.threads, {
    projectId: props.projectId,
    now: props.now,
    staleAfterMs: staleAfterHours * 60 * 60 * 1000,
    maxItems,
  });
  const visible = showSnoozed ? [...items, ...snoozed] : items;
  if (visible.length === 0) return <WatchWidgetEmpty text="Nothing needs attention" />;
  return (
    <View>
      {visible.map((item) => {
        const snoozedRow = snoozed.includes(item);
        return (
          <WatchWidgetRow
            key={item.thread.id}
            title={item.thread.title}
            dimmed={snoozedRow}
            onPress={() => props.onOpenThread(scopeThreadRef(props.environmentId, item.thread.id))}
            meta={
              <>
                {item.reasons.slice(0, 2).map((reason) => {
                  const presentation = ATTENTION_PRESENTATION[reason];
                  return (
                    <WatchPill key={reason} label={presentation.label} tone={presentation.tone} />
                  );
                })}
                <ProjectBadge
                  title={
                    props.showProjectBadge
                      ? (props.projectTitleById.get(item.thread.projectId) ?? null)
                      : null
                  }
                />
                <Text className="text-2xs text-foreground-muted">
                  {relativeTime(item.thread.updatedAt)}
                </Text>
              </>
            }
          />
        );
      })}
    </View>
  );
}

function RecentActivityBody(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const items = watchRecentActivityThreads(props.threads, {
    projectId: props.projectId,
    maxItems,
  });
  if (items.length === 0) return <WatchWidgetEmpty text="No completed runs yet" />;
  return (
    <View>
      {items.map((thread) => {
        const status = RUN_STATUS_TONE[thread.latestRun?.status ?? "completed"] ?? {
          label: "Done",
          tone: "success" as const,
        };
        const completedAt = thread.latestRun?.completedAt ?? thread.updatedAt;
        return (
          <WatchWidgetRow
            key={thread.id}
            title={thread.title}
            onPress={() => props.onOpenThread(scopeThreadRef(props.environmentId, thread.id))}
            meta={
              <>
                <WatchPill label={status.label} tone={status.tone} />
                <ProjectBadge
                  title={
                    props.showProjectBadge
                      ? (props.projectTitleById.get(thread.projectId) ?? null)
                      : null
                  }
                />
                <Text className="text-2xs text-foreground-muted">{relativeTime(completedAt)}</Text>
              </>
            }
          />
        );
      })}
    </View>
  );
}

/**
 * The mobile task starter opens the existing composer flow — bound widgets go
 * straight to the project draft, unbound ones to the project picker. Mobile
 * has no in-widget compose box; task creation stays single-sourced in the
 * new-task sheet.
 */
function TaskStarterBody(props: {
  readonly widget: WatchWidget;
  readonly projectId: ProjectId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onNewTask: (projectId: ProjectId | null) => void;
}) {
  if (props.projects.length === 0) {
    return <WatchWidgetEmpty text="No projects in this environment" />;
  }
  const project =
    props.projectId === null
      ? null
      : (props.projects.find((entry) => entry.id === props.projectId) ?? null);
  return (
    <WatchWidgetRow
      title={project === null ? "New task" : `New task in ${project.title}`}
      onPress={() => props.onNewTask(props.projectId)}
      meta={
        <Text className="text-2xs text-foreground-muted">
          {project === null ? "Choose a project" : "Opens the composer"}
        </Text>
      }
      right={
        <SymbolView name="square.and.pencil" size={15} tintColorClassName="accent-icon-muted" />
      }
    />
  );
}

const HEALTH_TONE: Record<
  WatchConnectorInstance["health"]["status"],
  { readonly label: string; readonly tone: WatchPillTone }
> = {
  healthy: { label: "Healthy", tone: "success" },
  unhealthy: { label: "Down", tone: "danger" },
  authExpired: { label: "Auth expired", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral" },
};

/**
 * Connector rows stay read-only on mobile: health, pinned version, last
 * fetch, and a pending-approval row whose human-confirm dialog only exists on
 * desktop (the install gate is human-only, so the row says where to act).
 */
function ConnectorStatusBody(props: {
  readonly instances: ReadonlyArray<WatchConnectorInstance>;
  readonly installRequests: ReadonlyArray<WatchConnectorInstallRequest>;
  readonly connectorsReady: boolean;
  readonly connectorsError: string | null;
}) {
  const live = props.instances.filter((instance) => instance.archivedAt === null);
  const pending = props.installRequests.filter((request) => request.status === "pending");
  if (live.length === 0 && pending.length === 0) {
    if (!props.connectorsReady) return <WatchWidgetEmpty text="Loading connectors…" />;
    if (props.connectorsError !== null) {
      return <WatchWidgetEmpty text="Could not load connectors" />;
    }
    return <WatchWidgetEmpty text="No connectors installed" />;
  }
  return (
    <View>
      {pending.map((request) => (
        <WatchWidgetRow
          key={request.id}
          title={request.packId ?? watchConnectorOriginLabel(request.origin)}
          meta={
            <>
              <WatchPill
                label={request.kind === "install" ? "Install" : "Upgrade"}
                tone="warning"
              />
              <Text className="text-2xs text-foreground-muted">
                Awaits approval — review on desktop
              </Text>
            </>
          }
          right={
            <SymbolView
              name="exclamationmark.triangle"
              size={14}
              tintColorClassName="accent-warning-foreground"
            />
          }
        />
      ))}
      {live.map((instance) => {
        const health = HEALTH_TONE[instance.health.status];
        const rollback = instance.health.lastRollback;
        return (
          <WatchWidgetRow
            key={instance.id}
            title={instance.name ?? instance.packId}
            meta={
              <>
                <WatchPill label={health.label} tone={health.tone} />
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  {watchConnectorOriginLabel(instance.origin)} · v{instance.schemaVersion}
                </Text>
                <Text className="shrink-0 text-2xs text-foreground-muted">
                  {instance.health.lastFetchAt === null
                    ? "never fetched"
                    : relativeTime(instance.health.lastFetchAt)}
                </Text>
              </>
            }
            detail={
              <>
                {instance.health.lastError === null ? null : (
                  <Text className="text-2xs text-danger-foreground" numberOfLines={2}>
                    {instance.health.lastError}
                  </Text>
                )}
                {rollback === undefined ? null : (
                  <Text className="text-2xs text-foreground-muted">
                    Rolled back v{rollback.fromSchemaVersion} → v{rollback.toSchemaVersion},{" "}
                    {relativeTime(rollback.at)}
                  </Text>
                )}
              </>
            }
          />
        );
      })}
    </View>
  );
}

// ── Subagent runs ──────────────────────────────────────────────────────

const SUBAGENT_STATUS_TONE: Record<
  WatchSubagentRunStatus,
  { readonly label: string; readonly tone: WatchPillTone }
> = {
  running: { label: "Running", tone: "info" },
  waiting: { label: "Waiting", tone: "warning" },
  completed: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "neutral" },
};

/**
 * Live and recent subagent runs. Unlike web, rows stay shell-only here — no
 * per-thread projection subscriptions for workflow phase labels on a
 * dashboard. A run with its own thread opens there; a thread-less pending
 * run opens its parent.
 */
function SubagentRunsBody(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const items = watchSubagentRunItems(props.threads, {
    projectId: props.projectId,
    maxItems,
  });
  if (items.length === 0) return <WatchWidgetEmpty text="No subagent runs" />;
  return (
    <View>
      {items.map((item) => {
        const status = SUBAGENT_STATUS_TONE[item.status];
        const target = item.thread ?? item.parentThread;
        return (
          <WatchWidgetRow
            key={item.id}
            title={item.title}
            onPress={
              target === null
                ? undefined
                : () => props.onOpenThread(scopeThreadRef(props.environmentId, target.id))
            }
            meta={
              <>
                <WatchPill label={status.label} tone={status.tone} />
                <ProjectBadge
                  title={
                    props.showProjectBadge
                      ? (props.projectTitleById.get(
                          (item.thread ?? item.parentThread)?.projectId ?? "",
                        ) ?? null)
                      : null
                  }
                />
                {item.parentThread === null ? null : (
                  <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                    {item.parentThread.title}
                  </Text>
                )}
                <Text className="text-2xs text-foreground-muted">
                  {relativeTime(item.completedAt ?? item.updatedAt)}
                </Text>
              </>
            }
          />
        );
      })}
    </View>
  );
}

// ── Recent diffs ───────────────────────────────────────────────────────

/**
 * Recently finished threads whose checkpoint is the interesting part.
 * Mobile renders no diff totals — per-thread projection streams are too
 * heavy for the watch column — and the row opens the review sheet, the
 * mobile diff surface.
 */
function RecentDiffsBody(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly onOpenReview: (ref: ScopedThreadRef) => void;
}) {
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const items = watchRecentActivityThreads(props.threads, {
    projectId: props.projectId,
    maxItems,
  });
  if (items.length === 0) return <WatchWidgetEmpty text="No diffs yet" />;
  return (
    <View>
      {items.map((thread) => (
        <WatchWidgetRow
          key={thread.id}
          title={thread.title}
          onPress={() => props.onOpenReview(scopeThreadRef(props.environmentId, thread.id))}
          meta={
            <>
              <WatchPill label="Diff" tone="neutral" />
              <ProjectBadge
                title={
                  props.showProjectBadge
                    ? (props.projectTitleById.get(thread.projectId) ?? null)
                    : null
                }
              />
              <Text className="text-2xs text-foreground-muted">
                {relativeTime(thread.latestRun?.completedAt ?? thread.updatedAt)}
              </Text>
            </>
          }
          right={<SymbolView name="file.diff" size={15} tintColorClassName="accent-icon-muted" />}
        />
      ))}
    </View>
  );
}

// ── Scheduled tasks ────────────────────────────────────────────────────

const TASK_STATUS_TONE: Record<
  string,
  { readonly label: string; readonly tone: WatchPillTone } | null
> = {
  never: null,
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/**
 * Scheduled tasks on the bound projects over the shared
 * `scheduledTasksLive` subscription — failures lead, then soonest next run.
 * A task with a bound thread opens it; the rest open the scheduled-tasks
 * settings screen.
 */
function ScheduledTasksBody(props: {
  readonly environmentId: EnvironmentId;
  readonly widget: WatchWidget;
  readonly projectId: ProjectId | null;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly showProjectBadge: boolean;
  readonly now: string;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
  readonly onOpenScheduledTasks: () => void;
}) {
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
  const maxItems = watchWidgetSettingNumber(props.widget, "maxItems", 8, { min: 1, max: 20 });
  const items = watchScheduledTaskItems(tasksQuery.data.tasks, {
    projectId: props.projectId,
    maxItems,
  });
  if (items.length === 0) return <WatchWidgetEmpty text="No scheduled tasks" />;
  const nowMs = Date.parse(props.now);
  return (
    <View>
      {items.map((task) => {
        const status = TASK_STATUS_TONE[task.lastRunStatus] ?? null;
        return (
          <WatchWidgetRow
            key={task.id}
            title={task.title}
            onPress={
              task.threadId === null
                ? props.onOpenScheduledTasks
                : () => props.onOpenThread(scopeThreadRef(props.environmentId, task.threadId!))
            }
            meta={
              <>
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  {watchScheduledTaskScheduleLabel(task.schedule)}
                </Text>
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  {watchScheduledTaskTimingLabel(task, nowMs)}
                </Text>
                {status !== null && <WatchPill label={status.label} tone={status.tone} />}
              </>
            }
            detail={
              task.lastRunError === null ? undefined : (
                <Text className="text-2xs text-danger-foreground" numberOfLines={2}>
                  {task.lastRunError}
                </Text>
              )
            }
          />
        );
      })}
    </View>
  );
}

export function WatchWidgetBody(props: {
  readonly environmentId: EnvironmentId;
  readonly page: WatchPage;
  readonly widget: WatchWidget;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Minute-ticked clock for the attention widget's stale/age math. */
  readonly now: string;
  readonly connectorInstances: ReadonlyArray<WatchConnectorInstance>;
  /** Pack-registered widget sources — resolves `connectorMissing` for `pack:*` provenance. */
  readonly packWidgetSources: ReadonlyArray<WatchPackWidgetSource>;
  readonly installRequests: ReadonlyArray<WatchConnectorInstallRequest>;
  /** Mount governance for `agent:*` kinds; absent renders them unmounted. */
  readonly appMounts?: WatchAppMountControls;
  /**
   * True once the connectors query produced data. Until then a connector
   * binding's health is unknown, so source errors stay silent — resolving
   * against an empty list would flash `connectorMissing` on every mount.
   */
  readonly connectorsReady: boolean;
  readonly connectorsError: string | null;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
  /** Opens the thread's review sheet — the mobile diff surface. */
  readonly onOpenReview: (ref: ScopedThreadRef) => void;
  /** Opens the scheduled-tasks settings screen for thread-less tasks. */
  readonly onOpenScheduledTasks: () => void;
  readonly onNewTask: (projectId: ProjectId | null) => void;
}): ReactNode {
  const { widget, page } = props;
  const setConnectorInstanceConfig = useAtomCommand(watchEnvironment.setConnectorInstanceConfig, {
    reportFailure: false,
  });
  const spec = watchFirstPartyWidgetSpec(widget.kind);

  if (spec === undefined) {
    if (watchAgentSourceId(widget.kind) === undefined || props.appMounts === undefined) {
      return null;
    }
    return (
      <WatchAppWidget
        environmentId={props.environmentId}
        widget={widget}
        packWidgetSources={props.packWidgetSources}
        mountState={props.appMounts.stateOf(widget.id)}
        onVisibilityChange={(visible) => props.appMounts?.reportVisibility(widget.id, visible)}
        onRequestLoad={() => props.appMounts?.requestMount(widget.id)}
      />
    );
  }

  const boundProject = resolveWatchThreadsProjectBinding(page, widget);
  const boundProjectId = boundProject === null ? null : ProjectId.make(boundProject);
  const sourceError =
    resolveWatchThreadsProjectError(page, widget, props.projects) ??
    (props.connectorsReady
      ? resolveWatchConnectorSourceError(widget, props.connectorInstances)
      : null);
  const source = widget.config.source;
  const boundInstance =
    source?.kind === "connector" && source.binding !== undefined
      ? (props.connectorInstances.find((instance) => instance.id === source.binding) ?? null)
      : null;

  if (sourceError !== null) {
    return (
      <WatchWidgetErrorBody
        error={sourceError}
        {...(boundInstance !== null && watchConnectorHealthErrorState(boundInstance) !== null
          ? {
              onReconnect: () => {
                // Re-sending the stored config bumps updatedAt; the poller
                // restarts and forces a fresh fetch — the wire reconnect.
                void setConnectorInstanceConfig({
                  environmentId: props.environmentId,
                  input: { instanceId: boundInstance.id, config: boundInstance.config },
                }).then((result) => {
                  if (AsyncResult.isSuccess(result)) return;
                  const error = squashAtomCommandFailure(result);
                  Alert.alert(
                    "Could not reconnect",
                    error instanceof Error ? error.message : "The connector request failed.",
                  );
                });
              },
            }
          : {})}
      />
    );
  }

  const threadScope = {
    threads: props.threads,
    projectId: boundProjectId,
    projectTitleById: new Map(props.projects.map((project) => [project.id, project.title])),
    showProjectBadge: boundProjectId === null,
    onOpenThread: props.onOpenThread,
  } as const;

  switch (widget.kind) {
    case "active-work":
      return (
        <ActiveWorkBody environmentId={props.environmentId} widget={widget} {...threadScope} />
      );
    case "needs-attention":
      return (
        <NeedsAttentionBody
          environmentId={props.environmentId}
          widget={widget}
          now={props.now}
          {...threadScope}
        />
      );
    case "recent-activity":
      return (
        <RecentActivityBody environmentId={props.environmentId} widget={widget} {...threadScope} />
      );
    case "subagent-runs":
      return (
        <SubagentRunsBody environmentId={props.environmentId} widget={widget} {...threadScope} />
      );
    case "recent-diffs":
      return (
        <RecentDiffsBody
          environmentId={props.environmentId}
          widget={widget}
          {...threadScope}
          onOpenReview={props.onOpenReview}
        />
      );
    case "scheduled-tasks":
      return (
        <ScheduledTasksBody
          environmentId={props.environmentId}
          widget={widget}
          projectId={threadScope.projectId}
          projectTitleById={threadScope.projectTitleById}
          showProjectBadge={threadScope.showProjectBadge}
          now={props.now}
          onOpenThread={props.onOpenThread}
          onOpenScheduledTasks={props.onOpenScheduledTasks}
        />
      );
    case "task-starter":
      return (
        <TaskStarterBody
          widget={widget}
          projectId={boundProjectId}
          projects={props.projects}
          onNewTask={props.onNewTask}
        />
      );
    case "connector-status":
      return (
        <ConnectorStatusBody
          instances={props.connectorInstances}
          installRequests={props.installRequests}
          connectorsReady={props.connectorsReady}
          connectorsError={props.connectorsError}
        />
      );
    default:
      return null;
  }
}
