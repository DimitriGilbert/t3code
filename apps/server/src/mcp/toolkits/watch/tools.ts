import {
  OrchestratorMcpFailure,
  WatchConnectorCreateInstanceInput,
  WatchConnectorDeleteInstanceInput,
  WatchConnectorDeleteInstanceResult,
  WatchConnectorInstallRequestResult,
  WatchConnectorInstanceResult,
  WatchConnectorRequestInstallInput,
  WatchConnectorRequestUpgradeInput,
  WatchConnectorRollbackInput,
  WatchConnectorSetInstanceConfigInput,
  WatchConnectorUninstallInput,
  WatchConnectorUninstallResult,
  WatchConnectorsListInput,
  WatchConnectorsListResult,
  WatchConnectorUpdateInstanceInput,
  WatchNotificationPrefs,
  WatchNotificationsHistoryInput,
  WatchNotificationsHistoryResult,
  WatchNotificationsSetPrefsResult,
  WatchPageListInput,
  WatchPageListResult,
  WatchWidgetExportInput,
  WatchWidgetExportResult,
  WatchWidgetImportInput,
  WatchWidgetImportResult,
  WatchWidgetSourcePublishInput,
  WatchWidgetSourcePublishResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UserNotificationService from "../../../notifications/UserNotificationService.ts";
import * as WatchPageService from "../../../watch/WatchPageService.ts";
import * as WatchWidgetTransferService from "../../../watch/WatchWidgetTransferService.ts";
import * as WidgetTranspileService from "../../../watch/WidgetTranspileService.ts";
import * as ConnectorService from "../../../watch/connectors/ConnectorService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    UserNotificationService.UserNotificationService,
    WatchPageService.WatchPageService,
    WatchWidgetTransferService.WatchWidgetTransferService,
    WidgetTranspileService.WidgetTranspileService,
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

// An agent muting or snoozing suppresses delivery only: notification
// history is append-only and records every emission regardless, so
// agent-driven suppression stays tamper-evident. That residual is accepted
// rather than prevented.
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

const WatchConnectorRollbackTool = Tool.make("t3_watch_connector_rollback", {
  ...shared,
  description:
    "Re-pin a connector instance to a previously-approved version of its pack. Uses the version already installed on disk — nothing is fetched. Runs the target pack's migrateConfig server-side; if it fails the instance keeps its config and reports unhealthy so bound widgets render the configMismatch state. Every rollback is recorded in notification history.",
  parameters: WatchConnectorRollbackInput,
  success: WatchConnectorInstanceResult,
}).annotate(Tool.Destructive, false);

const WatchConnectorUninstallTool = Tool.make("t3_watch_connector_uninstall", {
  ...shared,
  description:
    "Soft-archive a connector pack and all its instances: polling stops and bound widgets degrade to the connector-missing placeholder, but config, secrets, approved versions, and pack files are retained. Reinstalling an approved version revives its instances. Permanent removal is human-only — there is no purge tool.",
  parameters: WatchConnectorUninstallInput,
  success: WatchConnectorUninstallResult,
}).annotate(Tool.Destructive, true);

const WatchWidgetSourcePublishTool = Tool.make("t3_watch_widget_source_publish", {
  ...shared,
  description:
    'Publish agent-authored TS/TSX widget source. The server transpiles it into the cached single-file sandbox bundle and returns the source record; republishing identical {source, manifest} reuses the same sourceId. A bad build is returned as a status: "failed" record with transpile diagnostics — not a tool error — so check status before mounting. Sources must be one self-contained file: imports are rejected, and JSX lowers to the host-provided T3 runtime (T3.h / T3.Fragment), so do not reference React or any module. Declare every data subscription and action the widget uses in the bridge manifest.',
  parameters: WatchWidgetSourcePublishInput,
  success: WatchWidgetSourcePublishResult,
}).annotate(Tool.Destructive, false);

/**
 * Page and widget ids are how the export/import tools name their targets —
 * without this list an agent cannot discover them.
 */
const WatchPagesListTool = Tool.make("t3_watch_pages_list", {
  ...shared,
  description:
    "List this server's watch pages and their widgets, including the page ids, widget ids, and page revisions that widget export and import need.",
  parameters: WatchPageListInput,
  success: WatchPageListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WatchWidgetExportTool = Tool.make("t3_watch_widget_export", {
  ...shared,
  description:
    "Export one watch widget as a portable t3.watch-widget JSON document: its kind, config, and size hint, plus the authored source and bridge manifest embedded for agent-authored kinds. The document carries no ids or placement, so it imports cleanly onto any page, environment, or server.",
  parameters: WatchWidgetExportInput,
  success: WatchWidgetExportResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WatchWidgetImportTool = Tool.make("t3_watch_widget_import", {
  ...shared,
  description:
    "Import a t3.watch-widget export document onto a watch page. Embedded agent source is re-transpiled server-side and its recomputed identity is checked against the declared kind; pack widgets require the same connector pack installed here. expectedRevision is the page's current revision from t3_watch_pages_list — the write fails when the page changed since. Omit placement to append below the page's existing widgets.",
  parameters: WatchWidgetImportInput,
  success: WatchWidgetImportResult,
}).annotate(Tool.Destructive, false);

export const WatchToolkit = Toolkit.make(
  WatchNotificationsHistoryTool,
  WatchNotificationsSetPrefsTool,
  WatchWidgetSourcePublishTool,
  WatchPagesListTool,
  WatchWidgetExportTool,
  WatchWidgetImportTool,
  WatchConnectorsListTool,
  WatchConnectorInstanceCreateTool,
  WatchConnectorInstanceUpdateTool,
  WatchConnectorInstanceDeleteTool,
  WatchConnectorInstanceSetConfigTool,
  WatchConnectorRequestInstallTool,
  WatchConnectorRequestUpgradeTool,
  WatchConnectorRollbackTool,
  WatchConnectorUninstallTool,
);
