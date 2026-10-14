import * as Effect from "effect/Effect";

import * as ConnectorService from "../../../watch/connectors/ConnectorService.ts";
import * as UserNotificationService from "../../../notifications/UserNotificationService.ts";
import * as WidgetTranspileService from "../../../watch/WidgetTranspileService.ts";
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
  t3_watch_widget_source_publish: McpToolAccess.writes((params) =>
    Effect.flatMap(WidgetTranspileService.WidgetTranspileService, (service) =>
      service.publish(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
  t3_watch_connectors_list: McpToolAccess.reads((params) =>
    Effect.flatMap(ConnectorService.ConnectorService, (service) =>
      service.list(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
  t3_watch_connector_instance_create: McpToolAccess.writes((params) =>
    Effect.flatMap(ConnectorService.ConnectorService, (service) =>
      service.createInstance(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
  t3_watch_connector_instance_update: McpToolAccess.writes((params) =>
    Effect.flatMap(ConnectorService.ConnectorService, (service) =>
      service.updateInstance(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
  t3_watch_connector_instance_delete: McpToolAccess.writes((params) =>
    Effect.flatMap(ConnectorService.ConnectorService, (service) =>
      service.deleteInstance(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
  t3_watch_connector_instance_config_set: McpToolAccess.writes((params) =>
    Effect.flatMap(ConnectorService.ConnectorService, (service) =>
      service.setInstanceConfig(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
  t3_watch_connector_request_install: McpToolAccess.writes((params) =>
    Effect.flatMap(ConnectorService.ConnectorService, (service) =>
      service.requestInstall(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
  t3_watch_connector_request_upgrade: McpToolAccess.writes((params) =>
    Effect.flatMap(ConnectorService.ConnectorService, (service) =>
      service.requestUpgrade(params).pipe(Effect.mapError(unavailable)),
    ),
  ),
});
