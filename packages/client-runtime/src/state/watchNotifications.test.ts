import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ThreadId,
  UnknownUnionMember,
  WatchNotificationId,
  WatchPageId,
  WatchWidgetId,
  type WatchNotificationEvent,
  type WatchNotificationPrefs,
} from "@t3tools/contracts";

import {
  isWatchNotificationDeliverable,
  shouldDeliverWatchNotification,
  WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL,
  watchNotificationDedupeKey,
} from "./watchNotifications.ts";

const projectId = ProjectId.make("project:one");
const threadId = ThreadId.make("thread:one");
const pageId = WatchPageId.make("watch-page:one");
const widgetId = WatchWidgetId.make("watch-widget:one");

const completed: WatchNotificationEvent = {
  type: "thread.completed",
  notificationId: WatchNotificationId.make("watch-notification:run.completed:run:one"),
  createdAt: "2026-01-01T00:00:00.000Z",
  threadId,
  projectId,
};

const threshold: WatchNotificationEvent = {
  type: "widget.threshold",
  notificationId: WatchNotificationId.make("watch-notification:widget.threshold:one"),
  createdAt: "2026-01-01T00:00:00.000Z",
  widgetId,
  pageId,
};

const defaultPrefs: WatchNotificationPrefs = {
  mutedEventTypes: [],
  mutedPageIds: [],
  snoozedUntil: null,
};

describe("watchNotificationDedupeKey", () => {
  it("keys delivery by (notificationId, channel)", () => {
    const tabA = watchNotificationDedupeKey(completed.notificationId, "session:a");
    const tabB = watchNotificationDedupeKey(completed.notificationId, "session:b");
    expect(tabA).not.toBe(tabB);
    expect(tabA).toBe(watchNotificationDedupeKey(completed.notificationId, "session:a"));
  });
});

describe("isWatchNotificationDeliverable", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");

  it("delivers under default prefs", () => {
    expect(
      isWatchNotificationDeliverable({ notification: completed, prefs: defaultPrefs, now }),
    ).toBe(true);
  });

  it("mutes and unmutes an event type", () => {
    const muted = { ...defaultPrefs, mutedEventTypes: ["thread.completed" as const] };
    expect(isWatchNotificationDeliverable({ notification: completed, prefs: muted, now })).toBe(
      false,
    );
    expect(isWatchNotificationDeliverable({ notification: threshold, prefs: muted, now })).toBe(
      true,
    );
    expect(
      isWatchNotificationDeliverable({ notification: completed, prefs: defaultPrefs, now }),
    ).toBe(true);
  });

  it("mutes and unmutes a page without touching page-less notifications", () => {
    const muted = { ...defaultPrefs, mutedPageIds: [pageId] };
    expect(isWatchNotificationDeliverable({ notification: threshold, prefs: muted, now })).toBe(
      false,
    );
    expect(isWatchNotificationDeliverable({ notification: completed, prefs: muted, now })).toBe(
      true,
    );
    const otherPage = { ...defaultPrefs, mutedPageIds: [WatchPageId.make("watch-page:other")] };
    expect(isWatchNotificationDeliverable({ notification: threshold, prefs: otherPage, now })).toBe(
      true,
    );
  });

  it("snoozes only until the horizon; unsnooze delivers again", () => {
    const snoozed = { ...defaultPrefs, snoozedUntil: "2026-01-01T13:00:00.000Z" };
    expect(isWatchNotificationDeliverable({ notification: completed, prefs: snoozed, now })).toBe(
      false,
    );
    const expired = { ...defaultPrefs, snoozedUntil: "2026-01-01T11:00:00.000Z" };
    expect(isWatchNotificationDeliverable({ notification: completed, prefs: expired, now })).toBe(
      true,
    );
    expect(
      isWatchNotificationDeliverable({
        notification: completed,
        prefs: { ...defaultPrefs, snoozedUntil: null },
        now,
      }),
    ).toBe(true);
  });

  it("skips notification types this build does not know", () => {
    const unknown = new UnknownUnionMember("type", "connector.futureKind");
    expect(
      isWatchNotificationDeliverable({
        notification: unknown,
        prefs: defaultPrefs,
        now,
      }),
    ).toBe(false);
  });
});

describe("shouldDeliverWatchNotification", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");

  it("delivers once per channel: two browser tabs each get the notification", () => {
    const tabAKeys = new Set<string>();
    const tabBKeys = new Set<string>();
    const deliverTabA = shouldDeliverWatchNotification({
      notification: completed,
      prefs: defaultPrefs,
      channelId: "session:a",
      deliveredKeys: tabAKeys,
      now,
    });
    const deliverTabB = shouldDeliverWatchNotification({
      notification: completed,
      prefs: defaultPrefs,
      channelId: "session:b",
      deliveredKeys: tabBKeys,
      now,
    });
    expect(deliverTabA).toBe(true);
    expect(deliverTabB).toBe(true);

    tabAKeys.add(watchNotificationDedupeKey(completed.notificationId, "session:a"));
    // Suppressing tab A's own delivery never suppresses tab B.
    expect(
      shouldDeliverWatchNotification({
        notification: completed,
        prefs: defaultPrefs,
        channelId: "session:a",
        deliveredKeys: tabAKeys,
        now,
      }),
    ).toBe(false);
    expect(
      shouldDeliverWatchNotification({
        notification: completed,
        prefs: defaultPrefs,
        channelId: "session:b",
        deliveredKeys: tabBKeys,
        now,
      }),
    ).toBe(true);
  });

  it("delivers once per device on the desktop-native singleton channel", () => {
    const deviceKeys = new Set<string>();
    const first = shouldDeliverWatchNotification({
      notification: completed,
      prefs: defaultPrefs,
      channelId: WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL,
      deliveredKeys: deviceKeys,
      now,
    });
    deviceKeys.add(
      watchNotificationDedupeKey(
        completed.notificationId,
        WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL,
      ),
    );
    // A second window on the same device is still the same channel.
    const second = shouldDeliverWatchNotification({
      notification: completed,
      prefs: defaultPrefs,
      channelId: WATCH_NOTIFICATION_DESKTOP_NATIVE_CHANNEL,
      deliveredKeys: deviceKeys,
      now,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
