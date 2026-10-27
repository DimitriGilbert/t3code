// Method tables for the typed client. Hand-written counterpart of codex's
// generated meta.gen.ts — the v4 + legacy subset T3 drives, matching schema.ts.
import * as Schema from "effect/Schema";

import * as ZCodeSchema from "./schema.ts";

export const V4_METHODS = {
  connectionFlow: "v4/connection/flow",
  conversationSubscribe: "v4/conversation/subscribe",
  sessionsIndexReconcile: "v4/sessionsIndex/reconcile",
  conversationResync: "v4/conversation/resync",
  conversationUnsubscribe: "v4/conversation/unsubscribe",
  conversationRowsRange: "v4/conversation/rowsRange",
  conversationPlans: "v4/conversation/plans",
  conversationFileChanges: "v4/conversation/fileChanges",
  backgroundBashOutput: "v4/conversation/backgroundBashOutput",
  conversationFileRewindPreview: "v4/conversation/fileRewindPreview",
  usageStats: "v4/usage/stats",
  conversationUsage: "v4/conversation/usage",
  attachmentBegin: "v4/attachment/begin",
  attachmentChunk: "v4/attachment/chunk",
  attachmentCommit: "v4/attachment/commit",
  attachmentAbort: "v4/attachment/abort",
  attachmentRead: "v4/attachment/read",
  conversationAttachmentRead: "v4/conversation/attachmentRead",
  conversationAttachmentStat: "v4/conversation/attachmentStat",
  commandsQuery: "v4/commands/query",
  command: "v4/command",
} as const;

export const LEGACY_METHODS = {
  sessionList: "session/list",
  sessionClose: "session/close",
  skillsReferenceCatalog: "skills/referenceCatalog",
  pluginsReferenceCatalog: "plugins/referenceCatalog",
  providerUpdateAccountConfig: "provider/updateAccountConfig",
  providerRefreshRegistry: "provider/refreshRegistry",
  providerTestModelConnectivity: "provider/testModelConnectivity",
  workspaceGenerateText: "workspace/generateText",
  workspaceCancelGenerateText: "workspace/cancelGenerateText",
} as const;

export const SERVER_REQUEST_METHODS = {
  sessionRequestRuntimePreferences: "session/requestRuntimePreferences",
  interactionRequestPermission: "interaction/requestPermission",
  interactionRequestUserInput: "interaction/requestUserInput",
  interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
  interactionRequestOfficialMcpAuthHeaders: "interaction/requestOfficialMcpAuthHeaders",
  interactionBrowserList: "interaction/browserList",
  interactionBrowserExecute: "interaction/browserExecute",
} as const;

export const SERVER_NOTIFICATION_METHODS = {
  storageStartup: "startup/storageState",
  conversationFrame: "v4/conversation/frame",
  providerRuntimeHeadersCancelled: "interaction/providerRuntimeHeadersCancelled",
} as const;

const emptyResult = Schema.Struct({});

export const CLIENT_REQUEST_PARAMS = {
  [V4_METHODS.conversationSubscribe]: ZCodeSchema.V4ConversationSubscribeParams,
  [V4_METHODS.conversationResync]: ZCodeSchema.V4ConversationResyncParams,
  [V4_METHODS.conversationUnsubscribe]: ZCodeSchema.V4ConversationUnsubscribeParams,
  [V4_METHODS.sessionsIndexReconcile]: ZCodeSchema.SessionsIndexReconcileParams,
  [V4_METHODS.conversationRowsRange]: ZCodeSchema.V4ConversationRowsRangeParams,
  [V4_METHODS.conversationPlans]: ZCodeSchema.V4ConversationPlansParams,
  [V4_METHODS.conversationFileChanges]: ZCodeSchema.V4ConversationFileChangesParams,
  [V4_METHODS.backgroundBashOutput]: ZCodeSchema.V4BackgroundBashOutputParams,
  [V4_METHODS.conversationFileRewindPreview]: ZCodeSchema.V4ConversationFileRewindPreviewParams,
  [V4_METHODS.usageStats]: ZCodeSchema.V4UsageStatsParams,
  [V4_METHODS.conversationUsage]: ZCodeSchema.V4ConversationUsageParams,
  [V4_METHODS.attachmentBegin]: ZCodeSchema.V4AttachmentBeginParams,
  [V4_METHODS.attachmentChunk]: ZCodeSchema.V4AttachmentChunkParams,
  [V4_METHODS.attachmentCommit]: ZCodeSchema.V4AttachmentCommitParams,
  [V4_METHODS.attachmentAbort]: ZCodeSchema.V4AttachmentAbortParams,
  [V4_METHODS.attachmentRead]: ZCodeSchema.V4AttachmentReadParams,
  [V4_METHODS.conversationAttachmentRead]: ZCodeSchema.V4ConversationAttachmentReadParams,
  [V4_METHODS.conversationAttachmentStat]: ZCodeSchema.V4ConversationAttachmentStatParams,
  [V4_METHODS.connectionFlow]: ZCodeSchema.V4ConnectionFlowParams,
  [V4_METHODS.commandsQuery]: ZCodeSchema.CommandsQueryParams,
  [V4_METHODS.command]: ZCodeSchema.CommandEnvelopeWire,
  [LEGACY_METHODS.sessionList]: ZCodeSchema.ZCodeSessionListParams,
  [LEGACY_METHODS.sessionClose]: ZCodeSchema.ZCodeSessionCloseParams,
  [LEGACY_METHODS.skillsReferenceCatalog]: ZCodeSchema.ZCodeSkillsReferenceCatalogParams,
  [LEGACY_METHODS.pluginsReferenceCatalog]: ZCodeSchema.ZCodePluginsReferenceCatalogParams,
  [LEGACY_METHODS.providerUpdateAccountConfig]: ZCodeSchema.ZCodeProviderUpdateAccountConfigParams,
  [LEGACY_METHODS.providerRefreshRegistry]: ZCodeSchema.ZCodeProviderRefreshRegistryParams,
  [LEGACY_METHODS.providerTestModelConnectivity]:
    ZCodeSchema.ZCodeProviderTestModelConnectivityParams,
  [LEGACY_METHODS.workspaceGenerateText]: ZCodeSchema.ZCodeWorkspaceGenerateTextParams,
  [LEGACY_METHODS.workspaceCancelGenerateText]: ZCodeSchema.ZCodeWorkspaceCancelGenerateTextParams,
} as const;

export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_PARAMS;
export type ClientRequestParamsByMethod = {
  readonly [M in ClientRequestMethod]: M extends "v4/command"
    ? ZCodeSchema.CommandEnvelope
    : Schema.Schema.Type<(typeof CLIENT_REQUEST_PARAMS)[M]>;
};

export const CLIENT_REQUEST_RESPONSES = {
  [V4_METHODS.conversationSubscribe]: ZCodeSchema.V4ConversationSubscribeResult,
  [V4_METHODS.conversationResync]: ZCodeSchema.V4ConversationResyncResult,
  [V4_METHODS.conversationUnsubscribe]: emptyResult,
  [V4_METHODS.sessionsIndexReconcile]: ZCodeSchema.SessionsIndexReconcileResult,
  [V4_METHODS.conversationRowsRange]: ZCodeSchema.V4ConversationRowsRangeResult,
  [V4_METHODS.conversationPlans]: ZCodeSchema.V4ConversationPlansResult,
  [V4_METHODS.conversationFileChanges]: ZCodeSchema.V4ConversationFileChangesResult,
  [V4_METHODS.backgroundBashOutput]: ZCodeSchema.V4BackgroundBashOutputResult,
  [V4_METHODS.conversationFileRewindPreview]: ZCodeSchema.V4FileRewindPreviewResult,
  [V4_METHODS.usageStats]: ZCodeSchema.V4UsageStatsResult,
  [V4_METHODS.conversationUsage]: ZCodeSchema.V4ConversationUsageResult,
  [V4_METHODS.attachmentBegin]: ZCodeSchema.V4AttachmentBeginResult,
  [V4_METHODS.attachmentChunk]: ZCodeSchema.V4AttachmentChunkResult,
  [V4_METHODS.attachmentCommit]: ZCodeSchema.V4AttachmentCommitResult,
  [V4_METHODS.attachmentAbort]: ZCodeSchema.V4AttachmentAbortResult,
  [V4_METHODS.attachmentRead]: ZCodeSchema.V4AttachmentReadResult,
  [V4_METHODS.conversationAttachmentRead]: ZCodeSchema.V4ConversationAttachmentReadResult,
  [V4_METHODS.conversationAttachmentStat]: ZCodeSchema.V4ConversationAttachmentStatResult,
  [V4_METHODS.connectionFlow]: ZCodeSchema.V4ConnectionFlowResult,
  [V4_METHODS.commandsQuery]: ZCodeSchema.CommandsQueryResult,
  [V4_METHODS.command]: ZCodeSchema.CommandAck,
  [LEGACY_METHODS.sessionList]: ZCodeSchema.ZCodeSessionListResult,
  [LEGACY_METHODS.sessionClose]: ZCodeSchema.ZCodeSessionCloseResult,
  [LEGACY_METHODS.skillsReferenceCatalog]: ZCodeSchema.ZCodeSkillsReferenceCatalogResult,
  [LEGACY_METHODS.pluginsReferenceCatalog]: ZCodeSchema.ZCodePluginsReferenceCatalogResult,
  [LEGACY_METHODS.providerUpdateAccountConfig]: ZCodeSchema.ZCodeProviderUpdateAccountConfigResult,
  [LEGACY_METHODS.providerRefreshRegistry]: ZCodeSchema.ZCodeProviderRefreshRegistryResult,
  [LEGACY_METHODS.providerTestModelConnectivity]:
    ZCodeSchema.ZCodeProviderTestModelConnectivityResult,
  [LEGACY_METHODS.workspaceGenerateText]: ZCodeSchema.ZCodeWorkspaceGenerateTextResult,
  [LEGACY_METHODS.workspaceCancelGenerateText]: ZCodeSchema.ZCodeWorkspaceCancelGenerateTextResult,
} as const;

export type ClientRequestResponseMethod = keyof typeof CLIENT_REQUEST_RESPONSES;
export type ClientRequestResponsesByMethod = {
  readonly [M in ClientRequestResponseMethod]: Schema.Schema.Type<
    (typeof CLIENT_REQUEST_RESPONSES)[M]
  >;
};

export const SERVER_REQUEST_PARAMS = {
  [SERVER_REQUEST_METHODS.sessionRequestRuntimePreferences]:
    ZCodeSchema.ZCodeSessionRequestRuntimePreferencesParams,
  [SERVER_REQUEST_METHODS.interactionRequestPermission]: ZCodeSchema.ZCodePermissionRequestParams,
  [SERVER_REQUEST_METHODS.interactionRequestUserInput]: ZCodeSchema.ZCodeUserInputRequestParams,
  [SERVER_REQUEST_METHODS.interactionRequestProviderRuntimeHeaders]:
    ZCodeSchema.ZCodeProviderRuntimeHeadersRequestParams,
  [SERVER_REQUEST_METHODS.interactionRequestOfficialMcpAuthHeaders]:
    ZCodeSchema.ZCodeOfficialMcpAuthHeadersRequestParams,
  [SERVER_REQUEST_METHODS.interactionBrowserList]: ZCodeSchema.ZCodeBrowserListParams,
  [SERVER_REQUEST_METHODS.interactionBrowserExecute]: ZCodeSchema.ZCodeBrowserExecuteParams,
} as const;

export type ServerRequestMethod = keyof typeof SERVER_REQUEST_PARAMS;
export type ServerRequestParamsByMethod = {
  readonly [M in ServerRequestMethod]: Schema.Schema.Type<(typeof SERVER_REQUEST_PARAMS)[M]>;
};

export const SERVER_REQUEST_RESPONSES = {
  [SERVER_REQUEST_METHODS.sessionRequestRuntimePreferences]:
    ZCodeSchema.ZCodeSessionRuntimePreferencesResult,
  [SERVER_REQUEST_METHODS.interactionRequestPermission]: ZCodeSchema.ZCodePermissionResponse,
  [SERVER_REQUEST_METHODS.interactionRequestUserInput]: ZCodeSchema.ZCodeUserInputResponse,
  [SERVER_REQUEST_METHODS.interactionRequestProviderRuntimeHeaders]:
    ZCodeSchema.ZCodeProviderRuntimeHeadersResponse,
  [SERVER_REQUEST_METHODS.interactionRequestOfficialMcpAuthHeaders]:
    ZCodeSchema.ZCodeOfficialMcpAuthHeadersResponse,
  // No T3 browser executor; handlers answer these with a protocol error.
  [SERVER_REQUEST_METHODS.interactionBrowserList]: Schema.Unknown,
  [SERVER_REQUEST_METHODS.interactionBrowserExecute]: Schema.Unknown,
} as const;

export type ServerRequestResponsesByMethod = {
  readonly [M in ServerRequestMethod]: Schema.Schema.Type<(typeof SERVER_REQUEST_RESPONSES)[M]>;
};

export const SERVER_NOTIFICATION_PARAMS = {
  [SERVER_NOTIFICATION_METHODS.storageStartup]: ZCodeSchema.ZCodeStorageStartupState,
  // Params are the physical TopicWireFrame envelope; the wire layer decodes
  // and reassembles it into a RoutedTopicFrame before schema validation.
  [SERVER_NOTIFICATION_METHODS.conversationFrame]: Schema.Unknown,
  [SERVER_NOTIFICATION_METHODS.providerRuntimeHeadersCancelled]:
    ZCodeSchema.ZCodeProviderRuntimeHeadersCancelled,
} as const;

export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_PARAMS;
export type ServerNotificationParamsByMethod = {
  readonly [M in ServerNotificationMethod]: Schema.Schema.Type<
    (typeof SERVER_NOTIFICATION_PARAMS)[M]
  >;
};
