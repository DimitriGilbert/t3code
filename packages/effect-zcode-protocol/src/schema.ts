// Hand-ported Effect Schemas for the ZCode Protocol v4 surface T3 consumes
// (zai-org/ZCode ships zod-only definitions). Skipped surfaces — workflow
// internals, plugin-management/mcp/automation/CUA/bots, and decorative row
// fields — decode as Unknown or are absent, noted at each schema site.
import * as Schema from "effect/Schema";

import * as ZCodeError from "./errors.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const nonEmptyString = Schema.NonEmptyString;
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// ── shared primitives ──

export const Timestamp = Schema.Number;
export type Timestamp = typeof Timestamp.Type;

export const ZCodeWorkspaceRef = Schema.Struct({
  workspacePath: nonEmptyString,
  workspaceIdentity: Schema.optionalKey(nonEmptyString),
  remoteSessionId: Schema.optionalKey(nonEmptyString),
  workspaceKey: nonEmptyString,
});
export type ZCodeWorkspaceRef = typeof ZCodeWorkspaceRef.Type;

export const ModelSelection = Schema.Struct({
  providerId: nonEmptyString,
  modelId: nonEmptyString,
  options: Schema.optionalKey(
    Schema.Struct({ reasoningLevel: Schema.optionalKey(nonEmptyString) }),
  ),
});
export type ModelSelection = typeof ModelSelection.Type;

export const SubmissionMode = Schema.Literals(["build", "edit", "plan", "yolo", "guarded"]);
export type SubmissionMode = typeof SubmissionMode.Type;

export const AttachmentRef = Schema.Struct({
  ref: Schema.String,
  fileName: Schema.String,
  mime: Schema.String,
  bytes: Schema.Number,
  sourceKind: Schema.optionalKey(Schema.String),
  messageCount: Schema.optionalKey(Schema.Int),
  previewRef: Schema.optionalKey(Schema.String),
});
export type AttachmentRef = typeof AttachmentRef.Type;

export const ConversationRowTarget = Schema.Struct({
  rowId: Schema.Int,
  entityId: nonEmptyString,
});
export type ConversationRowTarget = typeof ConversationRowTarget.Type;

// ── storage startup notification (startup/storageState) ──

// Upstream zcodeStorageStartupStateSchema: a malformed frame (sequence <= 0,
// failed without errorCode, unknown errorCode) is dropped by the gate rather
// than poisoning it — the constraints below are load-bearing, not decorative.
export const ZCodeStorageStartupState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: nonEmptyString.check(Schema.isMaxLength(128)),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  databaseId: nonEmptyString.check(Schema.isMaxLength(128)),
  databaseKind: Schema.Literals(["session", "tasks-index"]),
  phase: Schema.Literals([
    "checking",
    "waiting_for_lock",
    "migrating",
    "committing",
    "ready",
    "failed",
  ]),
  migration: Schema.optionalKey(JsonObject),
  elapsedMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  completed: Schema.optionalKey(nonNegativeInt),
  total: Schema.optionalKey(nonNegativeInt),
  errorCode: Schema.optionalKey(ZCodeError.ZCodeStorageStartupErrorCode),
  sqliteCode: Schema.optionalKey(Schema.Int),
  systemCode: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  migrationId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
}).check(
  Schema.makeFilter((state) =>
    state.phase === "failed" && state.errorCode === undefined
      ? { path: ["errorCode"], issue: "failed requires errorCode" }
      : undefined,
  ),
);
export type ZCodeStorageStartupState = typeof ZCodeStorageStartupState.Type;

// ── topic frames ──

const topicFrame = <S, D>(snapshot: Schema.Schema<S>, delta: Schema.Schema<D>) =>
  Schema.Struct({
    topic: Schema.String,
    subscriptionId: Schema.String,
    // Interval accounting (fromSeq, toSeq]; snapshot frames use fromSeq=0.
    fromSeq: Schema.Number,
    toSeq: Schema.Number,
    sentAt: Timestamp,
    payload: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot }),
      Schema.Struct({ kind: Schema.Literal("deltas"), deltas: Schema.Array(delta) }),
    ]),
  });

// ── conversation rows (rows.ts) ──

const rowBase = {
  rowId: Schema.Number,
  turnId: Schema.String,
  entityId: Schema.optionalKey(nonEmptyString),
  productTurnId: Schema.optionalKey(nonEmptyString),
  visibility: Schema.optionalKey(Schema.Literal("visible")),
  createdAt: Timestamp,
  createdAtSeq: Schema.Number,
  actions: Schema.optionalKey(
    Schema.Struct({
      canFork: Schema.optionalKey(Schema.Literal(true)),
      canEdit: Schema.optionalKey(Schema.Literal(true)),
      canRetry: Schema.optionalKey(Schema.Literal(true)),
      canRewindFiles: Schema.optionalKey(Schema.Literal(true)),
      editDisposition: Schema.optionalKey(Schema.Literals(["rewind", "fork"])),
    }),
  ),
} as const;

export const TurnWorkSegment = Schema.Struct({
  segmentId: nonEmptyString,
  triggerEntityId: Schema.optionalKey(nonEmptyString),
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  activeMs: Schema.optionalKey(Schema.Number),
});

// Workflow turn metadata is deferred (plan §9.7) — kept opaque so rows decode.
const deferredWorkflowMeta = Schema.optionalKey(Schema.Unknown);

export const TurnHeaderRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("turnHeader"),
  origin: Schema.Literals([
    "userInput",
    "backgroundResult",
    "goalContinuation",
    "editRerun",
    "workflowLaunch",
  ]),
  executionKind: Schema.optionalKey(Schema.Literals(["agent", "controlOnly"])),
  sourceCommandId: Schema.optionalKey(Schema.String),
  historyRoundCount: Schema.optionalKey(Schema.Int),
  state: Schema.Literals(["running", "completedSuccess", "completedInterrupted", "failed"]),
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  activeMs: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Int),
  modelDurationMs: Schema.optionalKey(Schema.Number),
  toolDurationMs: Schema.optionalKey(Schema.Number),
  otherDurationMs: Schema.optionalKey(Schema.Number),
  workSegments: Schema.optionalKey(Schema.Array(TurnWorkSegment)),
  originMeta: deferredWorkflowMeta,
  workflowLaunch: deferredWorkflowMeta,
  fileChanges: Schema.optionalKey(
    Schema.Struct({
      additions: Schema.Number,
      deletions: Schema.Number,
      files: Schema.Number,
      state: Schema.optionalKey(Schema.Literals(["active", "reverted"])),
    }),
  ),
});
export type TurnHeaderRow = typeof TurnHeaderRow.Type;

export const UserInputRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("userInput"),
  inputOrigin: Schema.optionalKey(Schema.Literals(["desktop", "mobile"])),
  botGroupSource: deferredWorkflowMeta,
  conversationQuotes: deferredWorkflowMeta,
  text: Schema.String,
  epilogueStart: Schema.optionalKey(Schema.Int),
  origin: Schema.Literals([
    "realUser",
    "backgroundResult",
    "goalContinuation",
    "mailbox",
    "synthetic",
    "workflowLaunch",
  ]),
  originMeta: Schema.optionalKey(
    Schema.Struct({
      backgroundSource: Schema.optionalKey(Schema.Literals(["bash", "subagent", "workflow"])),
      workId: Schema.optionalKey(Schema.String),
      senderSessionId: Schema.optionalKey(Schema.String),
      senderLabel: Schema.optionalKey(Schema.String),
    }),
  ),
  workflowLaunch: deferredWorkflowMeta,
  guided: Schema.optionalKey(Schema.Literal(true)),
  sourceCommandId: Schema.optionalKey(Schema.String),
  rootSourceCommandId: Schema.optionalKey(Schema.String),
  clientId: Schema.optionalKey(Schema.String),
  highspeed: deferredWorkflowMeta,
  attachments: Schema.optionalKey(Schema.Array(AttachmentRef)),
  source: deferredWorkflowMeta,
});
export type UserInputRow = typeof UserInputRow.Type;

export const AssistantTextRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("assistantText"),
  assistantResponseId: Schema.optionalKey(nonEmptyString),
  text: Schema.String,
  state: Schema.Literals(["streaming", "complete", "interrupted", "failed"]),
  model: Schema.optionalKey(Schema.String),
  feedback: Schema.optionalKey(Schema.Literals(["like", "dislike"])),
});
export type AssistantTextRow = typeof AssistantTextRow.Type;

export const ReasoningRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("reasoning"),
  assistantResponseId: Schema.optionalKey(nonEmptyString),
  text: Schema.String,
  state: Schema.Literals(["streaming", "complete", "interrupted"]),
  durationMs: Schema.optionalKey(Schema.Number),
});
export type ReasoningRow = typeof ReasoningRow.Type;

export const ToolOutput = Schema.Struct({
  text: Schema.String,
  // Display unions are decorative for the adapter mapping; decode stays open.
  display: Schema.optionalKey(Schema.Unknown),
  truncated: Schema.optionalKey(Schema.Struct({ totalBytes: Schema.Number, ref: Schema.String })),
});
export type ToolOutput = typeof ToolOutput.Type;

export const ToolProgress = Schema.Struct({
  bytes: Schema.optionalKey(Schema.Number),
  previewLine: Schema.optionalKey(Schema.String),
  fraction: Schema.optionalKey(Schema.Number),
  total: Schema.optionalKey(Schema.Number),
  message: Schema.optionalKey(Schema.String),
  updatedAt: Timestamp,
});
export type ToolProgress = typeof ToolProgress.Type;

export const ExecutionOutputPreview = Schema.Struct({
  text: Schema.String,
  fullText: Schema.String,
  totalLines: Schema.Int,
  totalBytes: Schema.Int,
  linesEstimated: Schema.Boolean,
});

export const ToolCallRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("toolCall"),
  assistantResponseId: Schema.optionalKey(nonEmptyString),
  toolCallId: Schema.String,
  toolName: Schema.String,
  status: Schema.Literals([
    "inputStreaming",
    "pendingApproval",
    "running",
    "success",
    "error",
    "cancelled",
  ]),
  inputText: Schema.String,
  input: Schema.optionalKey(Schema.Unknown),
  cuaApp: deferredWorkflowMeta,
  output: Schema.optionalKey(ToolOutput),
  display: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
  progress: Schema.optionalKey(ToolProgress),
  outputPreview: Schema.optionalKey(ExecutionOutputPreview),
  approvalInteractionId: Schema.optionalKey(Schema.String),
  backgrounded: Schema.optionalKey(Schema.Literal(true)),
  workId: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Timestamp),
  endedAt: Schema.optionalKey(Timestamp),
});
export type ToolCallRow = typeof ToolCallRow.Type;

export const ArtifactRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("artifact"),
  artifactVersionId: nonEmptyString,
  logicalArtifactKey: nonEmptyString,
  displayName: nonEmptyString,
  artifactType: Schema.Literals(["pdf", "pptx", "docx", "xlsx", "image", "html", "md", "text"]),
  mimeType: nonEmptyString,
  sizeBytes: Schema.Int,
  sha256: Schema.String,
  ref: nonEmptyString,
  state: Schema.Literal("current"),
});
export type ArtifactRow = typeof ArtifactRow.Type;

export const SubagentRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("subagent"),
  parentToolCallId: Schema.optionalKey(Schema.String),
  subagentType: Schema.String,
  status: Schema.Literals(["running", "success", "failed", "cancelled"]),
  summaryText: Schema.String,
  childSessionId: Schema.optionalKey(Schema.String),
  backgrounded: Schema.optionalKey(Schema.Literal(true)),
  workId: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Timestamp),
  endedAt: Schema.optionalKey(Timestamp),
});
export type SubagentRow = typeof SubagentRow.Type;

export const HookExecutionProjection = Schema.Struct({
  hookRunId: nonEmptyString,
  hookIndex: Schema.Int,
  didExecute: Schema.Boolean,
  state: Schema.Literals(["running", "completed", "failed"]),
  outcome: Schema.optionalKey(
    Schema.Literals(["success", "blocked", "failed", "cancelled", "timed_out"]),
  ),
  blockReason: Schema.optionalKey(nonEmptyString),
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  durationMs: Schema.optionalKey(Schema.Number),
  displayName: nonEmptyString,
  sourceKind: Schema.Literals(["user", "plugin", "project"]),
  pluginName: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
});

export const HookInvocationRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("hookInvocation"),
  hookInvocationId: nonEmptyString,
  hookEventName: Schema.Literals([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ]),
  hookCount: Schema.Int,
  state: Schema.Literals(["running", "completed", "failed"]),
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  durationMs: Schema.optionalKey(Schema.Number),
  lane: Schema.Literals(["assistantWork", "toolBefore", "toolAfter"]),
  anchorToolCallId: Schema.optionalKey(Schema.String),
  executions: Schema.Array(HookExecutionProjection),
});
export type HookInvocationRow = typeof HookInvocationRow.Type;

// modelChange has two upstream variants (with/without from*); permissive merge.
export const TimelineMarkerPayload = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("compact"),
    origin: Schema.Literals(["manual", "auto"]),
    status: Schema.Literals(["running", "success", "failed", "noop", "cancelled"]),
    tokensBefore: Schema.optionalKey(Schema.Number),
    tokensAfter: Schema.optionalKey(Schema.Number),
    summaryRef: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("forkNotice"),
    parentSessionId: Schema.String,
    parentRowId: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("forkCreated"),
    childSessionId: Schema.String,
    atRowId: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("modelChange"),
    fromProvider: Schema.optionalKey(Schema.String),
    fromModel: Schema.optionalKey(Schema.String),
    toProvider: Schema.String,
    toModel: Schema.String,
    toThought: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("goalSet"),
    objective: Schema.String,
    previousObjective: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("goalVerify"),
    iteration: Schema.Number,
    outcome: Schema.Literals(["running", "pass", "notSatisfied", "failed"]),
    detail: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("retryNotice"),
    attempt: Schema.Number,
    reasonCode: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("checkpointRestored"),
    checkpointId: Schema.String,
  }),
]);
export type TimelineMarkerPayload = typeof TimelineMarkerPayload.Type;

export const TimelineMarkerRow = Schema.Struct({
  ...rowBase,
  kind: Schema.Literal("timelineMarker"),
  sourceCommandId: Schema.optionalKey(Schema.String),
  lane: Schema.optionalKey(Schema.Literals(["assistantWork", "turnTailBoundary", "lightBoundary"])),
  marker: TimelineMarkerPayload,
});
export type TimelineMarkerRow = typeof TimelineMarkerRow.Type;

export const ConversationRow = Schema.Union([
  TurnHeaderRow,
  UserInputRow,
  AssistantTextRow,
  ReasoningRow,
  ToolCallRow,
  ArtifactRow,
  SubagentRow,
  HookInvocationRow,
  TimelineMarkerRow,
]);
export type ConversationRow = typeof ConversationRow.Type;

// ── snapshot state keys (snapshot.ts) ──

export const SessionPhase = Schema.Literals([
  "draft",
  "prewarming",
  "running",
  "completedSuccess",
  "completedInterrupted",
  "error",
]);
export type SessionPhase = typeof SessionPhase.Type;

export const ActiveWorkSummary = Schema.Struct({
  kind: Schema.Literals([
    "primaryTurn",
    "foregroundSubagent",
    "compact",
    "goalVerifier",
    "goalContinuation",
    "turnSteer",
  ]),
  foregroundExecutionId: Schema.optionalKey(nonEmptyString),
  sourceCommandId: Schema.optionalKey(nonEmptyString),
  startedAt: Timestamp,
});

export const SessionErrorInfo = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  recoverable: Schema.Boolean,
  at: Timestamp,
  source: Schema.Literals(["provider", "runtime", "tool", "network"]),
  traceId: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  underlyingErrorMessage: Schema.optionalKey(Schema.String),
  underlyingErrorDetail: Schema.optionalKey(Schema.String),
  attribution: Schema.optionalKey(Schema.Unknown),
});

export const ApiRetryState = Schema.Struct({
  attempt: Schema.Number,
  maxAttempts: Schema.Number,
  nextRetryAt: Timestamp,
  reasonCode: Schema.String,
});

export const SessionControl = Schema.Struct({
  phase: SessionPhase,
  sessionEnded: Schema.Boolean,
  canStop: Schema.Boolean,
  stopState: Schema.Literals(["idle", "stoppable", "stopping"]),
  stopTargetKind: Schema.Literals([
    "assistant",
    "tool",
    "subagent",
    "compact",
    "goalVerifier",
    "goalContinuation",
    "turnSteer",
    "mixed",
    "unknown",
  ]),
  activeWorks: Schema.Array(ActiveWorkSummary),
  lastError: Schema.Union([SessionErrorInfo, Schema.Null]),
  apiRetry: Schema.Union([ApiRetryState, Schema.Null]),
});
export type SessionControl = typeof SessionControl.Type;

export const ActionAvailability = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true) }),
  Schema.Struct({ allowed: Schema.Literal(false), reasonCode: Schema.String }),
]);

export const SessionActionAvailability = Schema.Struct({
  fork: ActionAvailability,
  compact: ActionAvailability,
  switchModelConfig: ActionAvailability,
  setFollowupMode: ActionAvailability,
  queueEdit: ActionAvailability,
  sendQueuedNow: ActionAvailability,
  pauseGoal: ActionAvailability,
  resumeGoal: ActionAvailability,
});

export const InputRouting = Schema.Struct({
  mode: Schema.Literals(["startNow", "enqueue", "guide", "reject", "choice"]),
  reasonCode: Schema.optionalKey(Schema.String),
});
export type InputRouting = typeof InputRouting.Type;

export const SessionMetaState = Schema.Struct({
  title: Schema.String,
  titleSource: Schema.Literals(["default", "generated", "custom"]),
});
export type SessionMetaState = typeof SessionMetaState.Type;

export const SharedContextImportState = Schema.Union([
  Schema.Struct({
    contextId: nonEmptyString,
    title: nonEmptyString,
    shareUrl: Schema.String,
    status: Schema.Literals(["pending", "reserved", "attached", "discarded"]),
  }),
  Schema.Struct({ title: nonEmptyString }),
]);

export const SessionUsageState = Schema.Struct({
  contextWindow: Schema.Union([
    Schema.Struct({
      usedTokens: Schema.Number,
      maxTokens: Schema.Number,
      autoCompactThresholdTokens: Schema.Union([Schema.Number, Schema.Null]),
      cache: Schema.optionalKey(JsonObject),
      breakdown: Schema.optionalKey(Schema.Array(JsonObject)),
    }),
    Schema.Null,
  ]),
  cumulative: Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    cacheReadTokens: Schema.Number,
    cacheWriteTokens: Schema.Number,
  }),
});
export type SessionUsageState = typeof SessionUsageState.Type;

export const QueueItem = Schema.Struct({
  sourceCommandId: nonEmptyString,
  queueItemId: nonEmptyString,
  clientId: nonEmptyString,
  kind: Schema.Literals(["sendText", "sendGoalCommand", "compact"]),
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(AttachmentRef)),
  modelSelection: Schema.optionalKey(ModelSelection),
  mode: Schema.optionalKey(SubmissionMode),
  planEnabled: Schema.optionalKey(Schema.Boolean),
  inputOrigin: Schema.optionalKey(Schema.Literals(["desktop", "mobile"])),
  sharedContextRefs: Schema.optionalKey(Schema.Array(JsonObject)),
  delivery: Schema.Struct({
    requested: Schema.Literals(["auto", "startNow", "queue", "guide"]),
    admitted: Schema.Literals(["startNow", "queue", "guide"]),
    fallbackReasonCode: Schema.optionalKey(Schema.String),
  }),
  order: Schema.Struct({
    admissionSeq: Schema.Int,
    queuePosition: Schema.optionalKey(Schema.Int),
  }),
  steer: Schema.Struct({
    state: Schema.Literals(["notRequested", "submitting", "steering", "guided", "fellBack"]),
    reasonCode: Schema.optionalKey(Schema.String),
  }),
  dispatch: Schema.Struct({
    state: Schema.Literals(["queued", "reserved", "promoting", "drained", "admitted"]),
    reservationId: Schema.optionalKey(Schema.String),
  }),
  toolDisallowlist: Schema.optionalKey(Schema.Array(nonEmptyString)),
  admittedAt: Schema.optionalKey(Timestamp),
  highspeed: deferredWorkflowMeta,
  provenance: Schema.optionalKey(JsonObject),
  source: deferredWorkflowMeta,
  conversationQuotes: deferredWorkflowMeta,
  botGroupSource: deferredWorkflowMeta,
});
export type QueueItem = typeof QueueItem.Type;

export const QueueState = Schema.Struct({
  items: Schema.Array(QueueItem),
  autoDrain: Schema.Boolean,
  pauseReason: Schema.optionalKey(Schema.Literals(["stopped", "manual", "error"])),
});
export type QueueState = typeof QueueState.Type;

export const InteractionAutoResolution = Schema.Union([
  Schema.Struct({
    state: Schema.Literals(["hiddenGrace", "visibleCountdown"]),
    startedAt: Timestamp,
    visibleAt: Timestamp,
    deadlineAt: Timestamp,
  }),
  Schema.Struct({
    state: Schema.Literal("snoozed"),
    startedAt: Timestamp,
    snoozedAt: Timestamp,
  }),
]);
export type InteractionAutoResolution = typeof InteractionAutoResolution.Type;

export const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["allowOnce", "allowAlways", "deny", "custom"]),
  response: Schema.optionalKey(JsonObject),
});

export const PERMISSION_FULL_ACCESS_OPTION_ID = "fullAccess";

export const PermissionRequestPayload = Schema.Struct({
  kind: Schema.Literal("permission"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  summary: Schema.String,
  detail: Schema.Unknown,
  freeText: Schema.optionalKey(Schema.Boolean),
  origin: Schema.optionalKey(JsonObject),
  display: Schema.optionalKey(Schema.Unknown),
  fullAccessOption: Schema.optionalKey(
    Schema.Struct({
      optionId: Schema.Literal(PERMISSION_FULL_ACCESS_OPTION_ID),
      label: Schema.String,
      kind: Schema.Literal("custom"),
      response: Schema.optionalKey(JsonObject),
    }),
  ),
  options: Schema.Array(PermissionOption),
});
export type PermissionRequestPayload = typeof PermissionRequestPayload.Type;

export const UserInputOptionPayload = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  preview: Schema.optionalKey(Schema.String),
});

export const UserInputQuestionPayload = Schema.Struct({
  question: Schema.String,
  header: Schema.String,
  options: Schema.Array(UserInputOptionPayload),
  multiSelect: Schema.optionalKey(Schema.Boolean),
});

export const UserInputRequestPayload = Schema.Struct({
  kind: Schema.Literal("userInput"),
  prompt: Schema.String,
  freeText: Schema.Boolean,
  options: Schema.optionalKey(
    Schema.Array(Schema.Struct({ optionId: Schema.String, label: Schema.String })),
  ),
  sensitive: Schema.optionalKey(Schema.Boolean),
  toolName: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  traceId: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  schema: Schema.optionalKey(Schema.Unknown),
  questions: Schema.optionalKey(Schema.Array(UserInputQuestionPayload)),
  currentQuestionIndex: Schema.optionalKey(Schema.Number),
  answerDrafts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  origin: Schema.optionalKey(JsonObject),
});
export type UserInputRequestPayload = typeof UserInputRequestPayload.Type;

export const WorkspaceHookReviewRequestPayload = Schema.Struct({
  kind: Schema.Literal("workspaceHookReview"),
  reviewFlowId: nonEmptyString,
  generation: Schema.Int,
  interactionId: nonEmptyString,
  sessionId: nonEmptyString,
  taskId: nonEmptyString,
  runId: nonEmptyString,
  workspaceIdentity: nonEmptyString,
  workspaceLabel: nonEmptyString,
  remoteSessionId: Schema.optionalKey(nonEmptyString),
  bundleDigest: Schema.String,
  createdAt: Timestamp,
  deadlineAt: Timestamp,
  sourceFiles: Schema.Array(
    Schema.Struct({
      path: nonEmptyString,
      displayPath: nonEmptyString,
      editable: Schema.Boolean,
    }),
  ),
  summary: Schema.Struct({
    eventCount: Schema.Int,
    hookCount: Schema.Int,
    pendingCount: Schema.Int,
  }),
  items: Schema.Array(
    Schema.Struct({
      reviewItemId: nonEmptyString,
      event: Schema.Literals([
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PostToolUseFailure",
        "Stop",
      ]),
      matcher: Schema.optionalKey(Schema.String),
      type: Schema.Literals(["command", "process"]),
      displayName: nonEmptyString,
      displayCommand: nonEmptyString,
      sourcePath: nonEmptyString,
      resolvedTimeoutMs: Schema.Int,
      resolvedMaxOutputBytes: Schema.Int,
      executionMode: Schema.Literals(["foreground", "background"]),
      configuredEnabled: Schema.Boolean,
      editable: Schema.Boolean,
      trustState: Schema.Literals([
        "not_applicable",
        "pending_trust",
        "trusted_persistent",
        "blocked_untrusted",
        "blocked_policy",
        "revoked",
        "stale_digest",
      ]),
    }),
  ),
  warningCode: Schema.Literal("workspace_hooks_execute_code"),
});
export type WorkspaceHookReviewRequestPayload = typeof WorkspaceHookReviewRequestPayload.Type;

export const PendingInteraction = Schema.Struct({
  interactionId: Schema.String,
  kind: Schema.Literals(["permission", "userInput", "workspaceHookReview"]),
  anchorRowId: Schema.Union([Schema.Number, Schema.Null]),
  createdAt: Timestamp,
  autoResolution: Schema.optionalKey(InteractionAutoResolution),
  payload: Schema.Union([
    PermissionRequestPayload,
    UserInputRequestPayload,
    WorkspaceHookReviewRequestPayload,
  ]),
});
export type PendingInteraction = typeof PendingInteraction.Type;

export const CommandStateSummary = Schema.Struct({
  commandId: Schema.String,
  clientId: Schema.String,
  type: Schema.String,
  state: Schema.Literals(["accepted", "executing"]),
  at: Timestamp,
});

export const BackgroundWorkSummary = Schema.Struct({
  workId: Schema.String,
  kind: Schema.Literals(["bash", "subagent", "workflow"]),
  title: Schema.String,
  status: Schema.Literals(["running", "resultPending", "failed", "cancelled"]),
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  cancellable: Schema.optionalKey(Schema.Boolean),
  blocked: Schema.optionalKey(Schema.Boolean),
  anchorRowId: Schema.Union([Schema.Number, Schema.Null]),
  childSessionId: Schema.optionalKey(Schema.String),
});
export type BackgroundWorkSummary = typeof BackgroundWorkSummary.Type;

export const RunningSubagentSummary = Schema.Struct({
  childSessionId: Schema.String,
  agentId: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  subagentType: Schema.String,
  title: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["running", "waiting", "blocked"]),
  startedAt: Schema.optionalKey(Timestamp),
});

export const SubagentProjectionState = Schema.Struct({
  revision: Schema.Int,
  childSessionIds: Schema.Array(Schema.String),
  running: Schema.Array(RunningSubagentSummary),
  endedTotal: Schema.Int,
});
export type SubagentProjectionState = typeof SubagentProjectionState.Type;

export const PlanItem = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  status: Schema.Literals(["pending", "inProgress", "completed"]),
});

export const SessionGoalStatus = Schema.Literals([
  "active",
  "paused",
  "verifying",
  "verified",
  "notSatisfied",
  "failed",
]);
export type SessionGoalStatus = typeof SessionGoalStatus.Type;

export const GoalState = Schema.Struct({
  targetId: Schema.optionalKey(Schema.String),
  objective: Schema.String,
  summaryTitle: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  timeUsedSeconds: Schema.optionalKey(Schema.Int),
  activeRunStartedAtMs: Schema.optionalKey(Schema.Union([Schema.Int, Schema.Null])),
  status: SessionGoalStatus,
  iteration: Schema.Number,
  verifications: Schema.Array(
    Schema.Struct({
      iteration: Schema.Number,
      outcome: Schema.Literals(["pass", "notSatisfied", "failed"]),
      at: Timestamp,
      anchorRowId: Schema.Union([Schema.Number, Schema.Null]),
      reason: Schema.optionalKey(Schema.String),
      nextAction: Schema.optionalKey(Schema.String),
    }),
  ),
  iterations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        iteration: Schema.Int,
        items: Schema.Array(PlanItem),
        updatedAt: Timestamp,
      }),
    ),
  ),
});
export type GoalState = typeof GoalState.Type;

export const PlanState = Schema.Struct({
  items: Schema.Array(PlanItem),
  updatedAt: Timestamp,
});

export const SessionConfigState = Schema.Struct({
  modelSelection: Schema.optionalKey(ModelSelection),
  provider: Schema.String,
  model: Schema.String,
  thought: Schema.String,
  thoughtLevels: Schema.optionalKey(Schema.Array(Schema.String)),
  followupMode: Schema.Literals(["queue", "guide"]),
  mode: Schema.optionalKey(Schema.String),
  planEnabled: Schema.optionalKey(Schema.Boolean),
  permissionGrant: Schema.optionalKey(Schema.Struct({ interactionId: nonEmptyString })),
  planTransition: Schema.optionalKey(
    Schema.Struct({ toolCallId: Schema.String, planEnabled: Schema.Boolean }),
  ),
});
export type SessionConfigState = typeof SessionConfigState.Type;

export const SessionModelTransition = Schema.Struct({
  eventId: nonEmptyString,
  origin: Schema.Literal("registryFallback"),
  from: Schema.Struct({ provider: Schema.String, model: Schema.String }),
  to: Schema.Struct({ provider: Schema.String, model: Schema.String }),
});

export const WorkspaceHookAdmissionState = Schema.Struct({
  pendingCount: Schema.Int,
  bundleDigest: Schema.String,
  workspaceIdentity: Schema.optionalKey(Schema.String),
});

export const RuntimeInitialization = Schema.Union([
  Schema.Struct({ status: Schema.Literal("initializing"), attemptId: nonEmptyString }),
  Schema.Struct({ status: Schema.Literal("ready"), attemptId: nonEmptyString }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    attemptId: nonEmptyString,
    reasonCode: Schema.String,
    message: Schema.String,
  }),
]);
export type RuntimeInitialization = typeof RuntimeInitialization.Type;

export const RowsWindow = Schema.Struct({
  window: Schema.Array(ConversationRow),
  totalCount: Schema.Number,
  firstRowId: Schema.Union([Schema.Number, Schema.Null]),
});

export const ConversationSnapshot = Schema.Struct({
  runtimeInitialization: Schema.optionalKey(RuntimeInitialization),
  protocolVersion: Schema.Literal(1),
  sessionId: Schema.String,
  logEpoch: Schema.String,
  seq: Schema.Number,
  revision: Schema.Number,
  control: SessionControl,
  availability: SessionActionAvailability,
  inputRouting: InputRouting,
  meta: Schema.optionalKey(SessionMetaState),
  sharedContextImport: Schema.optionalKey(SharedContextImportState),
  config: SessionConfigState,
  modelTransition: Schema.optionalKey(Schema.Union([SessionModelTransition, Schema.Null])),
  usage: SessionUsageState,
  queue: QueueState,
  pendingInteractions: Schema.Array(PendingInteraction),
  pendingCommands: Schema.Array(CommandStateSummary),
  backgroundWorks: Schema.Array(BackgroundWorkSummary),
  subagents: Schema.optionalKey(SubagentProjectionState),
  // Deferred: dynamic workflow runs (plan §9.7).
  workflowRuns: Schema.optionalKey(Schema.Unknown),
  goal: Schema.Union([GoalState, Schema.Null]),
  plan: Schema.Union([PlanState, Schema.Null]),
  workspaceHookAdmission: Schema.optionalKey(
    Schema.Union([WorkspaceHookAdmissionState, Schema.Null]),
  ),
  rows: RowsWindow,
});
export type ConversationSnapshot = typeof ConversationSnapshot.Type;

// ── deltas (delta.ts) ──

export const StatePatch = Schema.Struct({
  runtimeInitialization: Schema.optionalKey(RuntimeInitialization),
  revision: Schema.optionalKey(Schema.Number),
  control: Schema.optionalKey(SessionControl),
  sharedContextImport: Schema.optionalKey(SharedContextImportState),
  availability: Schema.optionalKey(SessionActionAvailability),
  inputRouting: Schema.optionalKey(InputRouting),
  meta: Schema.optionalKey(SessionMetaState),
  config: Schema.optionalKey(SessionConfigState),
  modelTransition: Schema.optionalKey(Schema.Union([SessionModelTransition, Schema.Null])),
  usage: Schema.optionalKey(SessionUsageState),
  queue: Schema.optionalKey(QueueState),
  pendingInteractions: Schema.optionalKey(Schema.Array(PendingInteraction)),
  pendingCommands: Schema.optionalKey(Schema.Array(CommandStateSummary)),
  backgroundWorks: Schema.optionalKey(Schema.Array(BackgroundWorkSummary)),
  subagents: Schema.optionalKey(SubagentProjectionState),
  workflowRuns: Schema.optionalKey(Schema.Unknown),
  goal: Schema.optionalKey(Schema.Union([GoalState, Schema.Null])),
  plan: Schema.optionalKey(Schema.Union([PlanState, Schema.Null])),
  workspaceHookAdmission: Schema.optionalKey(
    Schema.Union([WorkspaceHookAdmissionState, Schema.Null]),
  ),
});
export type StatePatch = typeof StatePatch.Type;

export const StreamablePath = Schema.Literals(["text", "inputText", "output.text", "summaryText"]);

const pluginUiDeltaFields = {
  pluginId: Schema.String,
  serverName: Schema.String,
  subscribers: Schema.Array(JsonObject),
} as const;

// Identity of an evicted actor/node entry upstream (siteId × ordinal journal key).
const WorkflowRunEntryRef = Schema.Struct({
  siteId: nonEmptyString,
  ordinal: nonNegativeInt,
});

export const ConversationDelta = Schema.Union([
  Schema.Struct({ op: Schema.Literal("row.appended"), row: ConversationRow }),
  Schema.Struct({ op: Schema.Literal("row.upserted"), row: ConversationRow }),
  Schema.Struct({ op: Schema.Literal("row.removed"), fromRowId: Schema.Number }),
  Schema.Struct({
    op: Schema.Literal("row.delta"),
    rowId: Schema.Number,
    path: StreamablePath,
    append: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("state.updated"), patch: StatePatch }),
  Schema.Struct({
    op: Schema.Literal("pluginUi.resourceUpdated"),
    ...pluginUiDeltaFields,
    uri: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("pluginUi.resourceListChanged"), ...pluginUiDeltaFields }),
  Schema.Struct({ op: Schema.Literal("pluginUi.instanceClosed"), ...pluginUiDeltaFields }),
  Schema.Struct({
    op: Schema.Literal("pluginUi.appToolCall"),
    activity: Schema.optionalKey(Schema.Boolean),
    cancelled: Schema.optionalKey(Schema.Boolean),
    ...pluginUiDeltaFields,
    callId: Schema.String,
    toolName: Schema.String,
    arguments: JsonObject,
  }),
  // Workflow-run keyed deltas: entry payloads stay opaque until the workflow
  // phase lands, but every field must survive decode — workflowRunDeltas
  // subscribers receive them verbatim. Header keys/cleared stay strings.
  Schema.Struct({
    op: Schema.Literal("workflowRun.updated"),
    runId: Schema.String,
    revision: Schema.Number,
    run: Schema.optionalKey(JsonObject),
    cleared: Schema.optionalKey(Schema.Array(Schema.String)),
    removedActors: Schema.optionalKey(Schema.Array(WorkflowRunEntryRef)),
    removedNodes: Schema.optionalKey(Schema.Array(WorkflowRunEntryRef)),
    actors: Schema.optionalKey(Schema.Array(JsonObject)),
    nodes: Schema.optionalKey(Schema.Array(JsonObject)),
  }),
  Schema.Struct({
    op: Schema.Literal("workflowRun.removed"),
    runId: Schema.String,
    revision: Schema.Number,
  }),
]);
export type ConversationDelta = typeof ConversationDelta.Type;

export const ConversationTopicFrame = topicFrame(ConversationSnapshot, ConversationDelta);
export type ConversationTopicFrame = typeof ConversationTopicFrame.Type;

// ── sessions-index topic ──

export const SessionSummary = Schema.Struct({
  sessionId: Schema.String,
  workspaceId: Schema.String,
  parentSessionId: Schema.optionalKey(Schema.String),
  title: Schema.String,
  titleSource: Schema.optionalKey(Schema.Literals(["default", "generated", "custom"])),
  lastOutcome: Schema.optionalKey(Schema.Literals(["completed", "error", "interrupted"])),
  phase: SessionPhase,
  sessionEnded: Schema.Boolean,
  hasBackgroundWork: Schema.Boolean,
  workflowActivity: deferredWorkflowMeta,
  pendingInteraction: Schema.optionalKey(
    Schema.Struct({
      interactionId: Schema.String,
      kind: Schema.Literals(["permission", "userInput"]),
      toolName: Schema.optionalKey(Schema.String),
      autoResolution: Schema.optionalKey(InteractionAutoResolution),
    }),
  ),
  pendingInteractionSummary: Schema.optionalKey(
    Schema.Struct({
      permissionCount: Schema.Int,
      userInputCount: Schema.Int,
    }),
  ),
  goalStatus: Schema.optionalKey(SessionGoalStatus),
  lastActivityAt: Timestamp,
  lastAssistantPreview: Schema.optionalKey(Schema.String),
  createdAt: Timestamp,
});
export type SessionSummary = typeof SessionSummary.Type;

export const SessionsIndexSnapshot = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  workspaceId: Schema.String,
  logEpoch: Schema.String,
  sessions: Schema.Array(SessionSummary),
});
export type SessionsIndexSnapshot = typeof SessionsIndexSnapshot.Type;

export const SessionsIndexDelta = Schema.Union([
  Schema.Struct({ op: Schema.Literal("session.upserted"), session: SessionSummary }),
  Schema.Struct({ op: Schema.Literal("session.removed"), sessionId: Schema.String }),
]);
export type SessionsIndexDelta = typeof SessionsIndexDelta.Type;

export const SessionsIndexTopicFrame = topicFrame(SessionsIndexSnapshot, SessionsIndexDelta);
export type SessionsIndexTopicFrame = typeof SessionsIndexTopicFrame.Type;

export const SessionsIndexReconcileParams = Schema.Struct({
  workspaceId: nonEmptyString,
  sessionIds: Schema.Array(nonEmptyString),
});
export type SessionsIndexReconcileParams = typeof SessionsIndexReconcileParams.Type;

export const SessionsIndexReconcileResult = Schema.Struct({
  sessions: Schema.Array(
    Schema.Union([
      Schema.Struct({
        sessionId: Schema.String,
        exists: Schema.Literal(false),
        deleted: Schema.Literal(false),
      }),
      Schema.Struct({
        sessionId: Schema.String,
        exists: Schema.Literal(true),
        deleted: Schema.Boolean,
        title: Schema.String,
        titleSource: Schema.Literals(["default", "generated", "custom"]),
        createdAt: Timestamp,
        updatedAt: Timestamp,
        lastOutcome: Schema.optionalKey(Schema.Literals(["completed", "error", "interrupted"])),
      }),
    ]),
  ),
});
export type SessionsIndexReconcileResult = typeof SessionsIndexReconcileResult.Type;

export const sessionsIndexTopic = (workspaceId: string): string => `sessions-index/${workspaceId}`;

// ── workspace-config topic ──

export const WorkspaceConfigSelectValue = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(Schema.Literals(["native", "injected"])),
  modelProviderId: Schema.optionalKey(Schema.String),
  modelProviderName: Schema.optionalKey(Schema.String),
  modelThoughtLevels: Schema.optionalKey(Schema.Array(Schema.String)),
  modelDefaultThoughtLevel: Schema.optionalKey(Schema.String),
});

export const WorkspaceConfigOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  type: Schema.Literals(["select", "boolean"]),
  currentValue: Schema.Union([Schema.String, Schema.Boolean]),
  options: Schema.optionalKey(Schema.Array(WorkspaceConfigSelectValue)),
});
export type WorkspaceConfigOption = typeof WorkspaceConfigOption.Type;

export const WorkspaceSlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputHint: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literals(["builtin", "custom"])),
});
export type WorkspaceSlashCommand = typeof WorkspaceSlashCommand.Type;

export const WorkspaceConfigState = Schema.Struct({
  configOptions: Schema.Array(WorkspaceConfigOption),
  slashCommands: Schema.Array(WorkspaceSlashCommand),
});
export type WorkspaceConfigState = typeof WorkspaceConfigState.Type;

export const WorkspaceConfigSnapshot = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  workspaceId: Schema.String,
  logEpoch: Schema.String,
  config: WorkspaceConfigState,
});
export type WorkspaceConfigSnapshot = typeof WorkspaceConfigSnapshot.Type;

export const WorkspaceConfigDelta = Schema.Union([
  Schema.Struct({ op: Schema.Literal("config.updated"), config: WorkspaceConfigState }),
]);
export type WorkspaceConfigDelta = typeof WorkspaceConfigDelta.Type;

export const WorkspaceConfigTopicFrame = topicFrame(WorkspaceConfigSnapshot, WorkspaceConfigDelta);
export type WorkspaceConfigTopicFrame = typeof WorkspaceConfigTopicFrame.Type;

export const RoutedTopicFrame = Schema.Union([
  ConversationTopicFrame,
  SessionsIndexTopicFrame,
  WorkspaceConfigTopicFrame,
]);
export type RoutedTopicFrame = typeof RoutedTopicFrame.Type;

export const workspaceConfigTopic = (workspaceId: string): string =>
  `workspace-config/${workspaceId}`;
export const conversationTopic = (sessionId: string): string => `conversation/${sessionId}`;

// ── subscribe / resync / unsubscribe ──

export const V4ConversationSubscribeParams = Schema.Struct({
  topic: Schema.String,
  connectionId: Schema.String,
  clientMode: Schema.Literals(["desktop-continuous", "web-remote-replayable"]),
  base: Schema.optionalKey(Schema.Struct({ logEpoch: Schema.String, seq: Schema.Number })),
  retryInitialization: Schema.optionalKey(nonEmptyString),
  visibility: Schema.optionalKey(Schema.Literals(["foreground", "background"])),
  additionalDirectories: Schema.optionalKey(Schema.Array(nonEmptyString)),
  workspace: Schema.optionalKey(ZCodeWorkspaceRef),
  legacyTaskIds: Schema.optionalKey(Schema.Array(nonEmptyString)),
  resumeThoughtLevel: Schema.optionalKey(nonEmptyString),
  workflowRunDeltas: Schema.optionalKey(Schema.Boolean),
  historyFirst: Schema.optionalKey(Schema.Boolean),
});
export type V4ConversationSubscribeParams = typeof V4ConversationSubscribeParams.Type;

export const SubscribeAck = Schema.Struct({
  subscriptionId: Schema.String,
  mode: Schema.Literals(["snapshot", "resume"]),
  logEpoch: Schema.String,
  openTiming: Schema.optionalKey(JsonObject),
});

export const V4ConversationSubscribeResult = Schema.Struct({ ack: SubscribeAck });
export type V4ConversationSubscribeResult = typeof V4ConversationSubscribeResult.Type;

export const V4ConversationResyncParams = Schema.Struct({
  subscriptionId: nonEmptyString,
  base: Schema.Union([Schema.Struct({ logEpoch: nonEmptyString, seq: Schema.Int }), Schema.Null]),
  forceSnapshot: Schema.optionalKey(Schema.Boolean),
  topic: nonEmptyString,
  connectionId: nonEmptyString,
});
export type V4ConversationResyncParams = typeof V4ConversationResyncParams.Type;

export const V4ConversationResyncResult = Schema.Struct({ ack: SubscribeAck });

export const V4ConversationUnsubscribeParams = Schema.Struct({
  topic: nonEmptyString,
  subscriptionId: nonEmptyString,
  connectionId: nonEmptyString,
});
export type V4ConversationUnsubscribeParams = typeof V4ConversationUnsubscribeParams.Type;

// ── queries ──

export const V4ConversationRowsRangeParams = Schema.Struct({
  sessionId: Schema.String,
  clientMode: Schema.optionalKey(Schema.Literals(["desktop-continuous", "web-remote-replayable"])),
  beforeRowId: Schema.optionalKey(Schema.Number),
  limit: Schema.Number,
});
export type V4ConversationRowsRangeParams = typeof V4ConversationRowsRangeParams.Type;

export const V4ConversationRowsRangeResult = Schema.Struct({
  rows: Schema.Array(ConversationRow),
  atSeq: Schema.Number,
  atRevision: Schema.Int,
  atLogEpoch: Schema.String,
  hasMore: Schema.Boolean,
});
export type V4ConversationRowsRangeResult = typeof V4ConversationRowsRangeResult.Type;

export const V4ConversationFileRewindPreviewParams = Schema.Struct({
  sessionId: nonEmptyString,
  target: ConversationRowTarget,
  baseRevision: Schema.Int,
  baseLogEpoch: nonEmptyString,
});
export type V4ConversationFileRewindPreviewParams =
  typeof V4ConversationFileRewindPreviewParams.Type;

export const V4FileRewindPreviewResult = Schema.Struct({
  canApply: Schema.Boolean,
  ignoredFiles: Schema.Array(
    Schema.Struct({
      operationCount: Schema.Int,
      path: nonEmptyString,
      reason: Schema.Literal("bash_ignored"),
      toolNames: Schema.Array(Schema.String),
    }),
  ),
  safeFiles: Schema.Array(
    Schema.Struct({
      action: Schema.Literals(["restore", "delete"]),
      operationCount: Schema.Int,
      path: nonEmptyString,
      toolNames: Schema.Array(Schema.String),
    }),
  ),
  unsafeFiles: Schema.Array(
    Schema.Struct({
      currentHash: Schema.optionalKey(Schema.String),
      expectedHash: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      operationCount: Schema.Int,
      path: nonEmptyString,
      reason: Schema.Literals([
        "checkpoint_missing",
        "checkpoint_unreadable",
        "external_modified",
        "file_read_failed",
        "unsupported_checkpoint",
      ]),
      toolNames: Schema.Array(Schema.String),
    }),
  ),
});
export type V4FileRewindPreviewResult = typeof V4FileRewindPreviewResult.Type;

export const V4ConversationFileChangesParams = Schema.Struct({
  sessionId: nonEmptyString,
  target: ConversationRowTarget,
  baseRevision: Schema.Int,
  baseLogEpoch: nonEmptyString,
});

export const V4ConversationFileChangesResult = Schema.Struct({
  files: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  state: Schema.optionalKey(Schema.Literals(["active", "reverted"])),
  items: Schema.Array(
    Schema.Struct({
      path: nonEmptyString,
      additions: Schema.Int,
      deletions: Schema.Int,
      writeCount: Schema.Int,
      toolNames: Schema.Array(Schema.String),
      patches: Schema.Array(
        Schema.Struct({
          oldStart: Schema.Number,
          oldLines: Schema.Number,
          newStart: Schema.Number,
          newLines: Schema.Number,
          lines: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
});

export const V4ConversationPlansParams = Schema.Struct({ sessionId: nonEmptyString });
export const V4ConversationPlansResult = Schema.Struct({
  plans: Schema.Array(ToolCallRow),
  atSeq: Schema.Int,
  atLogEpoch: nonEmptyString,
});

export const V4BackgroundBashOutputParams = Schema.Struct({
  sessionId: nonEmptyString,
  workId: nonEmptyString,
});
export const V4BackgroundBashOutputResult = Schema.Struct({
  workId: Schema.String,
  output: Schema.String,
});

export const V4ConversationUsageParams = Schema.Struct({ sessionId: nonEmptyString });
export const V4ConversationUsageResult = Schema.Struct({
  sessionId: nonEmptyString,
  totalTokens: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  reasoningTokens: Schema.Int,
  cacheCreationTokens: Schema.Int,
  cacheReadTokens: Schema.Int,
  modelRequestCount: Schema.Int,
  modelErrorCount: Schema.Int,
  inputBaselineBySource: Schema.Record(Schema.String, Schema.Int),
});

export const APP_USAGE_RANGES = ["all", "7d", "30d"] as const;
export const V4UsageStatsParams = Schema.Struct({
  range: Schema.Literals(APP_USAGE_RANGES),
  timeZone: Schema.optionalKey(Schema.String),
});
export type V4UsageStatsParams = typeof V4UsageStatsParams.Type;

// AppUsageSnapshot (usage-stats.ts): app-level usage aggregate.
export const V4UsageStatsResult = Schema.Struct({
  range: Schema.Literals(APP_USAGE_RANGES),
  generatedAt: Schema.Number,
  timeZone: Schema.String,
  source: Schema.Literal("agent-db"),
  summary: Schema.Struct({
    totalTokens: Schema.Number,
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    reasoningTokens: Schema.Number,
    cacheCreationTokens: Schema.Number,
    cacheReadTokens: Schema.Number,
    cacheHitRate: Schema.Number,
    totalSessions: Schema.Number,
    totalTurns: Schema.Number,
    toolCallCount: Schema.Number,
    toolErrorRate: Schema.Number,
    modelErrorRate: Schema.Number,
    avgTimeToFirstTokenMs: Schema.Union([Schema.Number, Schema.Null]),
    avgTurnDurationMs: Schema.Union([Schema.Number, Schema.Null]),
    activeDays: Schema.Number,
    currentStreakDays: Schema.Number,
    longestSessionMs: Schema.Number,
    longestStreakDays: Schema.Number,
    peakDayTokens: Schema.Number,
    favoriteModel: Schema.Union([
      Schema.Struct({
        modelId: Schema.Union([Schema.String, Schema.Null]),
        totalTokens: Schema.Number,
        share: Schema.Number,
      }),
      Schema.Null,
    ]),
  }),
  heatmap: Schema.Struct({
    startDate: Schema.Union([Schema.String, Schema.Null]),
    endDate: Schema.Union([Schema.String, Schema.Null]),
    maxTokens: Schema.Number,
    weeks: Schema.Array(
      Schema.Struct({
        weekIndex: Schema.Number,
        days: Schema.Array(
          Schema.Union([
            Schema.Struct({
              date: Schema.String,
              level: Schema.Union([
                Schema.Literal(0),
                Schema.Literal(1),
                Schema.Literal(2),
                Schema.Literal(3),
                Schema.Literal(4),
              ]),
              totalTokens: Schema.Number,
              turnCount: Schema.Number,
              toolCallCount: Schema.Number,
            }),
            Schema.Null,
          ]),
        ),
      }),
    ),
  }),
  dailyModelUsage: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      models: Schema.Array(
        Schema.Struct({
          modelId: Schema.Union([Schema.String, Schema.Null]),
          totalTokens: Schema.Number,
        }),
      ),
    }),
  ),
  models: Schema.Array(
    Schema.Struct({
      modelId: Schema.Union([Schema.String, Schema.Null]),
      totalTokens: Schema.Number,
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      requestCount: Schema.Number,
      share: Schema.Number,
    }),
  ),
  tools: Schema.Array(
    Schema.Struct({
      toolName: Schema.String,
      callCount: Schema.Number,
      errorCount: Schema.Number,
      errorRate: Schema.Number,
      avgDurationMs: Schema.Union([Schema.Number, Schema.Null]),
    }),
  ),
});
export type V4UsageStatsResult = typeof V4UsageStatsResult.Type;

// ── attachment transaction ──

export const V4AttachmentBeginParams = Schema.Struct({
  connectionId: nonEmptyString,
  uploadId: nonEmptyString,
  sessionId: nonEmptyString,
  fileName: nonEmptyString,
  mime: nonEmptyString,
  totalBytes: Schema.Int,
  totalChunks: Schema.Int,
  checksum: Schema.String,
});
export type V4AttachmentBeginParams = typeof V4AttachmentBeginParams.Type;

export const V4AttachmentBeginResult = Schema.Union([
  Schema.Struct({
    uploadId: nonEmptyString,
    state: Schema.Literal("staging"),
    nextChunkIndex: Schema.Int,
  }),
  Schema.Struct({
    uploadId: nonEmptyString,
    state: Schema.Literal("committed"),
    nextChunkIndex: Schema.Int,
    ref: nonEmptyString,
  }),
]);

export const V4AttachmentChunkParams = Schema.Struct({
  connectionId: nonEmptyString,
  uploadId: nonEmptyString,
  sessionId: nonEmptyString,
  chunkIndex: Schema.Int,
  dataBase64: Schema.String,
});

export const V4AttachmentChunkResult = Schema.Struct({
  uploadId: nonEmptyString,
  nextChunkIndex: Schema.Int,
});

const attachmentTerminalParams = {
  connectionId: nonEmptyString,
  uploadId: nonEmptyString,
  sessionId: nonEmptyString,
} as const;
export const V4AttachmentCommitParams = Schema.Struct(attachmentTerminalParams);
export const V4AttachmentCommitResult = Schema.Struct({ ref: nonEmptyString });
export const V4AttachmentAbortParams = Schema.Struct(attachmentTerminalParams);
export const V4AttachmentAbortResult = Schema.Struct({});

export const V4AttachmentReadParams = Schema.Struct({
  sessionId: nonEmptyString,
  ref: nonEmptyString,
  target: Schema.optionalKey(ConversationRowTarget),
  attachmentIndex: Schema.optionalKey(Schema.Int),
  offset: Schema.Int,
  limit: Schema.Int,
});

export const V4AttachmentReadResult = Schema.Struct({
  dataBase64: Schema.String,
  mediaType: Schema.String,
  totalBytes: Schema.Int,
  nextOffset: Schema.Union([Schema.Int, Schema.Null]),
});

export const V4ConversationAttachmentReadParams = Schema.Struct({
  sessionId: nonEmptyString,
  ref: nonEmptyString,
  target: ConversationRowTarget,
  attachmentIndex: Schema.Int,
  offset: Schema.Int,
  limit: Schema.Int,
});
export const V4ConversationAttachmentReadResult = V4AttachmentReadResult;

export const V4ConversationAttachmentStatParams = Schema.Struct({
  sessionId: nonEmptyString,
  ref: nonEmptyString,
  target: ConversationRowTarget,
  attachmentIndex: Schema.Int,
});
export const V4ConversationAttachmentStatResult = Schema.Struct({
  mediaType: nonEmptyString,
  totalBytes: Schema.Int,
  mtimeMs: Schema.optionalKey(Schema.Number),
});

export const V4ConnectionFlowParams = Schema.Struct({
  connectionId: nonEmptyString,
  state: Schema.Literals(["saturated", "drained", "closed"]),
});
export const V4ConnectionFlowResult = Schema.Struct({});

// ── v4/command envelope + ack ──

export const SharedContextRef = Schema.Struct({
  kind: Schema.Literal("shared_context_import"),
  context_id: nonEmptyString,
});

const modelExecutionFields = {
  selectionScope: Schema.Literal("execution"),
  memoryExtraction: Schema.optionalKey(Schema.Literal("skip")),
  offPeak: Schema.optionalKey(JsonObject),
  requestAuth: Schema.optionalKey(JsonObject),
  subagents: Schema.optionalKey(JsonObject),
  selectionFallback: Schema.optionalKey(JsonObject),
} as const;
export const ModelExecution = Schema.Struct(modelExecutionFields);

export const CreateSessionRequestedConfig = Schema.Struct({
  modelSelection: Schema.optionalKey(ModelSelection),
  provider: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  thought: Schema.optionalKey(Schema.String),
  followupMode: Schema.optionalKey(Schema.Literals(["queue", "guide"])),
  mode: Schema.optionalKey(Schema.String),
  planEnabled: Schema.optionalKey(Schema.Boolean),
});

export const ZCodeProtocolMcpServer = Schema.Union([
  Schema.Struct({
    name: nonEmptyString,
    command: nonEmptyString,
    args: Schema.Array(Schema.String),
    env: Schema.Array(Schema.Struct({ name: nonEmptyString, value: Schema.String })),
    isolation: Schema.optionalKey(Schema.Literals(["session", "workspace"])),
    protocolVersion: Schema.optionalKey(Schema.String),
    alwaysLoad: Schema.optionalKey(Schema.Boolean),
    timeoutMs: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    name: nonEmptyString,
    type: Schema.Literals(["http", "sse"]),
    url: nonEmptyString,
    headers: Schema.Array(Schema.Struct({ name: nonEmptyString, value: Schema.String })),
    oauth: Schema.optionalKey(JsonObject),
    isolation: Schema.optionalKey(Schema.Literals(["session", "workspace"])),
    protocolVersion: Schema.optionalKey(Schema.String),
    alwaysLoad: Schema.optionalKey(Schema.Boolean),
    timeoutMs: Schema.optionalKey(Schema.Int),
  }),
]);
export type ZCodeProtocolMcpServer = typeof ZCodeProtocolMcpServer.Type;

const inputSelectionFields = {
  modelSelection: Schema.optionalKey(ModelSelection),
  mode: Schema.optionalKey(SubmissionMode),
  planEnabled: Schema.optionalKey(Schema.Boolean),
  modelExecution: Schema.optionalKey(ModelExecution),
} as const;

const heldQueueFields = {
  heldQueueDisposition: Schema.optionalKey(
    Schema.Literals(["clearQueueAndSend", "keepQueueAndSend"]),
  ),
  expectedHeldQueueItemIds: Schema.optionalKey(Schema.Array(nonEmptyString)),
} as const;

export const CommandPayloadSchemas = {
  createSession: Schema.Struct({
    sessionId: Schema.optionalKey(nonEmptyString),
    additionalDirectories: Schema.optionalKey(Schema.Array(nonEmptyString)),
    workspaceId: Schema.String,
    permissionScope: Schema.optionalKey(Schema.Literal("session")),
    firstInput: Schema.optionalKey(
      Schema.Struct({
        text: Schema.String,
        attachments: Schema.optionalKey(Schema.Array(AttachmentRef)),
        modelSelection: Schema.optionalKey(ModelSelection),
        mode: Schema.optionalKey(SubmissionMode),
        planEnabled: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    config: Schema.optionalKey(CreateSessionRequestedConfig),
    mcpServers: Schema.optionalKey(Schema.Array(ZCodeProtocolMcpServer)),
    offPeakToolEnabled: Schema.optionalKey(Schema.Boolean),
    dynamicWorkflowEnabled: Schema.optionalKey(Schema.Boolean),
    dynamicWorkflowMode: Schema.optionalKey(Schema.Literals(["disabled", "onDemand", "alwaysOn"])),
  }),
  createSelectionSideSession: Schema.Struct({
    firstInput: Schema.optionalKey(
      Schema.Struct({
        text: nonEmptyString,
        modelSelection: Schema.optionalKey(ModelSelection),
      }),
    ),
  }),
  sendText: Schema.Struct({
    text: Schema.String,
    attachments: Schema.optionalKey(Schema.Array(AttachmentRef)),
    requestedDelivery: Schema.optionalKey(Schema.Literals(["startNow", "queue", "guide"])),
    browserAmbientContext: Schema.optionalKey(Schema.Unknown),
    context_refs: Schema.optionalKey(Schema.Array(SharedContextRef)),
    source: Schema.optionalKey(Schema.Unknown),
    ...heldQueueFields,
    ...inputSelectionFields,
    highspeedMeta: Schema.optionalKey(Schema.Unknown),
    automationId: Schema.optionalKey(nonEmptyString),
    offPeakTaskId: Schema.optionalKey(nonEmptyString),
    offPeakRunType: Schema.optionalKey(Schema.Literals(["init", "resume"])),
    botDeliveryTarget: Schema.optionalKey(Schema.Unknown),
    inputOrigin: Schema.optionalKey(Schema.Literals(["desktop", "mobile"])),
    botGroupSource: Schema.optionalKey(Schema.Unknown),
    conversationQuotes: Schema.optionalKey(Schema.Unknown),
    toolDisallowlist: Schema.optionalKey(Schema.Array(nonEmptyString)),
  }),
  sendGoalCommand: Schema.Struct({
    text: Schema.String,
    displayText: Schema.optionalKey(Schema.String),
    modelSelection: Schema.optionalKey(ModelSelection),
    mode: Schema.optionalKey(SubmissionMode),
    planEnabled: Schema.optionalKey(Schema.Boolean),
    ...heldQueueFields,
  }),
  stop: Schema.Struct({
    expectedForegroundExecutionId: Schema.optionalKey(nonEmptyString),
  }),
  compact: Schema.Struct({}),
  forkAssistant: Schema.Struct({ target: ConversationRowTarget }),
  applyFileRewind: Schema.Struct({ target: ConversationRowTarget }),
  editUserQuery: Schema.Struct({
    target: ConversationRowTarget,
    newText: Schema.String,
    conversationQuotes: Schema.optionalKey(Schema.Unknown),
    attachments: Schema.optionalKey(Schema.Array(AttachmentRef)),
    modelSelection: Schema.optionalKey(ModelSelection),
    modelExecution: Schema.optionalKey(ModelExecution),
    highspeedMeta: Schema.optionalKey(Schema.Unknown),
    workspaceMode: Schema.optionalKey(Schema.Literals(["preserve", "rewind"])),
  }),
  retryTurn: Schema.Struct({ target: ConversationRowTarget }),
  setAssistantFeedback: Schema.Struct({
    target: ConversationRowTarget,
    feedback: Schema.Union([Schema.Literals(["like", "dislike"]), Schema.Null]),
  }),
  setHighspeedMetrics: Schema.Struct({
    target: ConversationRowTarget,
    regularTps: Schema.Number,
    outputTokens: Schema.Int,
    durationMs: Schema.Number,
    highspeedTps: Schema.Number,
    savedDurationMs: Schema.Number,
    modelDurationMs: Schema.optionalKey(Schema.Number),
    toolDurationMs: Schema.optionalKey(Schema.Number),
    otherDurationMs: Schema.optionalKey(Schema.Number),
  }),
  sendQueuedNow: Schema.Struct({
    queueItemId: Schema.String,
    modelSelection: Schema.optionalKey(ModelSelection),
    modelExecution: Schema.optionalKey(ModelExecution),
    highspeedMeta: Schema.optionalKey(Schema.Unknown),
  }),
  editQueueItem: Schema.Struct({ queueItemId: Schema.String, newText: Schema.String }),
  reorderQueueItem: Schema.Struct({
    queueItemId: Schema.String,
    beforeQueueItemId: Schema.Union([Schema.String, Schema.Null]),
  }),
  deleteQueueItem: Schema.Struct({ queueItemId: Schema.String }),
  setAutoDrain: Schema.Struct({ autoDrain: Schema.Boolean }),
  resolveInteraction: Schema.Struct({
    interactionId: Schema.String,
    answer: Schema.Struct({
      optionId: Schema.optionalKey(Schema.String),
      freeText: Schema.optionalKey(Schema.String),
      action: Schema.optionalKey(Schema.Literals(["accept", "decline", "cancel"])),
      content: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  }),
  respondWorkspaceHookReview: Schema.Struct({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
    runId: nonEmptyString,
    remoteSessionId: Schema.optionalKey(nonEmptyString),
    workspaceIdentity: nonEmptyString,
    bundleDigest: Schema.String,
    reviewFlowId: nonEmptyString,
    generation: Schema.Int,
    interactionId: nonEmptyString,
    decision: Schema.Struct({
      action: Schema.Literal("trust_selected"),
      reviewItemIds: Schema.Array(nonEmptyString),
    }),
  }),
  toggleWorkspaceHookReviewItem: Schema.Struct({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
    runId: nonEmptyString,
    remoteSessionId: Schema.optionalKey(nonEmptyString),
    workspaceIdentity: nonEmptyString,
    bundleDigest: Schema.String,
    reviewFlowId: nonEmptyString,
    generation: Schema.Int,
    interactionId: nonEmptyString,
    reviewItemId: nonEmptyString,
    enabled: Schema.Boolean,
  }),
  // Upstream z.union: flow-scoped revoke (commandTarget + reviewItemIds) or
  // declaration-digest revoke; the flattened optional version let either side
  // through under-specified.
  revokeWorkspaceHookTrust: Schema.Union([
    Schema.Struct({
      sessionId: nonEmptyString,
      taskId: nonEmptyString,
      runId: nonEmptyString,
      remoteSessionId: Schema.optionalKey(nonEmptyString),
      workspaceIdentity: nonEmptyString,
      bundleDigest: Schema.String,
      reviewFlowId: nonEmptyString,
      generation: Schema.Int,
      interactionId: nonEmptyString,
      reviewItemIds: Schema.Array(nonEmptyString).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({
      sessionId: nonEmptyString,
      remoteSessionId: Schema.optionalKey(nonEmptyString),
      workspaceIdentity: nonEmptyString,
      bundleDigest: Schema.String,
      hookDeclarationDigests: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    }),
  ]),
  requestWorkspaceHookReview: Schema.Struct({
    sessionId: nonEmptyString,
    remoteSessionId: Schema.optionalKey(nonEmptyString),
    workspaceIdentity: nonEmptyString,
    bundleDigest: Schema.String,
  }),
  snoozeInteractionAutoResolution: Schema.Struct({ interactionId: Schema.String }),
  switchModelConfig: Schema.Struct({
    provider: Schema.String,
    model: Schema.String,
    thought: Schema.String,
  }),
  switchCollaborationMode: Schema.Struct({ mode: SubmissionMode }),
  setFollowupMode: Schema.Struct({ mode: Schema.Literals(["queue", "guide"]) }),
  pauseGoal: Schema.Struct({}),
  resumeGoal: Schema.Struct({}),
  cancelBackgroundWork: Schema.Struct({ workId: Schema.String }),
  resumeWorkflowRun: Schema.Struct({
    workId: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
  startSavedWorkflow: Schema.Struct({
    name: nonEmptyString,
    scope: Schema.optionalKey(Schema.Literals(["project", "global"])),
    args: Schema.optionalKey(JsonObject),
  }),
  amendWorkflowRunSettings: Schema.Struct({
    workId: Schema.String,
    subagentModel: Schema.optionalKey(Schema.Union([nonEmptyString, Schema.Null])),
    maxConcurrency: Schema.optionalKey(Schema.Union([Schema.Int, Schema.Null])),
  }),
  renameSession: Schema.Struct({ title: Schema.String }),
  deleteSession: Schema.Struct({}),
  discardSharedContext: Schema.Struct({ contextId: nonEmptyString }),
} as const;

export type CommandType = keyof typeof CommandPayloadSchemas;
export const CommandType = Schema.Literals(
  Object.keys(CommandPayloadSchemas) as [CommandType, ...Array<CommandType>],
);

/** Commands whose envelope must carry baseRevision (CAS) per upstream. */
export const COMMANDS_REQUIRING_BASE_REVISION: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "sendQueuedNow",
  "editQueueItem",
  "reorderQueueItem",
  "deleteQueueItem",
  "setAutoDrain",
  "switchModelConfig",
  "switchCollaborationMode",
  "setFollowupMode",
  "pauseGoal",
  "resumeGoal",
]);

/** Row-targeted commands also require baseLogEpoch in the envelope. */
export const ROW_TARGETING_COMMANDS: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "setHighspeedMetrics",
]);

const commandEnvelopeBase = {
  commandId: Schema.String,
  clientId: Schema.String,
  sessionId: Schema.Union([Schema.String, Schema.Null]),
  baseRevision: Schema.optionalKey(Schema.Number),
  baseLogEpoch: Schema.optionalKey(nonEmptyString),
  // ttft telemetry context is optional and client-generated; skipped.
  issuedAt: Timestamp,
} as const;

export type CommandPayloadFor<T extends CommandType> = Schema.Schema.Type<
  (typeof CommandPayloadSchemas)[T]
>;

export type CommandEnvelopeFor<T extends CommandType> = {
  readonly commandId: string;
  readonly clientId: string;
  readonly sessionId: string | null;
  readonly baseRevision?: number;
  readonly baseLogEpoch?: string;
  readonly issuedAt: number;
  readonly type: T;
  readonly payload: CommandPayloadFor<T>;
};

/** Envelope discriminated by `type` so `payload` is typed per command. */
export type CommandEnvelope = {
  readonly [T in CommandType]: CommandEnvelopeFor<T>;
}[CommandType];

// Wire-level envelope: upstream validates the envelope shape first, then the
// payload against the per-type schema (parseCommandEnvelope does the same).
export const CommandEnvelopeWire = Schema.Struct({
  ...commandEnvelopeBase,
  type: CommandType,
  payload: Schema.Unknown,
});
export type CommandEnvelopeWire = typeof CommandEnvelopeWire.Type;

// Per-type payload decoders compiled once at module scope.
const commandPayloadDecoders = new Map(
  (Object.keys(CommandPayloadSchemas) as Array<CommandType>).map(
    (type) => [type, Schema.decodeSync(CommandPayloadSchemas[type])] as const,
  ),
);

/** Thrown when an outbound envelope violates upstream CAS rules. */
export class CommandEnvelopeValidationError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`CAS commands require ${field}`);
    this.name = "CommandEnvelopeValidationError";
    this.field = field;
  }
}

/**
 * Typed outbound envelope factory. Enforces the same invariants upstream's
 * parseCommandEnvelope checks: CAS commands must carry baseRevision (and
 * row-targeting commands baseLogEpoch), and the payload must satisfy the
 * per-command schema (which owns row `target` and every other field rule).
 */
export const makeCommandEnvelope = <T extends CommandType>(
  envelope: CommandEnvelopeFor<T>,
): CommandEnvelopeFor<T> => {
  if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type) && envelope.baseRevision === undefined) {
    throw new CommandEnvelopeValidationError("baseRevision");
  }
  if (ROW_TARGETING_COMMANDS.has(envelope.type) && envelope.baseLogEpoch === undefined) {
    throw new CommandEnvelopeValidationError("baseLogEpoch");
  }
  commandPayloadDecoders.get(envelope.type)?.(envelope.payload);
  return envelope;
};

export const CommandResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["createSession", "createSelectionSideSession", "forkAssistant"]),
    sessionId: Schema.String,
    input: Schema.optionalKey(
      Schema.Struct({
        delivery: Schema.Literals(["startNow", "queue", "guide"]),
        inputId: Schema.String,
        messageId: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("resolveInteraction"),
    resolvedBy: Schema.Struct({
      clientId: Schema.String,
      optionId: Schema.optionalKey(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("applyFileRewind"),
    applied: Schema.Boolean,
    preview: V4FileRewindPreviewResult,
    response: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("editUserQuery"),
    disposition: Schema.Literals(["rewind", "fork", "blocked"]),
    sessionId: nonEmptyString,
    reasonCode: Schema.optionalKey(nonEmptyString),
    preview: Schema.optionalKey(V4FileRewindPreviewResult),
  }),
  Schema.Struct({
    type: Schema.Literal("startSavedWorkflow"),
    runId: nonEmptyString,
    toolCallId: nonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("amendWorkflowRunSettings"),
    // runId/toolCallId identify the NEW run; supersededRunId only when the old
    // run was still in flight and got stopped by this amendment.
    runId: nonEmptyString,
    toolCallId: nonEmptyString,
    supersededRunId: Schema.optionalKey(nonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("inputAccepted"),
    delivery: Schema.Literals(["startNow", "queue", "guide"]),
    inputId: Schema.String,
    messageId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("inputDisposition"),
    delivery: Schema.Literals(["startNow", "queue", "guide"]),
  }),
]);
export type CommandResult = typeof CommandResult.Type;

export const CommandAck = Schema.Struct({
  memoryEnabled: Schema.optionalKey(Schema.Boolean),
  ttftExcluded: Schema.optionalKey(Schema.Literal("capacity")),
  commandId: Schema.String,
  status: Schema.Literals(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]),
  reasonCode: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  revisionAtDecision: Schema.Number,
  result: Schema.optionalKey(CommandResult),
});
export type CommandAck = typeof CommandAck.Type;

export const CommandKey = Schema.Struct({
  sessionId: Schema.Union([Schema.String, Schema.Null]),
  commandId: nonEmptyString,
});

export const CommandsQueryParams = Schema.Struct({
  commands: Schema.Array(CommandKey),
  clock: Schema.optionalKey(Schema.Literal(true)),
});
export type CommandsQueryParams = typeof CommandsQueryParams.Type;

export const CommandsQueryResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      key: CommandKey,
      result: Schema.Union([CommandAck, Schema.Literal("unknown")]),
    }),
  ),
  clock: Schema.optionalKey(JsonObject),
});
export type CommandsQueryResult = typeof CommandsQueryResult.Type;

// ── legacy methods kept on the wire ──

export const ZCodeSessionGoal = Schema.Struct({
  sessionId: nonEmptyString,
  targetId: nonEmptyString,
  objective: nonEmptyString,
  summaryTitle: Schema.optionalKey(Schema.Union([nonEmptyString, Schema.Null])),
  status: Schema.Literals(["active", "paused", "budget_limited", "complete"]),
  tokenBudget: Schema.Union([Schema.Int, Schema.Null]),
  tokensUsed: Schema.Int,
  timeUsedSeconds: Schema.Int,
  activeInputId: Schema.optionalKey(Schema.Union([nonEmptyString, Schema.Null])),
  activeRunStartedAtMs: Schema.optionalKey(Schema.Union([Schema.Int, Schema.Null])),
  activeRunLastSeenAtMs: Schema.optionalKey(Schema.Union([Schema.Int, Schema.Null])),
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
});

export const ZCodeSessionInfo = Schema.Struct({
  sessionId: nonEmptyString,
  workspace: ZCodeWorkspaceRef,
  parentSessionId: Schema.optionalKey(nonEmptyString),
  traceId: Schema.optionalKey(nonEmptyString),
  sessionKind: Schema.Literals([
    "interactive",
    "fork",
    "selection_side_chat",
    "workflow_parent",
    "workflow_child",
    "subagent_child",
    "nested_workflow_child",
  ]),
  title: Schema.String,
  titleSource: Schema.optionalKey(
    Schema.Literals(["default", "first_input", "generated", "custom"]),
  ),
  mode: Schema.Literals(["plan", "build", "edit", "yolo", "guarded", "auto"]),
  status: Schema.Literals(["idle", "running", "waiting", "paused", "completed", "error"]),
  model: Schema.optionalKey(ModelSelection),
  target: Schema.optionalKey(Schema.Union([ZCodeSessionGoal, Schema.Null])),
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
});
export type ZCodeSessionInfo = typeof ZCodeSessionInfo.Type;

export const ZCodeSessionListParams = Schema.Struct({
  workspace: Schema.optionalKey(ZCodeWorkspaceRef),
  sessionIds: Schema.optionalKey(Schema.Array(nonEmptyString)),
  limit: Schema.optionalKey(Schema.Int),
});
export type ZCodeSessionListParams = typeof ZCodeSessionListParams.Type;

export const ZCodeSessionListResult = Schema.Struct({
  sessions: Schema.Array(ZCodeSessionInfo),
});
export type ZCodeSessionListResult = typeof ZCodeSessionListResult.Type;

export const ZCodeSessionCloseParams = Schema.Struct({
  sessionId: nonEmptyString,
  expectedPersistence: Schema.optionalKey(Schema.Literals(["immediate", "deferred"])),
});
export const ZCodeSessionCloseResult = Schema.Struct({
  closed: Schema.optionalKey(Schema.Boolean),
});

export const ZCodeSkillReferenceCatalogEntry = Schema.Struct({
  id: nonEmptyString,
  name: nonEmptyString,
  description: Schema.String,
  path: nonEmptyString,
  scope: Schema.Literals(["workspace", "user", "plugin"]),
  enabled: Schema.Literal(true),
  pluginName: Schema.optionalKey(nonEmptyString),
});
export type ZCodeSkillReferenceCatalogEntry = typeof ZCodeSkillReferenceCatalogEntry.Type;

export const ZCodeSkillsReferenceCatalogParams = Schema.Struct({
  workspace: ZCodeWorkspaceRef,
  sessionId: Schema.optionalKey(nonEmptyString),
});
export type ZCodeSkillsReferenceCatalogParams = typeof ZCodeSkillsReferenceCatalogParams.Type;

export const ZCodeSkillsReferenceCatalogResult = Schema.Struct({
  authority: Schema.Literals(["session", "workspace"]),
  skills: Schema.Array(ZCodeSkillReferenceCatalogEntry),
});
export type ZCodeSkillsReferenceCatalogResult = typeof ZCodeSkillsReferenceCatalogResult.Type;

export const ZCodePluginReferenceCatalogEntry = Schema.Struct({
  category: Schema.optionalKey(nonEmptyString),
  pluginId: nonEmptyString,
  name: nonEmptyString,
  marketplace: nonEmptyString,
  icon: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  displayNameI18n: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  description: Schema.optionalKey(Schema.String),
  descriptionI18n: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.Boolean,
  conflictingPluginIds: Schema.Array(nonEmptyString),
  skillQualifiedNames: Schema.Array(nonEmptyString),
  mcpServerNames: Schema.Array(nonEmptyString),
  subagentNames: Schema.optionalKey(Schema.Array(nonEmptyString)),
});
export type ZCodePluginReferenceCatalogEntry = typeof ZCodePluginReferenceCatalogEntry.Type;

export const ZCodePluginsReferenceCatalogParams = Schema.Struct({
  workspace: ZCodeWorkspaceRef,
  sessionId: Schema.optionalKey(nonEmptyString),
});
export const ZCodePluginsReferenceCatalogResult = Schema.Struct({
  authority: Schema.Literals(["session", "workspace"]),
  plugins: Schema.Array(ZCodePluginReferenceCatalogEntry),
});

export const ZCodeProviderUpdateAccountConfigParams = Schema.Struct({
  revision: nonEmptyString,
  basedOnZCodeBuiltinRevision: nonEmptyString,
  // Provider-rule field validation belongs to the agent; the envelope is opaque.
  providers: JsonObject,
  states: Schema.Record(
    Schema.String,
    Schema.Struct({
      availability: Schema.Literals(["available", "pending", "unavailable", "unknown"]),
      entitled: Schema.Boolean,
      unavailableReason: Schema.optionalKey(
        Schema.Literals([
          "not-authenticated",
          "not-connected",
          "credential-failed",
          "not-entitled",
        ]),
      ),
      current: Schema.optionalKey(Schema.Boolean),
      connectionKey: Schema.optionalKey(Schema.String),
      effectiveAt: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type ZCodeProviderUpdateAccountConfigParams =
  typeof ZCodeProviderUpdateAccountConfigParams.Type;

export const ZCodeProviderUpdateAccountConfigResult = Schema.Struct({
  receivedRevision: nonEmptyString,
  providerCount: Schema.Int,
  status: Schema.Literals(["received", "unchanged"]),
});

export const ZCodeProviderRefreshRegistryParams = Schema.Struct({ reason: nonEmptyString });
export const ZCodeProviderRefreshRegistryResult = Schema.Struct({
  refreshed: Schema.Literal(true),
});

export const ZCodeProviderTestModelConnectivityParams = Schema.Struct({
  workspace: ZCodeWorkspaceRef,
  selection: ModelSelection,
});
export const ZCodeProviderTestModelConnectivityResult = Schema.Struct({
  success: Schema.Literal(true),
});

export const ZCodeWorkspaceGenerateTextParams = Schema.Struct({
  workspace: ZCodeWorkspaceRef,
  selection: ModelSelection,
  prompt: Schema.optionalKey(nonEmptyString),
  messages: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
        Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
        Schema.Struct({
          role: Schema.Literal("assistant"),
          content: Schema.String,
          toolCalls: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({ id: nonEmptyString, name: nonEmptyString, input: Schema.Unknown }),
            ),
          ),
        }),
        Schema.Struct({
          role: Schema.Literal("tool"),
          content: Schema.String,
          toolCallId: nonEmptyString,
          toolName: nonEmptyString,
          isError: Schema.optionalKey(Schema.Boolean),
        }),
      ]),
    ),
  ),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: nonEmptyString,
        description: Schema.optionalKey(Schema.String),
        inputSchema: JsonObject,
      }),
    ),
  ),
  querySource: nonEmptyString,
  maxOutputTokens: Schema.optionalKey(Schema.Int),
  operationId: Schema.optionalKey(nonEmptyString),
});
export type ZCodeWorkspaceGenerateTextParams = typeof ZCodeWorkspaceGenerateTextParams.Type;

export const ZCodeWorkspaceGenerateTextResult = Schema.Struct({
  text: Schema.String,
  selection: ModelSelection,
  toolCalls: Schema.optionalKey(Schema.Array(JsonObject)),
  finishReason: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(JsonObject),
});
export type ZCodeWorkspaceGenerateTextResult = typeof ZCodeWorkspaceGenerateTextResult.Type;

export const ZCodeWorkspaceCancelGenerateTextParams = Schema.Struct({
  operationId: nonEmptyString,
});
export const ZCodeWorkspaceCancelGenerateTextResult = Schema.Struct({
  operationId: nonEmptyString,
  cancelled: Schema.Boolean,
});

// ── server→client runtime preferences (session/requestRuntimePreferences) ──

export const ZCodeSessionRuntimePreferencesScope = Schema.Literals([
  "runtime-materialization",
  "user-execution",
]);
export type ZCodeSessionRuntimePreferencesScope = typeof ZCodeSessionRuntimePreferencesScope.Type;

export const ZCodeSessionRequestRuntimePreferencesParams = Schema.Struct({
  sessionId: nonEmptyString,
  scope: ZCodeSessionRuntimePreferencesScope,
});
export type ZCodeSessionRequestRuntimePreferencesParams =
  typeof ZCodeSessionRequestRuntimePreferencesParams.Type;

export const ZCodeModelContextBudgetStrategy = Schema.Literals(["legacy", "preflight-v1"]);
export type ZCodeModelContextBudgetStrategy = typeof ZCodeModelContextBudgetStrategy.Type;

// Upstream zcodeSessionRuntimePreferencesResultSchema; hosts may omit the
// defaulted fields — the server normalizes them at the protocol boundary.
export const ZCodeSessionRuntimePreferencesResult = Schema.Struct({
  additionalDirectories: Schema.optionalKey(
    Schema.Array(nonEmptyString).check(Schema.isMaxLength(256)),
  ),
  nativeSearchEnhancementsEnabled: Schema.Boolean,
  toolSearchMode: Schema.optionalKey(Schema.String),
  subagentRuntimeConfigEnabled: Schema.optionalKey(Schema.Boolean),
  memoryEnabled: Schema.optionalKey(Schema.Boolean),
  askUserQuestionAutoResolutionEnabled: Schema.optionalKey(Schema.Boolean),
  integratedTerminalShell: Schema.optionalKey(Schema.Unknown),
  modelContextBudgetStrategy: Schema.optionalKey(ZCodeModelContextBudgetStrategy),
});
export type ZCodeSessionRuntimePreferencesResult = typeof ZCodeSessionRuntimePreferencesResult.Type;

// ── server→client reverse requests (interaction/*) ──

export const ZCodePermissionOption = Schema.Struct({
  optionId: nonEmptyString,
  kind: nonEmptyString,
  name: nonEmptyString,
  description: Schema.optionalKey(Schema.String),
  response: Schema.Struct({
    decision: Schema.Literals(["allow", "deny", "escalate", "modify"]),
    reason: Schema.optionalKey(Schema.String),
    modifiedInput: Schema.optionalKey(Schema.Unknown),
    permissionUpdates: Schema.optionalKey(Schema.Array(JsonObject)),
  }),
});

export const ZCodePermissionRequestParams = Schema.Struct({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  turnId: Schema.optionalKey(nonEmptyString),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  reason: Schema.String,
  riskLevel: Schema.Literals(["low", "medium", "high", "critical"]),
  input: Schema.Unknown,
  origin: Schema.optionalKey(JsonObject),
  options: Schema.Array(ZCodePermissionOption),
});
export type ZCodePermissionRequestParams = typeof ZCodePermissionRequestParams.Type;

export const ZCodePermissionResponse = Schema.Struct({
  decision: Schema.Literals(["allow", "deny", "escalate", "modify"]),
  reason: Schema.optionalKey(Schema.String),
  modifiedInput: Schema.optionalKey(Schema.Unknown),
  permissionUpdates: Schema.optionalKey(Schema.Array(JsonObject)),
});
export type ZCodePermissionResponse = typeof ZCodePermissionResponse.Type;

export const ZCodeUserInputRequestParams = Schema.Struct({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  turnId: Schema.optionalKey(nonEmptyString),
  toolCallId: Schema.optionalKey(nonEmptyString),
  toolName: Schema.optionalKey(nonEmptyString),
  prompt: Schema.optionalKey(Schema.String),
  questions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        question: nonEmptyString,
        header: nonEmptyString,
        options: Schema.Array(
          Schema.Struct({
            value: nonEmptyString,
            label: nonEmptyString,
            description: Schema.optionalKey(Schema.String),
            preview: Schema.optionalKey(Schema.String),
          }),
        ),
        multiSelect: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  input: Schema.optionalKey(Schema.Unknown),
  origin: Schema.optionalKey(JsonObject),
  schema: Schema.optionalKey(Schema.Unknown),
});
export type ZCodeUserInputRequestParams = typeof ZCodeUserInputRequestParams.Type;

export const ZCodeUserInputResponse = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optionalKey(JsonObject),
  reason: Schema.optionalKey(Schema.String),
});
export type ZCodeUserInputResponse = typeof ZCodeUserInputResponse.Type;

export const ZCodeProviderRuntimeHeadersRequestParams = Schema.Struct({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  turnId: Schema.optionalKey(nonEmptyString),
  workspace: ZCodeWorkspaceRef,
  modelSelection: ModelSelection,
  providerId: nonEmptyString,
  accountAccess: Schema.optionalKey(JsonObject),
  expectedAccountScope: Schema.optionalKey(Schema.String),
  rejectedProjectTokenFingerprint: Schema.optionalKey(Schema.String),
  reason: Schema.String,
});
export type ZCodeProviderRuntimeHeadersRequestParams =
  typeof ZCodeProviderRuntimeHeadersRequestParams.Type;

export const ZCodeProviderRuntimeHeadersResponse = Schema.Union([
  Schema.Struct({
    headersApplied: Schema.Literal(true),
    requestAuth: Schema.Struct({
      apiKey: Schema.optionalKey(nonEmptyString),
      apiKeyId: Schema.optionalKey(nonEmptyString),
      accountScope: Schema.optionalKey(Schema.String),
      headers: Schema.optionalKey(Schema.Record(nonEmptyString, nonEmptyString)),
    }),
    errorMessage: Schema.optionalKey(nonEmptyString),
  }),
  Schema.Struct({
    headersApplied: Schema.Literal(false),
    errorMessage: Schema.optionalKey(nonEmptyString),
  }),
]);
export type ZCodeProviderRuntimeHeadersResponse = typeof ZCodeProviderRuntimeHeadersResponse.Type;

export const ZCodeProviderRuntimeHeadersCancelled = Schema.Struct({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  workspace: ZCodeWorkspaceRef,
});

export const ZCodeOfficialMcpAuthHeadersRequestParams = Schema.Struct({
  requestId: nonEmptyString,
  workspace: ZCodeWorkspaceRef,
  pluginId: nonEmptyString,
  mcpKey: nonEmptyString,
  targetOrigin: nonEmptyString,
});

export const ZCodeOfficialMcpAuthHeadersResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), headers: Schema.Record(Schema.String, Schema.String) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals([
      "official_auth_unavailable",
      "official_auth_plan_required",
      "official_mcp_origin_untrusted",
    ]),
  }),
]);
export type ZCodeOfficialMcpAuthHeadersResponse = typeof ZCodeOfficialMcpAuthHeadersResponse.Type;

// Browser reverse requests: T3 has no browser executor; params are decoded so a
// responder can be registered, but the plan answers these with an error.
export const ZCodeBrowserListParams = Schema.Struct({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  turnId: Schema.optionalKey(nonEmptyString),
  workspaceKey: nonEmptyString,
  workspacePath: nonEmptyString,
  workspaceIdentity: Schema.optionalKey(nonEmptyString),
  remoteSessionId: Schema.optionalKey(nonEmptyString),
  clientMode: Schema.String,
  sessionContext: Schema.String,
});

export const ZCodeBrowserExecuteParams = Schema.Struct({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  turnId: Schema.optionalKey(nonEmptyString),
  browserId: Schema.optionalKey(nonEmptyString),
  browserGeneration: Schema.optionalKey(Schema.Int),
  workspaceKey: Schema.optionalKey(nonEmptyString),
  workspacePath: Schema.optionalKey(nonEmptyString),
  workspaceIdentity: Schema.optionalKey(nonEmptyString),
  remoteSessionId: Schema.optionalKey(nonEmptyString),
  clientMode: Schema.optionalKey(Schema.String),
  sessionContext: Schema.optionalKey(Schema.String),
  command: Schema.Unknown,
});
