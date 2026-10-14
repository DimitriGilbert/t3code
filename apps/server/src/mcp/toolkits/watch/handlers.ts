import * as Effect from "effect/Effect";

import * as UserNotificationService from "../../../notifications/UserNotificationService.ts";
import { unavailable } from "../../threadAccess.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WatchToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(WatchToolkit, {
  t3_watch_notifications_history: McpToolAccess.reads((params) =>
    Effect.flatMap(UserNotificationService.UserNotificationService, (notifications) =>
      notifications.history(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
  t3_watch_notifications_prefs_update: McpToolAccess.writes((prefs) =>
    Effect.flatMap(UserNotificationService.UserNotificationService, (notifications) =>
      notifications.setPrefs(prefs).pipe(Effect.mapError(unavailable)),
    ),
  ),
});
