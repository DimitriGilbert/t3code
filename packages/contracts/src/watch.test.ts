import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { UnknownUnionMember } from "./baseSchemas.ts";
import {
  WatchNotificationEvent,
  WatchNotificationPrefs,
  WatchNotificationStreamItem,
  WatchNotificationsHistoryResult,
  WatchPage,
  WatchPageRevisionConflictError,
  WatchWidget,
  WatchWidgetErrorState,
  WatchWidgetSource,
} from "./watch.ts";

const NOW = "2026-09-09T12:00:00.000Z";

const decodePage = Schema.decodeUnknownSync(WatchPage);
const encodePage = Schema.encodeSync(WatchPage);
const decodeWidget = Schema.decodeUnknownSync(WatchWidget);
const encodeWidget = Schema.encodeSync(WatchWidget);
const decodeSource = Schema.decodeUnknownSync(WatchWidgetSource);
const decodeRevisionConflict = Schema.decodeUnknownSync(WatchPageRevisionConflictError);
const decodeNotificationEvent = Schema.decodeUnknownSync(WatchNotificationEvent);
const decodeNotificationPrefs = Schema.decodeUnknownSync(WatchNotificationPrefs);
const encodeNotificationPrefs = Schema.encodeSync(WatchNotificationPrefs);
const decodeNotificationStreamItem = Schema.decodeUnknownSync(WatchNotificationStreamItem);
const decodeNotificationHistoryResult = Schema.decodeUnknownSync(WatchNotificationsHistoryResult);
const decodeWidgetErrorState = Schema.decodeUnknownSync(WatchWidgetErrorState);

const pageFixture = {
  id: "watch-page:1",
  name: "Watch",
  scope: "global",
  projectId: null,
  orderKey: "n",
  revision: 1,
  mobileRevision: 1,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const widgetFixture = {
  id: "watch-widget:1",
  pageId: "watch-page:1",
  kind: "active-work",
  config: { source: { kind: "threads" } },
  placement: { x: 0, y: 0, w: 7, h: 4 },
  revision: 1,
  mobileOrder: 0,
  mobileHidden: false,
  provenance: "firstParty",
  createdAt: NOW,
  updatedAt: NOW,
};

describe("WatchPage", () => {
  it("round-trips a project-scoped page with an archive timestamp", () => {
    const decoded = decodePage({
      ...pageFixture,
      scope: "project",
      projectId: "project:1",
      archivedAt: NOW,
    });
    expect(decoded.scope).toBe("project");
    expect(decoded.projectId).toBe("project:1");
    expect(encodePage(decoded)).toEqual({
      ...pageFixture,
      scope: "project",
      projectId: "project:1",
      archivedAt: NOW,
    });
  });

  it("rejects a scope that is not global or project", () => {
    expect(() => decodePage({ ...pageFixture, scope: "team" })).toThrow();
  });
});

describe("WatchWidget", () => {
  it("round-trips a widget including the mobile projection columns", () => {
    const decoded = decodeWidget({
      ...widgetFixture,
      kind: "agent:watch-widget-source:1",
      provenance: "agentPublished",
      mobileOrder: 3,
      mobileHidden: true,
      placement: { x: 0, y: 0, w: 7, h: 4, minCols: 4 },
    });
    expect(decoded.mobileHidden).toBe(true);
    expect(decoded.placement.minCols).toBe(4);
    expect(encodeWidget(decoded).mobileOrder).toBe(3);
  });

  it("accepts pack provenance template literals", () => {
    const decoded = decodeWidget({
      ...widgetFixture,
      provenance: "pack:watch-connector-pack:1",
    });
    expect(decoded.provenance).toBe("pack:watch-connector-pack:1");
  });
});

describe("WatchWidgetSource", () => {
  it("decodes the three source kinds and no others", () => {
    for (const kind of ["threads", "connector", "static"]) {
      expect(decodeSource({ kind }).kind).toBe(kind);
    }
    // There is deliberately no `url` source: arbitrary egress only ever
    // happens inside an egress-allowlisted connector pack.
    expect(() => decodeSource({ kind: "url" })).toThrow();
  });
});

describe("WatchPageRevisionConflictError", () => {
  it("carries page, widget, and mobile-projection context", () => {
    const decoded = decodeRevisionConflict({
      _tag: "WatchPageRevisionConflictError",
      pageId: "watch-page:1",
      widgetId: "watch-widget:2",
      mobileProjection: true,
      expectedRevision: 3,
      currentRevision: 5,
      message: "stale",
    });
    expect(decoded.widgetId).toBe("watch-widget:2");
    expect(decoded.mobileProjection).toBe(true);
    expect(decoded.currentRevision).toBe(5);
  });
});

describe("WatchNotificationEvent", () => {
  it("decodes known members and degrades unknown types to UnknownUnionMember", () => {
    const known = decodeNotificationEvent({
      type: "thread.completed",
      notificationId: "watch-notification:1",
      createdAt: NOW,
      threadId: "thread:1",
      projectId: "project:1",
    });
    expect("type" in known && known.type).toBe("thread.completed");

    const unknown = decodeNotificationEvent({
      type: "connector.futureEvent",
      notificationId: "watch-notification:2",
      createdAt: NOW,
    });
    expect(unknown).toBeInstanceOf(UnknownUnionMember);
  });
});

describe("WatchNotificationPrefs", () => {
  it("round-trips mutes and snooze", () => {
    const decoded = decodeNotificationPrefs({
      mutedEventTypes: ["widget.threshold"],
      mutedPageIds: ["watch-page:9"],
      snoozedUntil: NOW,
    });
    expect(decoded.mutedEventTypes).toEqual(["widget.threshold"]);
    expect(encodeNotificationPrefs(decoded).snoozedUntil).toBe(NOW);
  });
});

describe("WatchNotificationStreamItem", () => {
  it("decodes prefs and notification items", () => {
    const prefs = decodeNotificationStreamItem({
      type: "prefs",
      prefs: { mutedEventTypes: [], mutedPageIds: [], snoozedUntil: null },
    });
    expect(prefs.type).toBe("prefs");
    const notification = decodeNotificationStreamItem({
      type: "notification",
      notification: {
        type: "thread.awaitingInput",
        notificationId: "watch-notification:3",
        createdAt: NOW,
        threadId: "thread:1",
        projectId: "project:1",
      },
    });
    expect(notification.type).toBe("notification");
  });
});

describe("WatchNotificationsHistoryResult", () => {
  it("decodes recorded entries newest-first", () => {
    const decoded = decodeNotificationHistoryResult({
      entries: [
        {
          notification: {
            type: "thread.failed",
            notificationId: "watch-notification:4",
            createdAt: NOW,
            threadId: "thread:1",
            projectId: "project:1",
          },
          recordedAt: NOW,
        },
      ],
    });
    expect(decoded.entries).toHaveLength(1);
    expect(decoded.entries[0]?.recordedAt).toBe(NOW);
  });
});

describe("WatchWidgetErrorState", () => {
  it("decodes each typed cause", () => {
    for (const cause of [
      "connectorDown",
      "credentialsInvalid",
      "configMismatch",
      "connectorMissing",
      "connectorSnapshotTooLarge",
      "projectMissing",
      "transpileFailed",
    ]) {
      expect(decodeWidgetErrorState({ cause }).cause).toBe(cause);
    }
    expect(() => decodeWidgetErrorState({ cause: "unknownThing" })).toThrow();
  });
});
