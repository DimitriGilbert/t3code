import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  ForwardCompatibleUnion,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WatchConnectorInstallRequestId,
  WatchConnectorInstanceId,
  WatchConnectorPackId,
  WatchNotificationId,
  WatchPageId,
  WatchWidgetId,
} from "./baseSchemas.ts";

// ── Pages ────────────────────────────────────────────────────────────────

/** `global` pages bind unbound widgets to nothing; `project` pages lend their projectId as the ambient binding. */
export const WatchPageScope = Schema.Literals(["global", "project"]);
export type WatchPageScope = typeof WatchPageScope.Type;

/**
 * A user-composed watch page. `revision` guards page-level writes (layout,
 * membership, rename/reorder); `mobileRevision` guards only the mobile
 * projection so a phone reorder can never collide with a desktop layout write.
 */
export const WatchPage = Schema.Struct({
  id: WatchPageId,
  name: TrimmedNonEmptyString,
  scope: WatchPageScope,
  /** Bound project for `scope: "project"` pages; null on global pages. */
  projectId: Schema.NullOr(ProjectId),
  /** Opaque sortable key for the page tab order; rewritten by reorder. */
  orderKey: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  mobileRevision: NonNegativeInt,
  /** Set when the page's project was deleted; the page is retained, not removed. */
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WatchPage = typeof WatchPage.Type;

// ── Widgets ──────────────────────────────────────────────────────────────

/** Registry key of a first-party widget, or `agent:<sourceId>` for a published agent-authored widget. */
export const WatchWidgetKind = TrimmedNonEmptyString;
export type WatchWidgetKind = typeof WatchWidgetKind.Type;

/**
 * Who authored the widget's code. Set at creation, never user-editable; it
 * varies the chrome marker text, never the sandbox posture.
 */
export const WatchWidgetProvenance = Schema.Union([
  Schema.Literal("firstParty"),
  Schema.Literal("agentPublished"),
  Schema.TemplateLiteral([Schema.Literal("pack:"), Schema.String]),
]);
export type WatchWidgetProvenance = typeof WatchWidgetProvenance.Type;

/** Placement on the 12-column grid; x/y are 0-based column/row origins. */
export const WatchWidgetPlacement = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
  w: PositiveInt,
  h: PositiveInt,
  /** Minimum width the widget may be resized to. */
  minCols: Schema.optionalKey(PositiveInt),
});
export type WatchWidgetPlacement = typeof WatchWidgetPlacement.Type;

/**
 * A requested refresh cadence, not a guarantee: the effective poll interval
 * belongs to the connector instance (min of subscriber requests, clamped to
 * the instance floor).
 */
export const WatchWidgetRefreshPolicy = Schema.Struct({
  intervalMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000))),
});
export type WatchWidgetRefreshPolicy = typeof WatchWidgetRefreshPolicy.Type;

const watchWidgetSourceFields = {
  /**
   * What the widget reads against: a project id for `threads`, a connector
   * instance id for `connector`. Absent bindings resolve against the page's
   * ambient scope, which is what makes per-project pages reusable templates.
   * There is deliberately no `url` kind — arbitrary egress only ever happens
   * inside an egress-allowlisted connector pack.
   */
  binding: Schema.optionalKey(TrimmedNonEmptyString),
  /** Kind-specific filter/sort parameters interpreted by the widget. */
  query: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  refreshPolicy: Schema.optionalKey(WatchWidgetRefreshPolicy),
};

export const WatchWidgetThreadsSource = Schema.Struct({
  kind: Schema.Literal("threads"),
  ...watchWidgetSourceFields,
});
export type WatchWidgetThreadsSource = typeof WatchWidgetThreadsSource.Type;

export const WatchWidgetConnectorSource = Schema.Struct({
  kind: Schema.Literal("connector"),
  ...watchWidgetSourceFields,
});
export type WatchWidgetConnectorSource = typeof WatchWidgetConnectorSource.Type;

export const WatchWidgetStaticSource = Schema.Struct({
  kind: Schema.Literal("static"),
  ...watchWidgetSourceFields,
});
export type WatchWidgetStaticSource = typeof WatchWidgetStaticSource.Type;

export const WatchWidgetSource = Schema.Union([
  WatchWidgetThreadsSource,
  WatchWidgetConnectorSource,
  WatchWidgetStaticSource,
]);
export type WatchWidgetSource = typeof WatchWidgetSource.Type;

export const WatchWidgetConfig = Schema.Struct({
  source: Schema.optionalKey(WatchWidgetSource),
  /** Kind-specific settings validated by the widget's own schema at configure time. */
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type WatchWidgetConfig = typeof WatchWidgetConfig.Type;

export const WatchWidget = Schema.Struct({
  id: WatchWidgetId,
  pageId: WatchPageId,
  kind: WatchWidgetKind,
  config: WatchWidgetConfig,
  /** Desktop grid placement; owned by the page `revision`. */
  placement: WatchWidgetPlacement,
  /** Own revision: config edits take it, so they never collide with layout drags. */
  revision: NonNegativeInt,
  /** Mobile projection order within the page; owned by the page `mobileRevision`. */
  mobileOrder: NonNegativeInt,
  /** Hidden on the mobile single-column view only. */
  mobileHidden: Schema.Boolean,
  provenance: WatchWidgetProvenance,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WatchWidget = typeof WatchWidget.Type;

// ── Errors ───────────────────────────────────────────────────────────────

export class WatchPageError extends Schema.TaggedError<WatchPageError>()("WatchPageError", {
  message: Schema.String,
  pageId: Schema.optionalKey(WatchPageId),
  widgetId: Schema.optionalKey(WatchWidgetId),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * A revision-checked write whose expected revision no longer matches. The
 * client prompts a reload rather than silently writing last-writer-wins.
 * `widgetId` is set when the conflict is on a widget's own (config) revision.
 */
export class WatchPageRevisionConflictError extends Schema.TaggedError<WatchPageRevisionConflictError>()(
  "WatchPageRevisionConflictError",
  {
    pageId: WatchPageId,
    widgetId: Schema.optionalKey(WatchWidgetId),
    /** Set when the stale revision is the page's mobile projection, not its layout revision. */
    mobileProjection: Schema.optionalKey(Schema.Boolean),
    expectedRevision: NonNegativeInt,
    currentRevision: Schema.optionalKey(NonNegativeInt),
    message: Schema.String,
  },
) {}

/** Layout writes that would overlap another widget or leave the 12-column grid. */
export class WatchLayoutCollisionError extends Schema.TaggedError<WatchLayoutCollisionError>()(
  "WatchLayoutCollisionError",
  {
    pageId: WatchPageId,
    widgetIds: Schema.Array(WatchWidgetId),
    message: Schema.String,
  },
) {}

// ── Gallery ──────────────────────────────────────────────────────────────

/** One widget in a gallery template: instantiated into a real row on use, never a seeded row. */
export const WatchGalleryTemplateWidget = Schema.Struct({
  kind: WatchWidgetKind,
  config: WatchWidgetConfig,
  placement: WatchWidgetPlacement,
});
export type WatchGalleryTemplateWidget = typeof WatchGalleryTemplateWidget.Type;

export const WatchGalleryTemplate = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  scope: WatchPageScope,
  widgets: Schema.Array(WatchGalleryTemplateWidget),
});
export type WatchGalleryTemplate = typeof WatchGalleryTemplate.Type;

// ── Page/widget RPC payloads ─────────────────────────────────────────────

export const WatchPageListInput = Schema.Struct({
  includeArchived: Schema.optionalKey(Schema.Boolean),
});
export type WatchPageListInput = typeof WatchPageListInput.Type;

export const WatchPageListResult = Schema.Struct({
  pages: ForwardCompatibleArray(WatchPage),
  widgets: ForwardCompatibleArray(WatchWidget),
});
export type WatchPageListResult = typeof WatchPageListResult.Type;

export const WatchPageCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  scope: Schema.optionalKey(WatchPageScope),
  /** Required when `scope` is `"project"`; ignored for global pages. */
  projectId: Schema.optionalKey(ProjectId),
});
export type WatchPageCreateInput = typeof WatchPageCreateInput.Type;

export const WatchPageRenameInput = Schema.Struct({
  pageId: WatchPageId,
  name: TrimmedNonEmptyString,
});
export type WatchPageRenameInput = typeof WatchPageRenameInput.Type;

export const WatchPageReorderInput = Schema.Struct({
  pageId: WatchPageId,
  /** The page to slot in front of; null moves the page to the end. */
  beforePageId: Schema.NullOr(WatchPageId),
});
export type WatchPageReorderInput = typeof WatchPageReorderInput.Type;

export const WatchPageDuplicateInput = Schema.Struct({
  pageId: WatchPageId,
});
export type WatchPageDuplicateInput = typeof WatchPageDuplicateInput.Type;

export const WatchPageDeleteInput = Schema.Struct({
  pageId: WatchPageId,
});
export type WatchPageDeleteInput = typeof WatchPageDeleteInput.Type;

export const WatchPageInstantiateFromGalleryInput = Schema.Struct({
  templateId: TrimmedNonEmptyString,
  /** When set, the instance is scoped to this project instead of the template scope. */
  projectId: Schema.optionalKey(ProjectId),
});
export type WatchPageInstantiateFromGalleryInput = typeof WatchPageInstantiateFromGalleryInput.Type;

export const WatchPageResult = Schema.Struct({
  page: WatchPage,
});
export type WatchPageResult = typeof WatchPageResult.Type;

export const WatchPageWithWidgetsResult = Schema.Struct({
  page: WatchPage,
  widgets: Schema.Array(WatchWidget),
});
export type WatchPageWithWidgetsResult = typeof WatchPageWithWidgetsResult.Type;

export const WatchPageDeleteResult = Schema.Struct({
  id: WatchPageId,
});
export type WatchPageDeleteResult = typeof WatchPageDeleteResult.Type;

export const WatchWidgetAddInput = Schema.Struct({
  pageId: WatchPageId,
  /** Membership changes are page-revision checked. */
  expectedRevision: NonNegativeInt,
  kind: WatchWidgetKind,
  config: Schema.optionalKey(WatchWidgetConfig),
  placement: WatchWidgetPlacement,
});
export type WatchWidgetAddInput = typeof WatchWidgetAddInput.Type;

export const WatchWidgetRemoveInput = Schema.Struct({
  pageId: WatchPageId,
  widgetId: WatchWidgetId,
  expectedRevision: NonNegativeInt,
});
export type WatchWidgetRemoveInput = typeof WatchWidgetRemoveInput.Type;

export const WatchWidgetRemoveResult = Schema.Struct({
  id: WatchWidgetId,
});
export type WatchWidgetRemoveResult = typeof WatchWidgetRemoveResult.Type;

/** Config-only edit; checked against the widget's own revision. */
export const WatchWidgetConfigureInput = Schema.Struct({
  widgetId: WatchWidgetId,
  expectedRevision: NonNegativeInt,
  config: WatchWidgetConfig,
});
export type WatchWidgetConfigureInput = typeof WatchWidgetConfigureInput.Type;

export const WatchWidgetPlacementPatch = Schema.Struct({
  widgetId: WatchWidgetId,
  placement: WatchWidgetPlacement,
});
export type WatchWidgetPlacementPatch = typeof WatchWidgetPlacementPatch.Type;

export const WatchWidgetSetLayoutInput = Schema.Struct({
  pageId: WatchPageId,
  expectedRevision: NonNegativeInt,
  layouts: Schema.Array(WatchWidgetPlacementPatch),
});
export type WatchWidgetSetLayoutInput = typeof WatchWidgetSetLayoutInput.Type;

const WatchWidgetMobileProjectionPatch = Schema.Struct({
  widgetId: WatchWidgetId,
  mobileOrder: NonNegativeInt,
  mobileHidden: Schema.Boolean,
});

/**
 * Writes only `mobileOrder`/`mobileHidden`, guarded by the page's
 * `mobileRevision` — it can never touch or conflict with desktop layout.
 */
export const WatchWidgetSetMobileProjectionInput = Schema.Struct({
  pageId: WatchPageId,
  expectedMobileRevision: NonNegativeInt,
  widgets: Schema.Array(WatchWidgetMobileProjectionPatch),
});
export type WatchWidgetSetMobileProjectionInput = typeof WatchWidgetSetMobileProjectionInput.Type;

/** Moves one widget between pages; a stale revision on either page rejects the whole move. */
export const WatchWidgetMoveToPageInput = Schema.Struct({
  widgetId: WatchWidgetId,
  sourcePageId: WatchPageId,
  sourceExpectedRevision: NonNegativeInt,
  destinationPageId: WatchPageId,
  destinationExpectedRevision: NonNegativeInt,
  placement: WatchWidgetPlacement,
});
export type WatchWidgetMoveToPageInput = typeof WatchWidgetMoveToPageInput.Type;

export const WatchWidgetResult = Schema.Struct({
  widget: WatchWidget,
});
export type WatchWidgetResult = typeof WatchWidgetResult.Type;

export const WatchGalleryListResult = Schema.Struct({
  templates: ForwardCompatibleArray(WatchGalleryTemplate),
});
export type WatchGalleryListResult = typeof WatchGalleryListResult.Type;

// ── Connectors (contracts only; runtime lands in a later phase) ──────────

export const WatchConnectorTransport = Schema.Literals(["http", "file"]);
export type WatchConnectorTransport = typeof WatchConnectorTransport.Type;

export const WatchConnectorOperation = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WatchConnectorOperation = typeof WatchConnectorOperation.Type;

/**
 * The pack contract a human confirms at install: declared operations, declared
 * egress hosts, declared secret keys, and the transport the pack uses.
 */
export const WatchConnectorPackManifest = Schema.Struct({
  id: WatchConnectorPackId,
  schemaVersion: PositiveInt,
  /** Field schema instance config is validated against. */
  authSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  operations: ForwardCompatibleArray(WatchConnectorOperation),
  /** Hosts the pack's fetch code may egress to; enforced by the fetch layer. */
  egressHosts: Schema.Array(TrimmedNonEmptyString),
  /** Secret keys the pack may read at fetch time; values live in the secret store. */
  secretKeys: Schema.Array(TrimmedNonEmptyString),
  transport: WatchConnectorTransport,
});
export type WatchConnectorPackManifest = typeof WatchConnectorPackManifest.Type;

export const WatchConnectorOrigin = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("localPath"),
    path: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("httpsUrl"),
    url: TrimmedNonEmptyString,
    /** Explicitly confirmed by the user for loopback/private-range URLs. */
    allowLocalUrl: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type WatchConnectorOrigin = typeof WatchConnectorOrigin.Type;

export const WatchConnectorHealth = Schema.Struct({
  status: Schema.Literals(["healthy", "unhealthy", "authExpired", "unknown"]),
  lastError: Schema.NullOr(Schema.String),
  lastFetchAt: Schema.NullOr(IsoDateTime),
  consecutiveFailures: NonNegativeInt,
});
export type WatchConnectorHealth = typeof WatchConnectorHealth.Type;

export const WatchConnectorInstance = Schema.Struct({
  id: WatchConnectorInstanceId,
  packId: WatchConnectorPackId,
  /** Pack schema version this instance is pinned to; upgrades move it explicitly. */
  schemaVersion: PositiveInt,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  /** User/agent-written instance config (no secrets — those live in the secret store by key). */
  config: Schema.Record(Schema.String, Schema.Unknown),
  origin: WatchConnectorOrigin,
  /** SHA-256 of the pack bundle the instance was approved against. */
  contentHash: TrimmedNonEmptyString,
  health: WatchConnectorHealth,
  /** Soft-archived on uninstall: polling stops, config retained. */
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WatchConnectorInstance = typeof WatchConnectorInstance.Type;

/** A pending install/upgrade a human must confirm; neither leg is agent-completable. */
export const WatchConnectorInstallRequest = Schema.Struct({
  id: WatchConnectorInstallRequestId,
  kind: Schema.Literals(["install", "upgrade"]),
  status: Schema.Literals(["pending", "confirmed", "cancelled"]),
  packId: WatchConnectorPackId,
  origin: WatchConnectorOrigin,
  contentHash: TrimmedNonEmptyString,
  /** The manifest as fetched; the confirm token is bound to its hash. */
  manifest: WatchConnectorPackManifest,
  /** Present on upgrades: what the user is diffed against. */
  upgrade: Schema.optionalKey(
    Schema.Struct({
      fromSchemaVersion: PositiveInt,
      instanceId: Schema.optionalKey(WatchConnectorInstanceId),
    }),
  ),
  createdAt: IsoDateTime,
});
export type WatchConnectorInstallRequest = typeof WatchConnectorInstallRequest.Type;

// ── Notifications (contracts only; the service lands in a later phase) ───

const watchNotificationFields = {
  /** Stable id so each channel dedupes `(notificationId, channel)` client-side. */
  notificationId: WatchNotificationId,
  createdAt: IsoDateTime,
};

export const WatchThreadCompletedNotification = Schema.Struct({
  type: Schema.Literal("thread.completed"),
  ...watchNotificationFields,
  threadId: ThreadId,
  projectId: ProjectId,
});
export type WatchThreadCompletedNotification = typeof WatchThreadCompletedNotification.Type;

export const WatchThreadFailedNotification = Schema.Struct({
  type: Schema.Literal("thread.failed"),
  ...watchNotificationFields,
  threadId: ThreadId,
  projectId: ProjectId,
  error: Schema.optionalKey(Schema.String),
});
export type WatchThreadFailedNotification = typeof WatchThreadFailedNotification.Type;

export const WatchThreadAwaitingInputNotification = Schema.Struct({
  type: Schema.Literal("thread.awaitingInput"),
  ...watchNotificationFields,
  threadId: ThreadId,
  projectId: ProjectId,
});
export type WatchThreadAwaitingInputNotification = typeof WatchThreadAwaitingInputNotification.Type;

export const WatchConnectorUnhealthyNotification = Schema.Struct({
  type: Schema.Literal("connector.unhealthy"),
  ...watchNotificationFields,
  instanceId: WatchConnectorInstanceId,
});
export type WatchConnectorUnhealthyNotification = typeof WatchConnectorUnhealthyNotification.Type;

export const WatchConnectorAuthExpiredNotification = Schema.Struct({
  type: Schema.Literal("connector.authExpired"),
  ...watchNotificationFields,
  instanceId: WatchConnectorInstanceId,
});
export type WatchConnectorAuthExpiredNotification =
  typeof WatchConnectorAuthExpiredNotification.Type;

export const WatchWidgetThresholdNotification = Schema.Struct({
  type: Schema.Literal("widget.threshold"),
  ...watchNotificationFields,
  widgetId: WatchWidgetId,
  pageId: Schema.optionalKey(WatchPageId),
  instanceId: Schema.optionalKey(WatchConnectorInstanceId),
  summary: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WatchWidgetThresholdNotification = typeof WatchWidgetThresholdNotification.Type;

/**
 * The notification union is transport-extensible: a newer server may add
 * event types, and older clients decode them as unknown members they can
 * ignore — this is what makes mobile push additive later.
 */
export const WatchNotificationEvent = ForwardCompatibleUnion(
  [
    WatchThreadCompletedNotification,
    WatchThreadFailedNotification,
    WatchThreadAwaitingInputNotification,
    WatchConnectorUnhealthyNotification,
    WatchConnectorAuthExpiredNotification,
    WatchWidgetThresholdNotification,
  ],
  "type",
);
export type WatchNotificationEvent = typeof WatchNotificationEvent.Type;

export const WatchNotificationEventType = Schema.Literals([
  "thread.completed",
  "thread.failed",
  "thread.awaitingInput",
  "connector.unhealthy",
  "connector.authExpired",
  "widget.threshold",
]);
export type WatchNotificationEventType = typeof WatchNotificationEventType.Type;

/** Every way in has a way out: per-type mute, per-page mute, snooze/unsnooze. */
export const WatchNotificationPrefs = Schema.Struct({
  mutedEventTypes: Schema.Array(WatchNotificationEventType),
  mutedPageIds: Schema.Array(WatchPageId),
  snoozedUntil: Schema.NullOr(IsoDateTime),
});
export type WatchNotificationPrefs = typeof WatchNotificationPrefs.Type;

/** History always records, even for muted deliveries; muting is a delivery decision. */
export const WatchNotificationHistoryEntry = Schema.Struct({
  notification: WatchNotificationEvent,
  recordedAt: IsoDateTime,
});
export type WatchNotificationHistoryEntry = typeof WatchNotificationHistoryEntry.Type;

export class WatchNotificationError extends Schema.TaggedError<WatchNotificationError>()(
  "WatchNotificationError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/**
 * One item on the notification subscription: the client's current prefs first
 * (and again after every `setPrefs`), then each notification the server emits.
 */
export const WatchNotificationStreamItem = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("prefs"),
    prefs: WatchNotificationPrefs,
  }),
  Schema.Struct({
    type: Schema.Literal("notification"),
    notification: WatchNotificationEvent,
  }),
]);
export type WatchNotificationStreamItem = typeof WatchNotificationStreamItem.Type;

export const WatchNotificationsHistoryInput = Schema.Struct({
  /** Newest-first; defaults server-side when omitted. */
  limit: Schema.optionalKey(PositiveInt),
});
export type WatchNotificationsHistoryInput = typeof WatchNotificationsHistoryInput.Type;

export const WatchNotificationsHistoryResult = Schema.Struct({
  entries: ForwardCompatibleArray(WatchNotificationHistoryEntry),
});
export type WatchNotificationsHistoryResult = typeof WatchNotificationsHistoryResult.Type;

export const WatchNotificationsSetPrefsResult = Schema.Struct({
  prefs: WatchNotificationPrefs,
});
export type WatchNotificationsSetPrefsResult = typeof WatchNotificationsSetPrefsResult.Type;

// ── Agent-authored widgets (contracts only; pipeline lands in a later phase)

/** Declared bridge surface: the only data subscriptions and actions the frame may use. */
export const WatchWidgetBridgeManifest = Schema.Struct({
  subscriptions: Schema.Array(TrimmedNonEmptyString),
  actions: Schema.Array(TrimmedNonEmptyString),
});
export type WatchWidgetBridgeManifest = typeof WatchWidgetBridgeManifest.Type;

export const WatchWidgetSourcePublishInput = Schema.Struct({
  /** The TS/TSX source the server transpiles into a sandboxed bundle. */
  source: TrimmedNonEmptyString,
  manifest: WatchWidgetBridgeManifest,
});
export type WatchWidgetSourcePublishInput = typeof WatchWidgetSourcePublishInput.Type;

// ── Widget error states ──────────────────────────────────────────────────

const watchWidgetErrorFields = {
  /** When the widget last rendered good data, for the "last good data at HH:MM" line. */
  lastGoodDataAt: Schema.optionalKey(IsoDateTime),
};

/** Typed widget-shell error: one-line cause plus a primary recovery action per cause. */
export const WatchWidgetErrorState = Schema.Union([
  Schema.Struct({
    cause: Schema.Literal("connectorDown"),
    instanceId: Schema.optionalKey(WatchConnectorInstanceId),
    ...watchWidgetErrorFields,
  }),
  Schema.Struct({
    cause: Schema.Literal("credentialsInvalid"),
    instanceId: Schema.optionalKey(WatchConnectorInstanceId),
    ...watchWidgetErrorFields,
  }),
  Schema.Struct({
    cause: Schema.Literal("configMismatch"),
    /** The config field that failed validation, when known. */
    field: Schema.optionalKey(TrimmedNonEmptyString),
    ...watchWidgetErrorFields,
  }),
  Schema.Struct({
    cause: Schema.Literal("connectorMissing"),
    instanceId: Schema.optionalKey(WatchConnectorInstanceId),
    ...watchWidgetErrorFields,
  }),
  Schema.Struct({
    cause: Schema.Literal("connectorSnapshotTooLarge"),
    instanceId: Schema.optionalKey(WatchConnectorInstanceId),
    ...watchWidgetErrorFields,
  }),
  Schema.Struct({
    cause: Schema.Literal("projectMissing"),
    projectId: Schema.optionalKey(ProjectId),
    ...watchWidgetErrorFields,
  }),
  Schema.Struct({
    cause: Schema.Literal("transpileFailed"),
    ...watchWidgetErrorFields,
  }),
]);
export type WatchWidgetErrorState = typeof WatchWidgetErrorState.Type;
