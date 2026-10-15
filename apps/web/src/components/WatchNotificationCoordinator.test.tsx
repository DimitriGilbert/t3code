import { WatchWidgetId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as "off" | "notifications" | "sound" | "notifications-and-sound",
  inApp: false,
  focused: false,
  visible: "visible" as "visible" | "hidden",
  environmentIds: ["one"],
  serverConfigs: new Map<string, { watchScreen: boolean }>(),
  params: {} as { environmentId?: string; threadId?: string },
  navigate: vi.fn(),
  toast: vi.fn(() => "toast-1"),
  toastClose: vi.fn(),
  sound: vi.fn(),
  unlock: vi.fn(),
  badge: vi.fn(),
  subscribers: new Map<string, (result: unknown) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.params,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { notificationMode: string }) => unknown) =>
    select({ notificationMode: state.mode }),
  getClientSettings: () => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => state.environmentIds,
}));
vi.mock("../state/entities", () => ({
  useServerConfigs: () => state.serverConfigs,
  useThreadShells: () => [],
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { instances: [] },
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: vi.fn(),
  }),
}));
vi.mock("../state/watch", () => ({
  watchEnvironment: {
    connectorsLive: (target: { environmentId: string }) => ({
      kind: "connectors",
      environmentId: target.environmentId,
    }),
    notifications: {
      live: (target: { environmentId: string }) => ({
        kind: "notifications",
        environmentId: target.environmentId,
      }),
    },
  },
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    subscribe: (atom: { environmentId: string }, callback: (result: unknown) => void) => {
      state.subscribers.set(atom.environmentId, callback);
      return () => {
        state.subscribers.delete(atom.environmentId);
      };
    },
  },
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: state.unlock,
  setNotificationBadgeForSource: state.badge,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.toast, close: state.toastClose },
}));

import { WatchNotificationCoordinator } from "./WatchNotificationCoordinator";
import { useWatchNotificationSurfaceStore } from "./watch/watchNotificationStore";

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

let renderer: ReactTestRenderer | undefined;
let notificationSerial = 0;

const PREFS_ITEM = {
  type: "prefs",
  prefs: { mutedEventTypes: [], mutedPageIds: [], snoozedUntil: null },
};

function notificationItem(type = "thread.completed") {
  notificationSerial += 1;
  return {
    type: "notification",
    notification: {
      type,
      notificationId: `n${notificationSerial}`,
      createdAt: "2026-09-13T08:00:00Z",
      threadId: "thread-1",
      projectId: "project-1",
    },
  };
}

async function render() {
  await act(async () => {
    if (renderer) renderer.update(<WatchNotificationCoordinator />);
    else renderer = create(<WatchNotificationCoordinator />);
  });
}

async function emit(environmentId: string, item: unknown) {
  await act(async () => {
    state.subscribers.get(environmentId)?.(AsyncResult.success(item));
  });
}

function unread(environmentId: string): ReadonlySet<string> {
  return useWatchNotificationSurfaceStore.getState().unread[environmentId] ?? new Set<string>();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: false,
    focused: false,
    visible: "visible",
    environmentIds: ["one"],
    params: {},
    subscribers: new Map(),
  });
  state.serverConfigs = new Map([
    ["one", { watchScreen: true }],
    ["two", { watchScreen: false }],
  ]);
  useWatchNotificationSurfaceStore.setState({ unread: {}, thresholdAlerts: {}, prefs: {} });
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { focus: vi.fn() }));
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      hasFocus: () => state.focused,
      get visibilityState() {
        return state.visible;
      },
    }),
  );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("WatchNotificationCoordinator", () => {
  it("accrues the unread badge even with every notification surface disabled", async () => {
    state.focused = true;
    await render();
    await emit("one", notificationItem());

    expect(unread("one").size).toBe(1);
    expect(state.toast).not.toHaveBeenCalled();
    expect(TestNotification.sent).toHaveLength(0);
  });

  it("plays the notification sound in sound-only mode instead of dropping the event", async () => {
    state.mode = "sound";
    await render();
    await emit("one", notificationItem());

    // Unattended + sound-only: no native notification exists to show, but the
    // audible cue is its own surface and the badge still accrues.
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(TestNotification.sent).toHaveLength(0);
    expect(unread("one").size).toBe(1);
  });

  it("does not subscribe environments whose server has no watch screen", async () => {
    // "two" declares watchScreen: false; "three" has no config loaded at all.
    state.environmentIds = ["one", "two", "three"];
    await render();

    expect([...state.subscribers.keys()]).toEqual(["one"]);
  });

  it("stops counting a native notification the OS dismisses", async () => {
    state.mode = "notifications";
    await render();
    await emit("one", notificationItem());
    await emit("one", notificationItem());

    expect(TestNotification.sent).toHaveLength(2);
    expect(state.badge).toHaveBeenLastCalledWith("watch", 2);
    TestNotification.sent[0]!.dispatchEvent(new Event("close"));
    expect(state.badge).toHaveBeenLastCalledWith("watch", 1);
    // A stale second close must not double-subtract.
    TestNotification.sent[0]!.dispatchEvent(new Event("close"));
    expect(state.badge).toHaveBeenLastCalledWith("watch", 1);
  });

  it("evicts the channel and surface state when an environment leaves the catalog", async () => {
    await render();
    await emit("one", PREFS_ITEM);
    await emit("one", notificationItem());
    await emit("one", {
      type: "notification",
      notification: {
        type: "widget.threshold",
        notificationId: "threshold-1",
        createdAt: "2026-09-13T08:00:00Z",
        widgetId: "widget-1",
      },
    });
    expect(unread("one").size).toBe(2);
    expect(useWatchNotificationSurfaceStore.getState().prefs["one"]).toBeDefined();
    expect(
      useWatchNotificationSurfaceStore
        .getState()
        .thresholdAlerts["one"]?.has(WatchWidgetId.make("widget-1")),
    ).toBe(true);

    state.environmentIds = [];
    await render();

    const store = useWatchNotificationSurfaceStore.getState();
    expect(store.unread["one"]).toBeUndefined();
    expect(store.thresholdAlerts["one"]).toBeUndefined();
    expect(store.prefs["one"]).toBeUndefined();
    expect([...state.subscribers.keys()]).toEqual([]);
  });
});
