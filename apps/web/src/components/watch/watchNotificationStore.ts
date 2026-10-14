import type {
  EnvironmentId,
  WatchNotificationId,
  WatchNotificationPrefs,
  WatchWidgetId,
} from "@t3tools/contracts";
import { create } from "zustand";

/**
 * The client-side surface state for watch notifications, shared between the
 * always-mounted `WatchNotificationCoordinator` (which writes prefs, unread
 * ids, and threshold alerts) and the bell/popover and widget chrome (which
 * read and clear them). History itself is server-recorded; this store only
 * holds what the live stream most recently delivered to this client session.
 */
interface WatchNotificationSurfaceState {
  /** Unread notification ids per environment — the badge counts. */
  readonly unread: Readonly<Record<string, ReadonlySet<WatchNotificationId>>>;
  /** Widgets whose threshold alert fired and has not been acknowledged. */
  readonly thresholdAlerts: Readonly<Record<string, ReadonlySet<WatchWidgetId>>>;
  /** The latest prefs each environment's stream sent; the popover renders these. */
  readonly prefs: Readonly<Record<string, WatchNotificationPrefs>>;
}

const useWatchNotificationSurfaceStore = create<WatchNotificationSurfaceState>(() => ({
  unread: {},
  thresholdAlerts: {},
  prefs: {},
}));

export function setWatchNotificationPrefs(
  environmentId: EnvironmentId,
  prefs: WatchNotificationPrefs,
) {
  useWatchNotificationSurfaceStore.setState((state) => ({
    prefs: { ...state.prefs, [environmentId]: prefs },
  }));
}

export function addWatchNotificationUnread(
  environmentId: EnvironmentId,
  notificationId: WatchNotificationId,
) {
  useWatchNotificationSurfaceStore.setState((state) => {
    const current = state.unread[environmentId] ?? new Set<WatchNotificationId>();
    if (current.has(notificationId)) return state;
    const next = new Set(current);
    next.add(notificationId);
    return { unread: { ...state.unread, [environmentId]: next } };
  });
}

export function clearWatchNotificationUnread(environmentId: EnvironmentId) {
  useWatchNotificationSurfaceStore.setState((state) => {
    const current = state.unread[environmentId];
    if (current === undefined || current.size === 0) return state;
    const unread = { ...state.unread };
    delete unread[environmentId];
    return { unread };
  });
}

/**
 * A `widget.threshold` notification marks its widget until the user
 * acknowledges the badge — delivery prefs do not gate it, the alert is widget
 * state, not a toast decision.
 */
export function addWatchThresholdAlert(environmentId: EnvironmentId, widgetId: WatchWidgetId) {
  useWatchNotificationSurfaceStore.setState((state) => {
    const current = state.thresholdAlerts[environmentId] ?? new Set<WatchWidgetId>();
    if (current.has(widgetId)) return state;
    const next = new Set(current);
    next.add(widgetId);
    return { thresholdAlerts: { ...state.thresholdAlerts, [environmentId]: next } };
  });
}

/** Acknowledge one widget's threshold alert — the header badge clears. */
export function acknowledgeWatchThresholdAlert(
  environmentId: EnvironmentId,
  widgetId: WatchWidgetId,
) {
  useWatchNotificationSurfaceStore.setState((state) => {
    const current = state.thresholdAlerts[environmentId];
    if (current === undefined || !current.has(widgetId)) return state;
    const next = new Set(current);
    next.delete(widgetId);
    const thresholdAlerts = { ...state.thresholdAlerts };
    if (next.size === 0) {
      delete thresholdAlerts[environmentId];
    } else {
      thresholdAlerts[environmentId] = next;
    }
    return { thresholdAlerts };
  });
}

export function useWatchThresholdAlert(
  environmentId: EnvironmentId | null,
  widgetId: WatchWidgetId,
): boolean {
  return useWatchNotificationSurfaceStore((state) =>
    environmentId === null ? false : (state.thresholdAlerts[environmentId]?.has(widgetId) ?? false),
  );
}

export function useWatchUnreadCount(environmentId: EnvironmentId | null): number {
  return useWatchNotificationSurfaceStore((state) =>
    environmentId === null ? 0 : (state.unread[environmentId]?.size ?? 0),
  );
}

export function useWatchNotificationPrefs(
  environmentId: EnvironmentId | null,
): WatchNotificationPrefs | null {
  return useWatchNotificationSurfaceStore((state) =>
    environmentId === null ? null : (state.prefs[environmentId] ?? null),
  );
}
