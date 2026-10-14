import {
  OrchestratorMcpFailure,
  WatchNotificationPrefs,
  WatchNotificationsHistoryInput,
  WatchNotificationsHistoryResult,
  WatchNotificationsSetPrefsResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UserNotificationService from "../../../notifications/UserNotificationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    UserNotificationService.UserNotificationService,
  ],
};

const WatchNotificationsHistoryTool = Tool.make("t3_watch_notifications_history", {
  ...shared,
  description:
    "Read this server's notification history, newest first. Every emitted notification is recorded here, including ones a muted or snoozed client chose not to surface.",
  parameters: WatchNotificationsHistoryInput,
  success: WatchNotificationsHistoryResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WatchNotificationsSetPrefsTool = Tool.make("t3_watch_notifications_prefs_update", {
  ...shared,
  description:
    "Replace this server's notification delivery prefs: mute or unmute event types and watch pages, or set a snooze horizon. Prefs only affect delivery decisions — history always records. Omitted means pass every list in full; an empty list un-mutes, a null snoozedUntil un-snoozes.",
  parameters: WatchNotificationPrefs,
  success: WatchNotificationsSetPrefsResult,
}).annotate(Tool.Destructive, true);

export const WatchToolkit = Toolkit.make(
  WatchNotificationsHistoryTool,
  WatchNotificationsSetPrefsTool,
);
