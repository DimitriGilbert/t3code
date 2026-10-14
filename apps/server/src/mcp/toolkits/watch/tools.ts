import {
  OrchestratorMcpFailure,
  WatchConnectorCreateInstanceInput,
  WatchConnectorDeleteInstanceInput,
  WatchConnectorDeleteInstanceResult,
  WatchConnectorInstallRequestResult,
  WatchConnectorInstanceResult,
  WatchConnectorRequestInstallInput,
  WatchConnectorRequestUpgradeInput,
  WatchConnectorSetInstanceConfigInput,
  WatchConnectorsListInput,
  WatchConnectorsListResult,
  WatchConnectorUpdateInstanceInput,
  WatchNotificationPrefs,
  WatchNotificationsHistoryInput,
  WatchNotificationsHistoryResult,
  WatchNotificationsSetPrefsResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UserNotificationService from "../../../notifications/UserNotificationService.ts";
import * as ConnectorService from "../../../watch/connectors/ConnectorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    UserNotificationService.UserNotificationService,
    ConnectorService.ConnectorService,
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

// Connector tools deliberately stop at the request side: an agent may list
// packs and instances, manage instance config, and open install or upgrade
// requests — but the human-confirm leg (prepare/confirm/purge) has no tool,
// so nothing an agent runs can approve its own request.
const WatchConnectorsListTool = Tool.make("t3_watch_connectors_list", {
  ...shared,
  description:
    "List this server's connector packs, connector instances, and pending install requests.",
  parameters: WatchConnectorsListInput,
  success: WatchConnectorsListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WatchConnectorInstanceCreateTool = Tool.make("t3_watch_connector_instance_create", {
  ...shared,
  description:
    "Create a connector instance bound to an installed pack. Config is validated against the pack manifest's auth schema; declared secret values are stored in the server secret store by key and never echoed back.",
  parameters: WatchConnectorCreateInstanceInput,
  success: WatchConnectorInstanceResult,
}).annotate(Tool.Destructive, false);

const WatchConnectorInstanceUpdateTool = Tool.make("t3_watch_connector_instance_update", {
  ...shared,
  description: "Rename a connector instance.",
  parameters: WatchConnectorUpdateInstanceInput,
  success: WatchConnectorInstanceResult,
}).annotate(Tool.Destructive, false);

const WatchConnectorInstanceDeleteTool = Tool.make("t3_watch_connector_instance_delete", {
  ...shared,
  description: "Delete a connector instance and remove its stored secret values.",
  parameters: WatchConnectorDeleteInstanceInput,
  success: WatchConnectorDeleteInstanceResult,
}).annotate(Tool.Destructive, true);

const WatchConnectorInstanceSetConfigTool = Tool.make("t3_watch_connector_instance_config_set", {
  ...shared,
  description:
    "Replace a connector instance's config and write declared secret values into the server secret store. Only secret keys the pack manifest declares are accepted; secret values are never returned.",
  parameters: WatchConnectorSetInstanceConfigInput,
  success: WatchConnectorInstanceResult,
}).annotate(Tool.Destructive, false);

const WatchConnectorRequestInstallTool = Tool.make("t3_watch_connector_request_install", {
  ...shared,
  description:
    "Open a pending connector install request for a local-path or https pack origin. Local paths and public https URLs are fetched now to record the declared manifest and content hash; https URLs resolving to a loopback or private address are recorded unfetched — only the UI's human confirm path can fetch them. Installing the pack still needs a human's confirm in the UI.",
  parameters: WatchConnectorRequestInstallInput,
  success: WatchConnectorInstallRequestResult,
}).annotate(Tool.Destructive, false);

const WatchConnectorRequestUpgradeTool = Tool.make("t3_watch_connector_request_upgrade", {
  ...shared,
  description:
    "Open a pending upgrade request for an installed connector pack. The new manifest must carry the same pack id and a higher schemaVersion; installing it still needs a human's confirm in the UI.",
  parameters: WatchConnectorRequestUpgradeInput,
  success: WatchConnectorInstallRequestResult,
}).annotate(Tool.Destructive, false);

export const WatchToolkit = Toolkit.make(
  WatchNotificationsHistoryTool,
  WatchNotificationsSetPrefsTool,
  WatchConnectorsListTool,
  WatchConnectorInstanceCreateTool,
  WatchConnectorInstanceUpdateTool,
  WatchConnectorInstanceDeleteTool,
  WatchConnectorInstanceSetConfigTool,
  WatchConnectorRequestInstallTool,
  WatchConnectorRequestUpgradeTool,
);
