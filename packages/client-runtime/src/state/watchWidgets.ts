import type {
  ScheduledTask,
  ScheduledTaskSchedule,
  WatchConnectorInstance,
  WatchPage,
  WatchWidget,
  WatchWidgetErrorState,
} from "@t3tools/contracts";
import {
  isUnknownUnionMember,
  ProjectId,
  WatchConnectorInstanceId,
  type UnknownUnionMember,
} from "@t3tools/contracts";

import {
  resolveThreadWorkingStartedAt,
  threadRuntimeIsActive,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "./models.ts";
import {
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";
import { effectiveSnoozed } from "./threadSettled.ts";
import { resolveWatchThreadsProjectBinding } from "./watchPages.ts";

/**
 * Pure derivation for the first-party watch widgets — the shared shell
 * subscriptions carry every field these helpers read, so widgets never add
 * wire traffic of their own. Web and mobile render the same lists.
 */

// ── Settings readers ──────────────────────────────────────────────────

type WidgetSettings = Readonly<Record<string, unknown>> | undefined;

function settingsOf(widget: Pick<WatchWidget, "config">): WidgetSettings {
  return widget.config.settings;
}

/** Integer-valued setting within `min`/`max`, falling back on any malformed value. */
export function watchWidgetSettingNumber(
  widget: Pick<WatchWidget, "config">,
  key: string,
  fallback: number,
  options: { readonly min?: number; readonly max?: number } = {},
): number {
  const raw = settingsOf(widget)?.[key];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.trunc(value);
  if (options.min !== undefined && clamped < options.min) return fallback;
  if (options.max !== undefined && clamped > options.max) return fallback;
  return clamped;
}

export function watchWidgetSettingString(
  widget: Pick<WatchWidget, "config">,
  key: string,
  fallback: string,
): string {
  const raw = settingsOf(widget)?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

/** One entry per non-empty line — the `stringList` control's stored shape. */
export function watchWidgetSettingStringList(
  widget: Pick<WatchWidget, "config">,
  key: string,
): ReadonlyArray<string> {
  const raw = settingsOf(widget)?.[key];
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  }
  if (typeof raw === "string") {
    return raw
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  return [];
}

/**
 * Boolean setting with a descriptor-driven default: `true` inverts only on an
 * explicit `false`, so a "persist"-cleared key and an absent one agree.
 */
export function watchWidgetSettingBoolean(
  widget: Pick<WatchWidget, "config">,
  key: string,
  fallback: boolean,
): boolean {
  const raw = settingsOf(widget)?.[key];
  return typeof raw === "boolean" ? raw : fallback;
}

// ── Error presentation ────────────────────────────────────────────────

/** The recovery actions a typed error can offer; the host wires each id to a real callback. */
export type WatchWidgetErrorActionId =
  | "reconnect"
  | "update-secret"
  | "configure"
  | "repoint"
  | "view-source"
  | "remove";

export interface WatchWidgetErrorPresentation {
  /** The one-line cause the error body renders. */
  readonly line: string;
  readonly variant: "default" | "error" | "warning";
  /** Primary recovery action, when the cause has one the host can perform. */
  readonly action?: {
    readonly id: WatchWidgetErrorActionId;
    readonly label: string;
    /** Per-cause button variant from the design's severity table. */
    readonly button: "outline" | "secondary" | "warning-outline";
  };
  /** Secondary affordance rendered beside the primary action when present. */
  readonly secondaryAction?: {
    readonly id: WatchWidgetErrorActionId;
    readonly label: string;
  };
}

/** The members of {@link WatchWidgetErrorState} this build knows — what the resolvers below construct. */
export type KnownWatchWidgetErrorState = Exclude<WatchWidgetErrorState, UnknownUnionMember>;

/**
 * The copy table for `WatchWidgetErrorState` — one line and one primary
 * recovery per cause, per the watch-screen design's severity table.
 * Returns `action` only when the cause has an in-widget fix; the caller
 * suppresses actions it cannot perform (e.g. no connector binding to
 * reconnect, or a read-only page where the configure form never opens).
 */
export function watchWidgetErrorPresentation(
  error: WatchWidgetErrorState,
): WatchWidgetErrorPresentation {
  // A cause a newer server adds decodes as an unknown member; it gets the
  // generic warning — there is no copy or recovery action tabled for it.
  if (isUnknownUnionMember(error)) {
    return { line: "Widget error", variant: "warning" };
  }
  switch (error.cause) {
    case "connectorDown":
      return {
        line: "Connector unreachable",
        variant: "warning",
        action: { id: "reconnect", label: "Reconnect", button: "secondary" },
        secondaryAction: { id: "configure", label: "Connector settings" },
      };
    case "credentialsInvalid":
      return {
        line: "Credentials rejected",
        variant: "error",
        action: { id: "update-secret", label: "Update secret", button: "warning-outline" },
      };
    case "configMismatch":
      return {
        line:
          error.field === undefined
            ? "Config needs attention"
            : `Config needs attention — ${error.field}`,
        variant: "warning",
        action: { id: "configure", label: "Fix configuration", button: "secondary" },
      };
    case "connectorMissing":
      // Placeholder, not an alarm — the widget's config stays editable.
      return {
        line: "Connector pack not installed",
        variant: "default",
        action: { id: "configure", label: "Repoint source", button: "outline" },
      };
    case "connectorSnapshotTooLarge":
      return {
        line: "Data too large to show",
        variant: "warning",
        action: { id: "configure", label: "Open connector settings", button: "secondary" },
      };
    case "projectMissing":
      return {
        line: "Project was removed",
        variant: "default",
        action: { id: "repoint", label: "Repoint source", button: "outline" },
      };
    case "transpileFailed":
      return {
        line: "Widget failed to build",
        variant: "error",
        action: { id: "view-source", label: "View source", button: "outline" },
      };
  }
}

// ── Source-resolution errors ──────────────────────────────────────────

/**
 * The threads binding names a project that no longer exists on this
 * environment — `projectMissing`, with the shell kept chrome-visible so the
 * widget stays repointable.
 */
export function resolveWatchThreadsProjectError(
  page: Pick<WatchPage, "scope" | "projectId">,
  widget: Pick<WatchWidget, "config">,
  projects: ReadonlyArray<EnvironmentProject>,
): KnownWatchWidgetErrorState | null {
  const binding = resolveWatchThreadsProjectBinding(page, widget);
  // null means "all projects" — unbound bindings can't go stale.
  if (binding === null) return null;
  return projects.some((project) => project.id === binding)
    ? null
    : { cause: "projectMissing", projectId: ProjectId.make(binding) };
}

/**
 * A connector-bound widget's instance health mapped onto the widget error
 * vocabulary. `archivedAt` or an absent row is `connectorMissing`; a reported
 * failure is `connectorDown`/`credentialsInvalid` with the last successful
 * fetch carried as `lastGoodDataAt`.
 */
export function resolveWatchConnectorSourceError(
  widget: Pick<WatchWidget, "config">,
  instances: ReadonlyArray<WatchConnectorInstance>,
): KnownWatchWidgetErrorState | null {
  const source = widget.config.source;
  if (source?.kind !== "connector" || source.binding === undefined) return null;
  const instance = instances.find((entry) => entry.id === source.binding);
  if (instance === undefined || instance.archivedAt !== null) {
    return {
      cause: "connectorMissing",
      instanceId: WatchConnectorInstanceId.make(source.binding),
    };
  }
  return watchConnectorHealthErrorState(instance);
}

/** Instance health as a widget error state, or null when the instance is fine. */
export function watchConnectorHealthErrorState(
  instance: WatchConnectorInstance,
): KnownWatchWidgetErrorState | null {
  const health = instance.health;
  if (health.status === "healthy" || health.status === "unknown") return null;
  const lastGoodDataAt = health.lastFetchAt === null ? {} : { lastGoodDataAt: health.lastFetchAt };
  if (health.status === "authExpired") {
    return { cause: "credentialsInvalid", instanceId: instance.id, ...lastGoodDataAt };
  }
  return { cause: "connectorDown", instanceId: instance.id, ...lastGoodDataAt };
}

// ── Active work ───────────────────────────────────────────────────────

export type WatchActiveWorkKind = "awaiting-input" | "awaiting-approval" | "plan-ready" | "running";

export interface WatchActiveWorkItem {
  readonly thread: EnvironmentThreadShell;
  readonly kind: WatchActiveWorkKind;
  /** When the current activity began, for the elapsed readout. */
  readonly startedAt: string | null;
}

function watchActiveWorkKind(thread: EnvironmentThreadShell): WatchActiveWorkKind {
  if (thread.hasPendingApprovals) return "awaiting-approval";
  if (thread.hasPendingUserInput) return "awaiting-input";
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    !threadRuntimeIsActive(thread.runtime)
  ) {
    return "plan-ready";
  }
  return "running";
}

/**
 * Threads in flight on the bound projects: running runs plus threads parked
 * on a user decision (input, approval, plan) — the watch surface shows them
 * because intervening is the point. Blocked threads lead; both groups keep
 * the Working-section ordering (most recent user message first).
 */
export function watchActiveWorkItems(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: { readonly projectId: string | null; readonly maxItems?: number },
): ReadonlyArray<WatchActiveWorkItem> {
  const scoped = threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      (options.projectId === null || thread.projectId === options.projectId),
  );
  const blocked = scoped.filter(
    (thread) => thread.hasPendingUserInput || thread.hasPendingApprovals,
  );
  const planReady = scoped.filter(
    (thread) =>
      !thread.hasPendingUserInput &&
      !thread.hasPendingApprovals &&
      watchActiveWorkKind(thread) === "plan-ready",
  );
  const working = scoped.filter(
    (thread) =>
      !thread.hasPendingUserInput &&
      !thread.hasPendingApprovals &&
      watchActiveWorkKind(thread) === "running" &&
      isThreadWorking(thread),
  );
  const ordered = [
    ...sortInboxThreadsByReturn(blocked),
    ...sortInboxThreadsByReturn(planReady),
    ...sortWorkingThreadsBySend(working),
  ];
  return ordered.slice(0, options.maxItems ?? 8).map((thread) => ({
    thread,
    kind: watchActiveWorkKind(thread),
    startedAt: resolveThreadWorkingStartedAt(thread),
  }));
}

// ── Needs attention ───────────────────────────────────────────────────

export type WatchAttentionReason = "failed" | "approval" | "input" | "plan" | "unread" | "stale";

export interface WatchAttentionItem {
  readonly thread: EnvironmentThreadShell;
  /** Every active reason, most severe first — the row badges the first two. */
  readonly reasons: ReadonlyArray<WatchAttentionReason>;
}

const THREAD_RUNTIME_FAILED = new Set(["failed", "error"]);

/**
 * One completed run the user never saw: the thread's latest run finished
 * after the visited watermark. Mirrors `hasUnseenCompletion` — a thread that
 * was never opened reads as fresh, not unread.
 */
function watchThreadHasUnseenCompletion(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
): boolean {
  const completedAt =
    thread.latestRun?.completedAt === null || thread.latestRun?.completedAt === undefined
      ? null
      : Date.parse(thread.latestRun.completedAt);
  if (completedAt === null || Number.isNaN(completedAt)) return false;
  if (lastVisitedAt === undefined || lastVisitedAt === null) return false;
  const visitedAt = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedAt)) return true;
  return completedAt > visitedAt;
}

function watchAttentionReasons(
  thread: EnvironmentThreadShell,
  options: {
    readonly now: string;
    readonly staleAfterMs: number;
    readonly lastVisitedAt?: (thread: EnvironmentThreadShell) => string | undefined;
  },
): ReadonlyArray<WatchAttentionReason> {
  const reasons: WatchAttentionReason[] = [];
  const runtime = thread.runtime;
  const runtimeFailed = runtime !== null && THREAD_RUNTIME_FAILED.has(runtime.status);
  // A fresh run outranks the stale failure — a recovered thread isn't failed.
  if (runtimeFailed || (thread.latestRun?.status === "failed" && !isThreadWorking(thread))) {
    reasons.push("failed");
  }
  if (thread.hasPendingApprovals) reasons.push("approval");
  if (thread.hasPendingUserInput) reasons.push("input");
  if (thread.hasActionableProposedPlan) reasons.push("plan");
  const lastVisitedAt =
    options.lastVisitedAt === undefined
      ? (thread.lastVisitedAt ?? undefined)
      : options.lastVisitedAt(thread);
  if (watchThreadHasUnseenCompletion(thread, lastVisitedAt)) reasons.push("unread");
  const updatedAtMs = runtime === null ? NaN : Date.parse(runtime.updatedAt);
  if (
    threadRuntimeIsActive(runtime) &&
    Number.isFinite(updatedAtMs) &&
    Date.parse(options.now) - updatedAtMs > options.staleAfterMs
  ) {
    reasons.push("stale");
  }
  return reasons;
}

/**
 * The attention list: failed, blocked, unread, and stalled threads on the
 * bound projects, newest-returned first. Settled threads are out — settling
 * is the "I handled it" signal — except when the agent is blocked on the
 * user, which always outranks settle. Snoozed threads with no raised hand
 * collect under `snoozed` so the widget can show wake times without noise.
 */
export function watchAttentionItems(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: {
    readonly projectId: string | null;
    readonly now: string;
    readonly staleAfterMs: number;
    readonly maxItems?: number;
    readonly lastVisitedAt?: (thread: EnvironmentThreadShell) => string | undefined;
  },
): {
  readonly items: ReadonlyArray<WatchAttentionItem>;
  readonly snoozed: ReadonlyArray<WatchAttentionItem>;
} {
  const items: WatchAttentionItem[] = [];
  const snoozed: WatchAttentionItem[] = [];
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    if (options.projectId !== null && thread.projectId !== options.projectId) continue;
    const reasons = watchAttentionReasons(thread, options);
    if (reasons.length === 0) continue;
    const blocked = thread.hasPendingApprovals || thread.hasPendingUserInput;
    // Settled threads only resurface for a genuine block.
    if (thread.settledOverride === "settled" && !blocked) continue;
    const item: WatchAttentionItem = { thread, reasons };
    if (effectiveSnoozed(thread, { now: options.now })) {
      snoozed.push(item);
    } else {
      items.push(item);
    }
  }
  const maxItems = options.maxItems ?? 8;
  return {
    items: sortInboxThreadsByReturn(items.map((item) => item.thread))
      .slice(0, maxItems)
      .map((thread) => items.find((item) => item.thread === thread)!),
    snoozed: sortInboxThreadsByReturn(snoozed.map((item) => item.thread)).map((thread) =>
      snoozed.find((item) => item.thread === thread)!,
    ),
  };
}

// ── Recent activity ───────────────────────────────────────────────────

/**
 * Threads whose latest run reached a terminal state, newest completion
 * first. Checkpoint/diff detail for each row derives from the shared thread
 * projection (`deriveThreadCheckpointSummaries`) in the client.
 */
export function watchRecentActivityThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: { readonly projectId: string | null; readonly maxItems?: number },
): ReadonlyArray<EnvironmentThreadShell> {
  const completedAtMs = (thread: EnvironmentThreadShell): number => {
    const completedAt = thread.latestRun?.completedAt;
    const parsed =
      completedAt === null || completedAt === undefined ? NaN : Date.parse(completedAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        (options.projectId === null || thread.projectId === options.projectId) &&
        completedAtMs(thread) > 0,
    )
    .sort(
      (a, b) =>
        completedAtMs(b) - completedAtMs(a) ||
        a.id.localeCompare(b.id) ||
        a.environmentId.localeCompare(b.environmentId),
    )
    .slice(0, options.maxItems ?? 8);
}

// ── Subagent runs ─────────────────────────────────────────────────────

/**
 * The coarse status the widget badges: `waiting` keeps its own pill because
 * it means the run parked on something; the remaining terminal states fold
 * into `stopped` — only `failed` earns a red badge.
 */
export type WatchSubagentRunStatus = "running" | "waiting" | "completed" | "failed" | "stopped";

export interface WatchSubagentRunItem {
  /** Stable row key: the child thread id, or `parentId:taskId` for a thread-less task. */
  readonly id: string;
  readonly title: string;
  readonly status: WatchSubagentRunStatus;
  /** The subagent's own thread — the row's primary open target when present. */
  readonly thread: EnvironmentThreadShell | null;
  /** The spawning thread; thread-less rows open here. Null when it left the shell list. */
  readonly parentThread: EnvironmentThreadShell | null;
  /** Background-task id when the row came from a parent's pending roster. */
  readonly taskId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

function watchSubagentRunStatusOf(thread: EnvironmentThreadShell): WatchSubagentRunStatus {
  const status = thread.runtime?.status ?? thread.latestRun?.status ?? "idle";
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
    default:
      return "completed";
  }
}

/**
 * Subagent runs on the bound projects, read entirely from the shell
 * projection: a subagent that owns a thread shows up under
 * `lineage.relationshipToParent === "subagent"`, and one still running
 * without a thread shows up in its parent's `pendingBackgroundTasks`
 * roster. Running/waiting rows lead, then recently settled, newest
 * activity first.
 */
export function watchSubagentRunItems(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: { readonly projectId: string | null; readonly maxItems?: number },
): ReadonlyArray<WatchSubagentRunItem> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const inScope = (thread: EnvironmentThreadShell) =>
    thread.deletedAt === null &&
    thread.archivedAt === null &&
    (options.projectId === null || thread.projectId === options.projectId);

  const items: WatchSubagentRunItem[] = [];
  const rendered = new Set<string>();
  for (const thread of threads) {
    if (thread.lineage.relationshipToParent !== "subagent" || !inScope(thread)) continue;
    rendered.add(thread.id);
    const parentThreadId = thread.lineage.parentThreadId;
    items.push({
      id: thread.id,
      title: thread.title,
      status: watchSubagentRunStatusOf(thread),
      thread,
      parentThread: parentThreadId === null ? null : (byId.get(parentThreadId) ?? null),
      taskId: null,
      startedAt: resolveThreadWorkingStartedAt(thread) ?? thread.latestRun?.startedAt ?? null,
      completedAt: thread.latestRun?.completedAt ?? null,
      updatedAt: thread.updatedAt,
    });
  }
  // A provider-side subagent that never got its own thread is only visible
  // as a pending background task on the parent; the row opens the parent.
  for (const parent of threads) {
    if (!inScope(parent)) continue;
    for (const task of parent.pendingBackgroundTasks) {
      if (task.kind !== "subagent") continue;
      if (task.childThreadId !== undefined && rendered.has(task.childThreadId)) continue;
      items.push({
        id: `${parent.id}:${task.taskId}`,
        title: task.description ?? "Subagent",
        status: "running",
        thread: null,
        parentThread: parent,
        taskId: task.taskId,
        startedAt: null,
        completedAt: null,
        updatedAt: parent.updatedAt,
      });
    }
  }
  const rank = (item: WatchSubagentRunItem) =>
    item.status === "running" || item.status === "waiting" ? 0 : 1;
  return items
    .sort(
      (a, b) =>
        rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    .slice(0, options.maxItems ?? 8);
}

// ── Scheduled tasks ───────────────────────────────────────────────────

const WEEKDAY_SHORT_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Short trigger description shared by the web and mobile widget bodies. */
export function watchScheduledTaskScheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_SHORT_LABELS[day] ?? String(day)).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * The timing readout beside the schedule: paused and webhook-listening tasks
 * have no next fire time, so they report their state instead of a countdown.
 */
export function watchScheduledTaskTimingLabel(
  task: Pick<ScheduledTask, "enabled" | "schedule" | "nextRunAt">,
  nowMs: number,
): string {
  if (!task.enabled) return "Paused";
  if (task.schedule.type === "webhook") return "Listening";
  const nextMs = task.nextRunAt === null ? NaN : Date.parse(task.nextRunAt);
  if (Number.isNaN(nextMs)) return "Not scheduled";
  const diffMs = nextMs - nowMs;
  if (diffMs <= 0) return "Due now";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "In under a minute";
  if (minutes < 60) return `In ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `In ${hours}h`;
  return `In ${Math.round(hours / 24)}d`;
}

/**
 * Scheduled tasks on the bound projects: failures lead (a watch surface is
 * for noticing them), then enabled tasks by soonest next run — unscheduled
 * and webhook tasks trail — then paused tasks by name.
 */
export function watchScheduledTaskItems(
  tasks: ReadonlyArray<ScheduledTask>,
  options: { readonly projectId: string | null; readonly maxItems?: number },
): ReadonlyArray<ScheduledTask> {
  const timeMs = (value: string | null): number => {
    // Unparseable/absent timestamps sort as 0 — comparators must never see NaN.
    if (value === null) return 0;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const group = (task: ScheduledTask) =>
    task.lastRunStatus === "failed" ? 0 : task.enabled ? 1 : 2;
  return tasks
    .filter((task) => options.projectId === null || task.projectId === options.projectId)
    .sort((a, b) => {
      const groupDelta = group(a) - group(b);
      if (groupDelta !== 0) return groupDelta;
      if (group(a) === 0) {
        // Newest failure first.
        return timeMs(b.lastRunAt) - timeMs(a.lastRunAt) || a.title.localeCompare(b.title);
      }
      if (group(a) === 1) {
        // Soonest next run first; webhook/unscheduled tasks (null) trail.
        const aNext = a.nextRunAt === null ? Number.POSITIVE_INFINITY : timeMs(a.nextRunAt);
        const bNext = b.nextRunAt === null ? Number.POSITIVE_INFINITY : timeMs(b.nextRunAt);
        return aNext - bNext || a.title.localeCompare(b.title);
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, options.maxItems ?? 8);
}
