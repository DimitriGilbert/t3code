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

export const useWatchNotificationSurfaceStore = create<WatchNotificationSurfaceState>(() => ({
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

/**
 * Roll back a failed optimistic prefs write. Guards on the store still
 * holding `expected`, so a newer write is never reverted by an older write's
 * late failure.
 */
export function revertWatchNotificationPrefs(
  environmentId: EnvironmentId,
  expected: WatchNotificationPrefs,
  previous: WatchNotificationPrefs | null,
) {
  useWatchNotificationSurfaceStore.setState((state) => {
    if (state.prefs[environmentId] !== expected) return state;
    const prefs = { ...state.prefs };
    if (previous === null) {
      delete prefs[environmentId];
    } else {
      prefs[environmentId] = previous;
    }
    return { prefs };
  });
}

/**
 * Environment removal is not a remount: sweep every per-environment surface
 * entry that no longer belongs to a catalog environment.
 */
export function evictWatchNotificationEnvironments(activeEnvironmentIds: ReadonlySet<string>) {
  useWatchNotificationSurfaceStore.setState((state) => {
    const prune = <V>(record: Readonly<Record<string, V>>): Readonly<Record<string, V>> => {
      let changed = false;
      const next: Record<string, V> = {};
      for (const key of Object.keys(record)) {
        if (activeEnvironmentIds.has(key)) {
          next[key] = record[key] as V;
        } else {
          changed = true;
        }
      }
      return changed ? next : record;
    };
    const unread = prune(state.unread);
    const thresholdAlerts = prune(state.thresholdAlerts);
    const prefs = prune(state.prefs);
    if (
      unread === state.unread &&
      thresholdAlerts === state.thresholdAlerts &&
      prefs === state.prefs
    )
      return state;
    return { unread, thresholdAlerts, prefs };
  });
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

/**
 * Unread across every environment. The sidebar badge aggregates — it exists
 * to say "something happened somewhere", not to mirror the resolved screen.
 */
export function useWatchUnreadTotal(): number {
  return useWatchNotificationSurfaceStore((state) => {
    let total = 0;
    for (const unread of Object.values(state.unread)) total += unread.size;
    return total;
  });
}

export function useWatchNotificationPrefs(
  environmentId: EnvironmentId | null,
): WatchNotificationPrefs | null {
  return useWatchNotificationSurfaceStore((state) =>
    environmentId === null ? null : (state.prefs[environmentId] ?? null),
  );
}
