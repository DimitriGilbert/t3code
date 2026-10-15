import {
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  WatchConnectorInstanceId,
  WatchConnectorPackId,
  WatchPageId,
  WatchWidgetId,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  type WatchConnectorInstance,
  type WatchPage,
  type WatchWidget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell, scopeProject, type EnvironmentThreadShell } from "./models.ts";
import { v2Project, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
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
  watchWidgetErrorPresentation,
  watchWidgetSettingBoolean,
  watchWidgetSettingNumber,
  watchWidgetSettingStringList,
} from "./watchWidgets.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-v2");
const nowIso = "2026-06-20T12:00:00.000Z";

const page: WatchPage = {
  id: WatchPageId.make("page-1"),
  name: "Page",
  scope: "global",
  projectId: null,
  orderKey: "a",
  revision: 0,
  mobileRevision: 0,
  archivedAt: null,
  createdAt: nowIso,
  updatedAt: nowIso,
};

function makeWidget(config: WatchWidget["config"] = { source: { kind: "threads" } }): WatchWidget {
  return {
    id: WatchWidgetId.make("widget-1"),
    pageId: page.id,
    kind: "active-work",
    config,
    placement: { x: 0, y: 0, w: 4, h: 3 },
    revision: 0,
    mobileOrder: 0,
    mobileHidden: false,
    provenance: "firstParty",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function makeShell(overrides: Partial<OrchestrationV2ThreadShell> = {}): EnvironmentThreadShell {
  return presentThreadShell(environmentId, { ...v2ThreadShell, ...overrides });
}

function shellWith(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return { ...makeShell({ id: ThreadId.make(id) }), ...overrides };
}

function makeInstance(overrides: Partial<WatchConnectorInstance> = {}): WatchConnectorInstance {
  return {
    id: WatchConnectorInstanceId.make("inst-1"),
    packId: WatchConnectorPackId.make("pack-1"),
    schemaVersion: 1,
    config: {},
    configuredSecretKeys: [],
    origin: { kind: "httpsUrl", url: "https://example.com/pack" },
    contentHash: "abc123",
    health: {
      status: "healthy",
      lastError: null,
      lastFetchAt: "2026-06-20T11:00:00.000Z",
      consecutiveFailures: 0,
    },
    archivedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

const projects = [scopeProject(environmentId, v2Project)];

describe("watchWidgetSetting readers", () => {
  it("reads numbers within bounds and falls back on malformed values", () => {
    const widget = makeWidget({ settings: { maxItems: 5 } });
    expect(watchWidgetSettingNumber(widget, "maxItems", 8, { min: 1, max: 20 })).toBe(5);
    expect(
      watchWidgetSettingNumber(makeWidget({ settings: { maxItems: 99 } }), "maxItems", 8, {
        min: 1,
        max: 20,
      }),
    ).toBe(8);
    expect(
      watchWidgetSettingNumber(makeWidget({ settings: { maxItems: "nope" } }), "maxItems", 8),
    ).toBe(8);
    expect(watchWidgetSettingNumber(makeWidget(), "maxItems", 8)).toBe(8);
  });

  it("reads booleans only on an explicit stored value", () => {
    expect(
      watchWidgetSettingBoolean(makeWidget({ settings: { showStop: false } }), "showStop", true),
    ).toBe(false);
    expect(watchWidgetSettingBoolean(makeWidget(), "showStop", true)).toBe(true);
    expect(
      watchWidgetSettingBoolean(makeWidget({ settings: { showStop: "no" } }), "showStop", true),
    ).toBe(true);
  });

  it("splits stringList values into non-empty entries", () => {
    const widget = makeWidget({ settings: { templates: "one\n\n two \nthree" } });
    expect(watchWidgetSettingStringList(widget, "templates")).toEqual(["one", "two", "three"]);
    expect(
      watchWidgetSettingStringList(
        makeWidget({ settings: { templates: ["a", "", "b"] } }),
        "templates",
      ),
    ).toEqual(["a", "b"]);
    expect(watchWidgetSettingStringList(makeWidget(), "templates")).toEqual([]);
  });
});

describe("watchWidgetErrorPresentation", () => {
  it("gives every cause a line and its recovery action", () => {
    const instanceId = WatchConnectorInstanceId.make("inst-1");
    expect(watchWidgetErrorPresentation({ cause: "connectorDown", instanceId }).action?.id).toBe(
      "reconnect",
    );
    expect(
      watchWidgetErrorPresentation({ cause: "credentialsInvalid", instanceId }).action?.id,
    ).toBe("update-secret");
    expect(watchWidgetErrorPresentation({ cause: "configMismatch", field: "url" }).line).toContain(
      "url",
    );
    expect(watchWidgetErrorPresentation({ cause: "connectorMissing", instanceId }).variant).toBe(
      "default",
    );
    expect(watchWidgetErrorPresentation({ cause: "projectMissing", projectId }).action?.id).toBe(
      "repoint",
    );
    expect(watchWidgetErrorPresentation({ cause: "transpileFailed" }).action?.id).toBe(
      "view-source",
    );
    expect(
      watchWidgetErrorPresentation({ cause: "connectorSnapshotTooLarge", instanceId }).action?.id,
    ).toBe("configure");
  });
});

describe("resolveWatchThreadsProjectError", () => {
  it("flags a bound project that no longer exists", () => {
    const widget = makeWidget({ source: { kind: "threads", binding: "gone" } });
    const error = resolveWatchThreadsProjectError(page, widget, projects);
    expect(error?.cause).toBe("projectMissing");
  });

  it("treats unbound, all-projects, and live bindings as fine", () => {
    expect(resolveWatchThreadsProjectError(page, makeWidget(), projects)).toBeNull();
    expect(
      resolveWatchThreadsProjectError(
        page,
        makeWidget({ source: { kind: "threads", binding: "*" } }),
        projects,
      ),
    ).toBeNull();
    expect(
      resolveWatchThreadsProjectError(
        page,
        makeWidget({ source: { kind: "threads", binding: projectId } }),
        projects,
      ),
    ).toBeNull();
  });

  it("inherits the page's ambient project binding", () => {
    const projectPage: WatchPage = {
      ...page,
      scope: "project",
      projectId: ProjectId.make("deleted-project"),
    };
    // An unbound threads widget on a project page binds the page's project —
    // the deleted one — so the widget degrades rather than silently widening.
    const error = resolveWatchThreadsProjectError(projectPage, makeWidget(), projects);
    expect(error?.cause).toBe("projectMissing");
  });
});

describe("resolveWatchConnectorSourceError", () => {
  const connectorWidget = () => makeWidget({ source: { kind: "connector", binding: "inst-1" } });

  it("maps a missing or archived instance to connectorMissing", () => {
    expect(resolveWatchConnectorSourceError(connectorWidget(), [])?.cause).toBe("connectorMissing");
    expect(
      resolveWatchConnectorSourceError(connectorWidget(), [makeInstance({ archivedAt: nowIso })])
        ?.cause,
    ).toBe("connectorMissing");
  });

  it("maps auth expiry to credentialsInvalid with the last-good fetch", () => {
    const error = resolveWatchConnectorSourceError(connectorWidget(), [
      makeInstance({
        health: {
          status: "authExpired",
          lastError: "401",
          lastFetchAt: "2026-06-20T11:00:00.000Z",
          consecutiveFailures: 3,
        },
      }),
    ]);
    expect(error?.cause).toBe("credentialsInvalid");
    expect(error && "lastGoodDataAt" in error ? error.lastGoodDataAt : undefined).toBe(
      "2026-06-20T11:00:00.000Z",
    );
  });

  it("maps an unhealthy instance to connectorDown and leaves healthy alone", () => {
    expect(
      resolveWatchConnectorSourceError(connectorWidget(), [
        makeInstance({
          health: {
            status: "unhealthy",
            lastError: "timeout",
            lastFetchAt: null,
            consecutiveFailures: 1,
          },
        }),
      ])?.cause,
    ).toBe("connectorDown");
    expect(resolveWatchConnectorSourceError(connectorWidget(), [makeInstance()])).toBeNull();
    expect(watchConnectorHealthErrorState(makeInstance())).toBeNull();
  });
});

describe("watchActiveWorkItems", () => {
  it("leads with threads blocked on the user, then running threads", () => {
    const running = shellWith("running", {
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: makeShell().providerInstanceId,
        providerName: null,
        lastError: null,
        updatedAt: nowIso,
      },
      latestUserMessageAt: "2026-06-20T11:00:00.000Z",
    });
    const awaiting = shellWith("awaiting", {
      hasPendingUserInput: true,
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: makeShell().providerInstanceId,
        providerName: null,
        lastError: null,
        updatedAt: nowIso,
      },
      latestUserMessageAt: "2026-06-20T10:00:00.000Z",
    });
    const items = watchActiveWorkItems([running, awaiting], { projectId: null });
    expect(items[0]?.kind).toBe("awaiting-input");
    expect(items[1]?.kind).toBe("running");
  });

  it("filters to the bound project and honours maxItems", () => {
    const runningRuntime = {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: makeShell().providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: nowIso,
    };
    const other = shellWith("other", {
      projectId: ProjectId.make("other-project"),
      runtime: runningRuntime,
    });
    const scoped = shellWith("scoped", { runtime: runningRuntime });
    expect(
      watchActiveWorkItems([other, scoped], { projectId, maxItems: 1 }).map(
        (item) => item.thread.id,
      ),
    ).toEqual([scoped.id]);
  });
});

describe("watchAttentionItems", () => {
  it("classifies failed, blocked, and unread threads", () => {
    const failed = shellWith("failed", {
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: makeShell().providerInstanceId,
        providerName: null,
        lastError: "boom",
        updatedAt: nowIso,
      },
    });
    const blocked = shellWith("blocked", { hasPendingApprovals: true });
    const unread = shellWith("unread", {
      latestRun: {
        runId: failed.latestRun?.runId ?? ("run-1" as never),
        status: "completed",
        requestedAt: null,
        startedAt: null,
        completedAt: "2026-06-20T11:00:00.000Z",
        assistantMessageId: null,
      },
      lastVisitedAt: "2026-06-20T10:00:00.000Z",
    });
    const { items } = watchAttentionItems([failed, blocked, unread], {
      projectId: null,
      now: nowIso,
      staleAfterMs: 60_000,
    });
    const byId = new Map(items.map((item) => [item.thread.id, item.reasons]));
    expect(byId.get(failed.id)).toContain("failed");
    expect(byId.get(blocked.id)).toContain("approval");
    expect(byId.get(unread.id)).toContain("unread");
  });

  it("flags stale working threads only past the threshold", () => {
    const runtime = {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: makeShell().providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: "2026-06-20T08:00:00.000Z",
    };
    const stale = shellWith("stale", { runtime });
    const { items } = watchAttentionItems([stale], {
      projectId: null,
      now: nowIso,
      staleAfterMs: 60 * 60 * 1000,
    });
    expect(items[0]?.reasons).toContain("stale");
    const fresh = watchAttentionItems([stale], {
      projectId: null,
      now: nowIso,
      staleAfterMs: 24 * 60 * 60 * 1000,
    });
    expect(fresh.items).toHaveLength(0);
  });

  it("parks snoozed threads separately and keeps settled ones out", () => {
    // Stale is the quiet reason: no raised hand, so the snooze holds.
    const snoozed = shellWith("snoozed", {
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: makeShell().providerInstanceId,
        providerName: null,
        lastError: null,
        updatedAt: "2026-06-20T08:00:00.000Z",
      },
      snoozedUntil: "2026-06-21T00:00:00.000Z",
      snoozedAt: nowIso,
    });
    const settled = shellWith("settled", { settledOverride: "settled", settledAt: nowIso });
    const { items, snoozed: parked } = watchAttentionItems([snoozed, settled], {
      projectId: null,
      now: nowIso,
      staleAfterMs: 60_000,
    });
    expect(items).toHaveLength(0);
    expect(parked.map((item) => item.thread.id)).toEqual([snoozed.id]);
  });
});

describe("watchRecentActivityThreads", () => {
  it("lists completed runs newest-first and skips live threads", () => {
    const done = shellWith("done", {
      latestRun: {
        runId: "run-1" as never,
        status: "completed",
        requestedAt: null,
        startedAt: null,
        completedAt: "2026-06-20T11:00:00.000Z",
        assistantMessageId: null,
      },
    });
    const live = shellWith("live", { latestRun: null });
    expect(watchRecentActivityThreads([live, done], { projectId: null })).toEqual([done]);
  });
});

describe("watchSubagentRunItems", () => {
  const runningRuntime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: makeShell().providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: nowIso,
  };

  function subagentShell(id: string, parentId: string, overrides = {}) {
    return shellWith(id, {
      lineage: {
        rootThreadId: ThreadId.make(parentId),
        parentThreadId: ThreadId.make(parentId),
        relationshipToParent: "subagent" as const,
      },
      ...overrides,
    });
  }

  it("leads with running runs and folds thread-less pending tasks under their parent", () => {
    const parent = shellWith("parent", {
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Survey the repo", kind: "subagent" as const },
        { taskId: "bg-2", description: "npm run dev", kind: "command" as const },
      ],
    });
    const running = subagentShell("running-child", "parent", {
      runtime: runningRuntime,
      updatedAt: "2026-06-20T11:00:00.000Z",
    });
    const done = subagentShell("done-child", "parent", {
      updatedAt: "2026-06-20T10:30:00.000Z",
    });
    const items = watchSubagentRunItems([parent, running, done], { projectId: null });
    expect(items.map((item) => item.id)).toEqual([running.id, `${parent.id}:bg-1`, done.id]);
    const pending = items[1]!;
    expect(pending.thread).toBeNull();
    expect(pending.parentThread?.id).toBe(parent.id);
    expect(pending.status).toBe("running");
    expect(items[0]?.parentThread?.id).toBe(parent.id);
    expect(items[2]?.status).toBe("completed");
  });

  it("does not double-list a pending task whose child thread rendered", () => {
    const parent = shellWith("parent", {
      pendingBackgroundTasks: [
        {
          taskId: "bg-1",
          description: "Survey",
          kind: "subagent" as const,
          childThreadId: ThreadId.make("child"),
        },
      ],
    });
    const child = subagentShell("child", "parent", { runtime: runningRuntime });
    const items = watchSubagentRunItems([parent, child], { projectId: null });
    expect(items.map((item) => item.id)).toEqual([child.id]);
  });

  it("scopes to the bound project, pending rows by the parent's project", () => {
    const otherProject = ProjectId.make("project-other");
    const parent = shellWith("parent", {
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Survey", kind: "subagent" as const },
      ],
    });
    const inScope = subagentShell("child", "parent", { runtime: runningRuntime });
    const outOfScope = subagentShell("other-child", "parent", {
      projectId: otherProject,
      runtime: runningRuntime,
    });
    const items = watchSubagentRunItems([parent, inScope, outOfScope], { projectId });
    expect(items.map((item) => item.id)).toEqual([inScope.id, `${parent.id}:bg-1`]);
  });
});

describe("watchScheduledTaskItems", () => {
  function makeTask(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
      id: ScheduledTaskId.make(`task-${id}`),
      title: id,
      prompt: "Do the thing",
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: makeShell().providerInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: nowIso,
      updatedAt: nowIso,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      ...overrides,
    };
  }

  it("leads with failures, then enabled tasks by soonest next run, then paused", () => {
    const failed = makeTask("failed", {
      lastRunStatus: "failed",
      lastRunAt: "2026-06-20T11:00:00.000Z",
    });
    const soon = makeTask("soon", { nextRunAt: "2026-06-20T12:05:00.000Z" });
    const later = makeTask("later", { nextRunAt: "2026-06-20T13:00:00.000Z" });
    const webhook = makeTask("hook", {
      schedule: { type: "webhook", signature: null },
    });
    const paused = makeTask("paused", { enabled: false });
    const items = watchScheduledTaskItems([paused, later, webhook, failed, soon], {
      projectId: null,
    });
    expect(items.map((task) => task.title)).toEqual(["failed", "soon", "later", "hook", "paused"]);
  });

  it("filters to the bound project and honours maxItems", () => {
    const scoped = makeTask("a", { nextRunAt: "2026-06-20T12:05:00.000Z" });
    const other = makeTask("b", {
      projectId: ProjectId.make("project-other"),
      nextRunAt: "2026-06-20T12:01:00.000Z",
    });
    expect(
      watchScheduledTaskItems([other, scoped], { projectId }).map((task) => task.title),
    ).toEqual(["a"]);
    expect(
      watchScheduledTaskItems([scoped, other], { projectId: null, maxItems: 1 }).map(
        (task) => task.title,
      ),
    ).toEqual(["b"]);
  });
});

describe("watchScheduledTask labels", () => {
  it("describes interval, fixed_time, and webhook triggers", () => {
    expect(watchScheduledTaskScheduleLabel({ type: "interval", everyMs: 300_000 })).toBe(
      "Every 5 min",
    );
    expect(watchScheduledTaskScheduleLabel({ type: "interval", everyMs: 45_000 })).toBe(
      "Every 45 sec",
    );
    expect(watchScheduledTaskScheduleLabel({ type: "fixed_time", timeOfDay: "09:30" })).toBe(
      "Daily at 09:30",
    );
    expect(
      watchScheduledTaskScheduleLabel({
        type: "fixed_time",
        timeOfDay: "09:30",
        weekdays: [1, 2, 3, 4, 5],
      }),
    ).toBe("Weekdays at 09:30");
    expect(watchScheduledTaskScheduleLabel({ type: "webhook", signature: null })).toBe(
      "On webhook",
    );
  });

  it("reports paused, listening, and upcoming timing", () => {
    const now = Date.parse(nowIso);
    const base = {
      enabled: true,
      schedule: { type: "interval" as const, everyMs: 60_000 },
      nextRunAt: "2026-06-20T12:30:00.000Z",
    };
    expect(watchScheduledTaskTimingLabel(base, now)).toBe("In 30m");
    expect(watchScheduledTaskTimingLabel({ ...base, enabled: false }, now)).toBe("Paused");
    expect(
      watchScheduledTaskTimingLabel(
        { ...base, schedule: { type: "webhook", signature: null } },
        now,
      ),
    ).toBe("Listening");
    expect(watchScheduledTaskTimingLabel({ ...base, nextRunAt: null }, now)).toBe("Not scheduled");
    expect(
      watchScheduledTaskTimingLabel({ ...base, nextRunAt: "2026-06-20T11:00:00.000Z" }, now),
    ).toBe("Due now");
  });
});
