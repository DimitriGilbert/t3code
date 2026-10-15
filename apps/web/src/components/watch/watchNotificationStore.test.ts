import { EnvironmentId, WatchNotificationId, WatchWidgetId } from "@t3tools/contracts";
import type { WatchNotificationPrefs } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  addWatchNotificationUnread,
  addWatchThresholdAlert,
  evictWatchNotificationEnvironments,
  revertWatchNotificationPrefs,
  setWatchNotificationPrefs,
  useWatchNotificationSurfaceStore,
} from "./watchNotificationStore";

const PREFS: WatchNotificationPrefs = {
  mutedEventTypes: ["thread.completed"],
  mutedPageIds: [],
  snoozedUntil: null,
};

const OTHER_PREFS: WatchNotificationPrefs = {
  mutedEventTypes: ["thread.failed"],
  mutedPageIds: [],
  snoozedUntil: null,
};

beforeEach(() => {
  useWatchNotificationSurfaceStore.setState({ unread: {}, thresholdAlerts: {}, prefs: {} });
});

describe("evictWatchNotificationEnvironments", () => {
  it("drops unread, threshold alerts, and prefs for environments that left the catalog", () => {
    const keep = EnvironmentId.make("keep");
    const gone = EnvironmentId.make("gone");
    setWatchNotificationPrefs(keep, PREFS);
    setWatchNotificationPrefs(gone, PREFS);
    addWatchNotificationUnread(keep, WatchNotificationId.make("n1"));
    addWatchNotificationUnread(gone, WatchNotificationId.make("n2"));
    addWatchThresholdAlert(keep, WatchWidgetId.make("w1"));
    addWatchThresholdAlert(gone, WatchWidgetId.make("w2"));

    evictWatchNotificationEnvironments(new Set([keep]));

    const state = useWatchNotificationSurfaceStore.getState();
    expect(state.unread[keep]?.has(WatchNotificationId.make("n1"))).toBe(true);
    expect(state.unread[gone]).toBeUndefined();
    expect(state.thresholdAlerts[keep]?.has(WatchWidgetId.make("w1"))).toBe(true);
    expect(state.thresholdAlerts[gone]).toBeUndefined();
    expect(state.prefs[keep]).toEqual(PREFS);
    expect(state.prefs[gone]).toBeUndefined();
  });

  it("is a no-op when every entry still belongs to a catalog environment", () => {
    const env = EnvironmentId.make("env");
    setWatchNotificationPrefs(env, PREFS);
    addWatchNotificationUnread(env, WatchNotificationId.make("n1"));
    const before = useWatchNotificationSurfaceStore.getState();

    evictWatchNotificationEnvironments(new Set([env]));

    expect(useWatchNotificationSurfaceStore.getState()).toBe(before);
  });
});

describe("revertWatchNotificationPrefs", () => {
  it("restores the previous prefs when the optimistic value is still current", () => {
    const env = EnvironmentId.make("env");
    setWatchNotificationPrefs(env, PREFS);
    setWatchNotificationPrefs(env, OTHER_PREFS);

    revertWatchNotificationPrefs(env, OTHER_PREFS, PREFS);

    expect(useWatchNotificationSurfaceStore.getState().prefs[env]).toEqual(PREFS);
  });

  it("clears prefs when there was no previous echo", () => {
    const env = EnvironmentId.make("env");
    setWatchNotificationPrefs(env, OTHER_PREFS);

    revertWatchNotificationPrefs(env, OTHER_PREFS, null);

    expect(useWatchNotificationSurfaceStore.getState().prefs[env]).toBeUndefined();
  });

  it("does not revert a newer optimistic write over an older failure", () => {
    const env = EnvironmentId.make("env");
    setWatchNotificationPrefs(env, PREFS);
    setWatchNotificationPrefs(env, OTHER_PREFS);

    // The PREFS write failed late — after OTHER_PREFS already replaced it.
    revertWatchNotificationPrefs(env, PREFS, null);

    expect(useWatchNotificationSurfaceStore.getState().prefs[env]).toEqual(OTHER_PREFS);
  });
});
