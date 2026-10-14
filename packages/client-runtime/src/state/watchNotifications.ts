import {
  isUnknownUnionMember,
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
