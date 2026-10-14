import {
  isUnknownUnionMember,
  type ThreadId,
  type UnknownUnionMember,
  WS_METHODS,
  type WatchNotificationEvent,
  type WatchNotificationId,
  type WatchNotificationPrefs,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Per-channel delivery for watch notifications. The server emits every
 * notification once and always records history; whether a given channel
 * surfaces it is decided here, shared by web, desktop, and later mobile push.
 *
 * Channel identity is the connected client session: each WS/browser session
 * (every tab, every window) is its own channel, so dedupe is per
 * `(notificationId, channel)` — suppressing one tab never suppresses another.
 * The desktop-native delivery path uses the `DESKTOP_NATIVE_CHANNEL` singleton
 * instead, so a device fires once even when several windows exist.
 */

/** Singleton channel for the device's native notification path — one delivery per device. */
export const WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL = "desktop-native";

/** Identity of one delivery on one channel: the `(notificationId, channel)` dedupe key. */
export function watchNotificationDedupeKey(
  notificationId: WatchNotificationId,
  channelId: string,
): string {
  return `${channelId}:${notificationId}`;
}

/** The page a notification belongs to, when it carries one. */
function notificationPageId(notification: WatchNotificationEvent) {
  return "pageId" in notification ? notification.pageId : undefined;
}

/**
 * Whether this notification may be delivered at all under `prefs` at `now`
 * (epoch millis): not snoozed, not muted by event type, not muted by page.
 * A notification type this build does not know is skipped — the client cannot
 * render it, and skipping mirrors the wire codec's unknown-member default.
 * Returning true narrows the notification to a known member so callers can
 * read its fields without a second unknown check.
 */
export function isWatchNotificationDeliverable(input: {
  readonly notification: WatchNotificationEvent;
  readonly prefs: WatchNotificationPrefs;
  readonly now: number;
}): input is {
  readonly notification: Exclude<WatchNotificationEvent, UnknownUnionMember>;
  readonly prefs: WatchNotificationPrefs;
  readonly now: number;
} {
  const { notification, prefs, now } = input;
  if (isUnknownUnionMember(notification)) return false;
  if (prefs.snoozedUntil !== null && Date.parse(prefs.snoozedUntil) > now) return false;
  if (prefs.mutedEventTypes.some((type) => type === notification.type)) return false;
  // Per-page mute is widget-scoped: only widget.threshold alerts carry a
  // pageId. Thread notifications are project-scoped, so a muted page never
  // silences them.
  const pageId = notificationPageId(notification);
  if (pageId !== undefined && prefs.mutedPageIds.includes(pageId)) return false;
  return true;
}

/**
 * The delivery decision for one channel: deliverable under prefs and not
 * already delivered on this channel. `deliveredKeys` is the channel's own set
 * of {@link watchNotificationDedupeKey}s — one set per channel, never shared.
 */
export function shouldDeliverWatchNotification(input: {
  readonly notification: WatchNotificationEvent;
  readonly prefs: WatchNotificationPrefs;
  readonly channelId: string;
  readonly deliveredKeys: ReadonlySet<string>;
  readonly now: number;
}): boolean {
  const { notification, prefs, channelId, deliveredKeys, now } = input;
  const deliverable = { notification, prefs, now };
  if (!isWatchNotificationDeliverable(deliverable)) return false;
  return !deliveredKeys.has(
    watchNotificationDedupeKey(deliverable.notification.notificationId, channelId),
  );
}

/**
 * The thread a notification is about, when it carries one — connector and
 * widget-threshold events are not thread-scoped.
 */
export function watchNotificationThreadId(
  notification: WatchNotificationEvent,
): ThreadId | undefined {
  if (isUnknownUnionMember(notification)) return undefined;
  return "threadId" in notification ? notification.threadId : undefined;
}

/** The widget a `widget.threshold` notification fired for, when it carries one. */
export function watchNotificationWidgetId(notification: WatchNotificationEvent) {
  if (isUnknownUnionMember(notification)) return undefined;
  return "widgetId" in notification ? notification.widgetId : undefined;
}

export interface WatchNotificationDelivery {
  /** Deliver on this client session's in-app channel (toast + unread badge). */
  readonly inApp: boolean;
  /** Deliver on the device's desktop-native channel (one `Notification`). */
  readonly desktopNative: boolean;
}

/**
 * The per-client routing decision for one notification event. Delivery is
 * always a channel decision, never a server-side drop:
 *
 * - A client actively viewing the notification's thread suppresses its own
 *   delivery on both channels (the event is already on screen).
 * - An attended window (visible + focused) takes the in-app channel — a
 *   toast; an unattended window takes the desktop-native channel — one
 *   `Notification`, deduped device-wide by the native `tag`.
 * - Either way the `(notificationId, channel)` dedupe key keeps a channel
 *   from firing twice, and prefs filtering runs before any surface check.
 */
export function resolveWatchNotificationDelivery(input: {
  readonly notification: WatchNotificationEvent;
  readonly prefs: WatchNotificationPrefs;
  readonly now: number;
  /** This client session's channel id — each tab/window is its own channel. */
  readonly inAppChannelId: string;
  readonly inAppDelivered: ReadonlySet<string>;
  /** {@link WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL} — one delivery per device. */
  readonly nativeChannelId: string;
  readonly nativeDelivered: ReadonlySet<string>;
  /** The thread this client is actively viewing on this environment, if any. */
  readonly viewingThreadId: string | undefined;
  /** `document.visibilityState === "visible" && document.hasFocus()`. */
  readonly windowAttended: boolean;
}): WatchNotificationDelivery {
  const { notification, prefs, now } = input;
  const none: WatchNotificationDelivery = { inApp: false, desktopNative: false };
  if (!isWatchNotificationDeliverable({ notification, prefs, now })) return none;
  const threadId = watchNotificationThreadId(notification);
  if (threadId !== undefined && threadId === input.viewingThreadId) return none;
  const inApp =
    input.windowAttended &&
    shouldDeliverWatchNotification({
      notification,
      prefs,
      channelId: input.inAppChannelId,
      deliveredKeys: input.inAppDelivered,
      now,
    });
  const desktopNative =
    !input.windowAttended &&
    shouldDeliverWatchNotification({
      notification,
      prefs,
      channelId: input.nativeChannelId,
      deliveredKeys: input.nativeDelivered,
      now,
    });
  return { inApp, desktopNative };
}

export type WatchNotificationIconKind =
  | "completed"
  | "failed"
  | "input"
  | "connector"
  | "rollback"
  | "threshold";

export interface WatchNotificationPresentation {
  readonly title: string;
  readonly body: string | undefined;
  readonly icon: WatchNotificationIconKind;
  readonly toastType: "success" | "error" | "warning" | "info";
}

/**
 * The toast/history copy for one notification — terse operator language, one
 * status signal. `threadTitle`/`instanceLabel` are caller-resolved lookups;
 * without them the body falls back to the error or the short id.
 */
export function watchNotificationPresentation(input: {
  readonly notification: WatchNotificationEvent;
  readonly threadTitle?: string | undefined;
  readonly instanceLabel?: string | undefined;
}): WatchNotificationPresentation | null {
  const { notification } = input;
  if (isUnknownUnionMember(notification)) return null;
  switch (notification.type) {
    case "thread.completed":
      return {
        title: "Thread completed",
        body: input.threadTitle,
        icon: "completed",
        toastType: "success",
      };
    case "thread.failed":
      return {
        title: "Thread failed",
        body: notification.error ?? input.threadTitle,
        icon: "failed",
        toastType: "error",
      };
    case "thread.awaitingInput":
      return {
        title: "Input needed",
        body: input.threadTitle,
        icon: "input",
        toastType: "warning",
      };
    case "connector.unhealthy":
      return {
        title: "Connector down",
        body: input.instanceLabel,
        icon: "connector",
        toastType: "warning",
      };
    case "connector.authExpired":
      return {
        title: "Connector credentials expired",
        body: input.instanceLabel,
        icon: "connector",
        toastType: "error",
      };
    case "connector.rolledBack":
      return {
        title: "Connector rolled back",
        body: `v${notification.fromSchemaVersion} → v${notification.toSchemaVersion}`,
        icon: "rollback",
        toastType: "info",
      };
    case "widget.threshold":
      return {
        title: notification.summary ?? "Widget threshold crossed",
        body: input.instanceLabel,
        icon: "threshold",
        toastType: "warning",
      };
  }
}

/** Notification atoms shared by web, desktop, and mobile. */
export function createWatchNotificationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Prefs first, then each notification the server emits. */
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:watch:notifications",
      tag: WS_METHODS.watchNotificationsSubscribe,
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:watch:notification-history",
      tag: WS_METHODS.watchNotificationsHistory,
      staleTimeMs: 15_000,
    }),
    setPrefs: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:watch:notifications-set-prefs",
      tag: WS_METHODS.watchNotificationsSetPrefs,
    }),
  };
}
