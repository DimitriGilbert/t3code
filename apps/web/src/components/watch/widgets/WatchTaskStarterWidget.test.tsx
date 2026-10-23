import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  WatchPageId,
  WatchWidgetId,
  type ServerProvider,
  type WatchWidget,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  startTurn: vi.fn(),
  toast: vi.fn(),
  query: {
    data: null as unknown,
    dataUpdatedAt: 0,
    error: null as string | null,
    failure: null as unknown,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  },
  // Mirrors ChatView.logic's sessionCheckoutIsRepo map so the test can seed
  // and inspect what the widget remembers between mounts.
  checkoutIsRepo: new Map<string, boolean>(),
}));

vi.mock("~/components/ChatView.logic", () => ({
  resolveSendEnvMode: (input: { requestedEnvMode: string; isGitRepo: boolean }) =>
    input.isGitRepo ? input.requestedEnvMode : "local",
  rememberCheckoutIsRepo: (environmentId: string, cwd: string, isRepo: boolean) => {
    state.checkoutIsRepo.set(JSON.stringify([environmentId, cwd]), isRepo);
  },
  recallCheckoutIsRepo: (environmentId: string, cwd: string | null) =>
    cwd === null ? undefined : state.checkoutIsRepo.get(JSON.stringify([environmentId, cwd])),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => state.query,
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: (args: unknown) => ({ kind: "vcs-status", args }) },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { startTurn: { label: "start-turn" } },
}));
vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.startTurn,
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () => new Map(),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    projectSettingsOverrides: {},
    defaultThreadEnvMode: "worktree",
  }),
}));
vi.mock("~/lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: vi.fn(async () => null),
}));
vi.mock("~/lib/utils", () => ({
  newThreadId: () => "thread-new",
  newMessageId: () => "message-new",
}));
vi.mock("~/components/ui/select", () => ({
  Select: ({ children }: { children?: ReactNode }) => children,
  SelectTrigger: ({ children }: { children?: ReactNode }) => children,
  SelectValue: () => null,
  SelectPopup: () => null,
  SelectItem: () => null,
}));
vi.mock("~/components/ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ render: _render, ...props }: { render?: ReactElement } & Record<string, unknown>) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.toast } }));

import { WatchTaskStarterWidget } from "./WatchTaskStarterWidget";
import { act } from "../../../../test/act";

const environmentId = EnvironmentId.make("env-1");
const nowIso = "2026-06-20T12:00:00.000Z";
const workspaceRoot = "/repo/watch-task-starter";

const widget: WatchWidget = {
  id: WatchWidgetId.make("widget-1"),
  pageId: WatchPageId.make("page-1"),
  kind: "task-starter",
  config: { settings: {} },
  placement: { x: 0, y: 0, w: 4, h: 3 },
  revision: 0,
  mobileOrder: 0,
  mobileHidden: false,
  provenance: "firstParty",
  createdAt: nowIso,
  updatedAt: nowIso,
};

const project: EnvironmentProject = {
  environmentId,
  id: ProjectId.make("project-1"),
  title: "Demo",
  workspaceRoot,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: nowIso,
  updatedAt: nowIso,
};

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("provider-1"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: nowIso,
  models: [
    { slug: "model-1", name: "Model One", isCustom: false, capabilities: null, isDefault: true },
  ],
  slashCommands: [],
  skills: [],
};

const collectText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join(" ");
  if (isValidElement(value)) {
    return collectText((value.props as { children?: ReactNode }).children);
  }
  if (value !== null && typeof value === "object" && "children" in value) {
    return collectText((value as { children?: ReactNode }).children);
  }
  return "";
};

const queryView = (data: unknown, isPending: boolean) => {
  state.query = {
    ...state.query,
    data,
    isPending,
    isSuccess: data !== null,
  };
};

let renderer: ReactTestRenderer | undefined;

const renderWidget = () =>
  act(async () => {
    renderer = create(
      <WatchTaskStarterWidget
        environmentId={environmentId}
        widget={widget}
        projects={[project]}
        providers={[provider]}
        threads={[]}
        projectId={project.id}
        onOpenThread={vi.fn()}
      />,
    );
    await Promise.resolve();
  });

const typePrompt = (text: string) =>
  act(() => {
    renderer?.root.findByType("textarea").props.onChange({ target: { value: text } });
  });

const startButton = () =>
  renderer?.root
    .findAllByType("button")
    .find((button) => collectText(button.props.children).trim() === "Start");

const repoMemoryKey = () => JSON.stringify([environmentId, workspaceRoot]);

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.startTurn.mockReset();
  state.toast.mockClear();
  state.checkoutIsRepo.clear();
  queryView(null, false);
});

describe("WatchTaskStarterWidget", () => {
  it("disables Start while the checkout's git status is still in flight", async () => {
    queryView(null, true);

    await renderWidget();
    await typePrompt("fix the flaky test");

    // Pending status must not silently resolve "worktree" down to "local".
    expect(startButton()?.props.disabled).toBe(true);
    expect(state.startTurn).not.toHaveBeenCalled();
  });

  it("keeps Start gated on a warm revisit when the checkout was a repo", async () => {
    // A remembered repo still needs the live query for the base branch.
    state.checkoutIsRepo.set(repoMemoryKey(), true);
    queryView(null, true);

    await renderWidget();
    await typePrompt("fix the flaky test");

    expect(startButton()?.props.disabled).toBe(true);
    expect(state.startTurn).not.toHaveBeenCalled();
  });

  it("lets a remembered non-repo checkout start local without waiting", async () => {
    state.checkoutIsRepo.set(repoMemoryKey(), false);
    queryView(null, true);
    state.startTurn.mockResolvedValue(AsyncResult.success({}));

    await renderWidget();
    await typePrompt("fix the flaky test");
    expect(startButton()?.props.disabled).toBe(false);

    await act(async () => {
      startButton()?.props.onClick();
      await Promise.resolve();
    });

    expect(state.startTurn).toHaveBeenCalledTimes(1);
    const call = state.startTurn.mock.calls[0]![0] as {
      input: { bootstrap: { prepareWorktree?: unknown } };
    };
    expect(call.input.bootstrap.prepareWorktree).toBeUndefined();
  });

  it("starts the thread in a worktree once git status lands", async () => {
    queryView({ isRepo: true, refName: "main" }, false);
    state.startTurn.mockResolvedValue(AsyncResult.success({}));

    await renderWidget();
    await typePrompt("fix the flaky test");
    expect(startButton()?.props.disabled).toBe(false);

    await act(async () => {
      startButton()?.props.onClick();
      await Promise.resolve();
    });

    expect(state.startTurn).toHaveBeenCalledTimes(1);
    const call = state.startTurn.mock.calls[0]![0] as {
      input: {
        bootstrap: {
          createThread: { branch: string | null };
          prepareWorktree?: { projectCwd: string; baseBranch: string; requireWorktree: boolean };
        };
      };
    };
    expect(call.input.bootstrap.createThread.branch).toBe("main");
    expect(call.input.bootstrap.prepareWorktree).toEqual(
      expect.objectContaining({ projectCwd: workspaceRoot, baseBranch: "main" }),
    );
    // The fresh observation feeds the session memory for the next mount.
    expect(state.checkoutIsRepo.get(repoMemoryKey())).toBe(true);
  });
});
