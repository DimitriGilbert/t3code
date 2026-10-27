/**
 * Pure ZCode v4 row → orchestration projection helpers (row kinds, statuses,
 * tool-call item kinds, timeline text, permission answers). No Effect code.
 *
 * @module provider-zcode/server/zcodeRows
 */
import type {
  ModelSelection,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderRequestKind,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";

/** Stable per-session native item id derived from the row coordinates. */
export function zcodeNativeItemId(sessionId: string, rowId: number): string {
  return `${sessionId}:row:${rowId}`;
}

export function zcodeTurnItemStatusForText(
  state: "streaming" | "complete" | "interrupted" | "failed",
): OrchestrationV2TurnItem["status"] {
  switch (state) {
    case "streaming":
      return "running";
    case "complete":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function zcodeToolCallItemStatus(
  status: ZCodeSchema.ToolCallRow["status"],
): OrchestrationV2TurnItem["status"] {
  switch (status) {
    case "inputStreaming":
    case "running":
      return "running";
    case "pendingApproval":
      return "waiting";
    case "success":
      return "completed";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export type ZcodeToolItemKind = "command_execution" | "file_change" | "dynamic_tool";

const COMMAND_TOOL_NAMES = new Set(["bash", "shell", "sh", "run", "terminal"]);
const FILE_CHANGE_TOOL_NAMES = new Set([
  "edit",
  "write",
  "multiedit",
  "applypatch",
  "notebookedit",
  "fileedit",
  "filewrite",
]);
const FILE_READ_TOOL_NAMES = new Set(["read", "fileread", "cat"]);

/** ZCode's own tool names (Bash/Edit/Write/Read…) mapped onto T3 item kinds. */
export function zcodeToolItemKind(toolName: string): ZcodeToolItemKind {
  const normalized = toolName.trim().toLowerCase();
  if (COMMAND_TOOL_NAMES.has(normalized)) return "command_execution";
  if (FILE_CHANGE_TOOL_NAMES.has(normalized)) return "file_change";
  return "dynamic_tool";
}

/** ProviderRequestKind for a permission prompt, keyed by the gated tool. */
export function zcodeRequestKindForTool(toolName: string): ProviderRequestKind {
  const normalized = toolName.trim().toLowerCase();
  if (COMMAND_TOOL_NAMES.has(normalized)) return "command";
  if (FILE_CHANGE_TOOL_NAMES.has(normalized)) return "file-change";
  if (FILE_READ_TOOL_NAMES.has(normalized)) return "file-read";
  return "permission";
}

const unknownRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Best-effort command string for a shell-shaped tool call input. */
export function zcodeToolCommandText(row: ZCodeSchema.ToolCallRow): string {
  const input = unknownRecord(row.input);
  const command = input?.command ?? input?.cmd ?? input?.input;
  return typeof command === "string" && command.length > 0 ? command : row.inputText;
}

/** File path(s) for file-change tools; falls back to the display name. */
export function zcodeToolFilePath(row: ZCodeSchema.ToolCallRow): string {
  const input = unknownRecord(row.input);
  for (const key of ["file_path", "path", "filePath", "filename"] as const) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return row.toolName;
}

export function zcodeToolOutputText(row: ZCodeSchema.ToolCallRow): string | undefined {
  return row.output?.text ?? row.outputPreview?.text;
}

export function zcodeTimelineMarkerText(marker: ZCodeSchema.TimelineMarkerPayload): string {
  switch (marker.type) {
    case "compact":
      return marker.status === "running"
        ? "Compacting conversation history…"
        : marker.status === "success"
          ? "Conversation history compacted."
          : `Conversation compaction ${marker.status}.`;
    case "forkNotice":
      return `This session was forked from session ${marker.parentSessionId}.`;
    case "forkCreated":
      return `Forked a new session at this point: ${marker.childSessionId}.`;
    case "modelChange":
      return `Model switched to ${marker.toModel} (${marker.toProvider}).`;
    case "goalSet":
      return `Goal set: ${marker.objective}`;
    case "goalVerify":
      return `Goal verification ${marker.outcome}.`;
    case "retryNotice":
      return `Retrying request (attempt ${marker.attempt}): ${marker.reasonCode}.`;
    case "checkpointRestored":
      return `Workspace restored to checkpoint ${marker.checkpointId}.`;
    default: {
      const unreachable: never = marker;
      return unreachable;
    }
  }
}

export function zcodeProviderTurnStatus(
  state: ZCodeSchema.TurnHeaderRow["state"],
): "running" | "completed" | "interrupted" | "failed" {
  switch (state) {
    case "running":
      return "running";
    case "completedSuccess":
      return "completed";
    case "completedInterrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

const ZCODE_DEFAULT_MODEL_SLUG_VALUE = "default";
/** Default reasoning level when the session config carries none. */
export const ZCODE_DEFAULT_REASONING_LEVEL = "max";

/**
 * `builtin:` provider ids from the ACP bridge and pre-registry ZCode, mapped
 * to current ids (mirrors upstream `migrateLegacyModelProviderId`). Unknown
 * `builtin:` ids carry no provider.
 */
const ZCODE_LEGACY_PROVIDER_ID_MAP: Readonly<Record<string, string>> = {
  "builtin:bigmodel": "bigmodel-api",
  "builtin:zai": "zai-api",
  "builtin:bigmodel-start-plan": "account:bigmodel-start-plan",
  "builtin:zai-start-plan": "account:zai-start-plan",
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
};

/** Current provider id for a possibly-legacy `builtin:` id; undefined when unmappable. */
function zcodeMigrateLegacyProviderId(providerId: string): string | undefined {
  return providerId.startsWith("builtin:") ? ZCODE_LEGACY_PROVIDER_ID_MAP[providerId] : providerId;
}

/** Old `provider=glm|zcode` values name execution backends, not supplier ids. */
const ZCODE_LEGACY_BACKEND_PROVIDER_IDS: ReadonlySet<string> = new Set(["glm", "zcode"]);

/**
 * Providers whose model ids canonicalize to the official GLM spelling on
 * legacy reads — mirrors upstream `migrateLegacyOfficialGlmModelId`.
 */
const ZCODE_OFFICIAL_GLM_PROVIDER_PATTERN =
  /^(?:builtin:(?:zai|bigmodel)(?:-start-plan|-coding-plan)?|account:(?:zai|bigmodel)-(?:start-plan|individual-coding-plan|team-coding-plan))$/;

/** Upstream `OFFICIAL_GLM_MODEL_IDS` (shared/official-glm-model-id.ts). */
const ZCODE_OFFICIAL_GLM_MODEL_IDS: ReadonlyArray<string> = [
  "GLM-5.3",
  "GLM-5.3-Flash",
  "GLM-5V-Turbo",
  "GLM-5.2",
  "GLM-5.1",
  "GLM-5.1-Highspeed",
  "GLM-5",
  "GLM-5-Turbo",
  "GLM-4.7",
  "GLM-4.7-FlashX",
  "GLM-4.7-Flash",
  "GLM-4.6",
  "GLM-4.5-Air",
  "GLM-4.5",
  "GLM-4.6V",
  "GLM-4.6V-Flash",
  "GLM-4.6V-FlashX",
  "GLM-4.1V-Thinking-FlashX",
  "GLM-4.1V-Thinking-Flash",
  "GLM-4-FlashX-250414",
  "GLM-4-Flash-250414",
  "GLM-4V-Flash",
];
const ZCODE_OFFICIAL_GLM_MODEL_ID_BY_LOWERCASE: ReadonlyMap<string, string> = new Map(
  ZCODE_OFFICIAL_GLM_MODEL_IDS.map((id) => [id.toLowerCase(), id]),
);

const zcodeDecodeSlugComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

interface ZcodeParsedModelSlug {
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly reasoningLevel?: string | undefined;
}

/**
 * Split a stored slug into provider/model/reasoning parts. Besides
 * `providerId/modelId`, persisted values also appear as `providerId\modelId`,
 * `custom:<provider>:<model>` (URI-encoded, `builtin:` two-segment), and
 * `modelId$reasoningLevel`.
 */
function zcodeParseModelSlug(slug: string): ZcodeParsedModelSlug {
  if (slug.startsWith("custom:")) {
    const body = slug.slice("custom:".length);
    const separator = body.indexOf(":");
    if (separator < 0) return { providerId: zcodeDecodeSlugComponent(body) };
    const parts = body.split(":");
    if (parts.length >= 3 && parts[0] === "builtin") {
      return {
        providerId: `builtin:${parts[1]}`,
        modelId: zcodeDecodeSlugComponent(parts.slice(2).join(":")),
      };
    }
    return {
      providerId: zcodeDecodeSlugComponent(body.slice(0, separator)),
      modelId: zcodeDecodeSlugComponent(body.slice(separator + 1)),
    };
  }
  const slash = slug.indexOf("/");
  const backslash = slug.indexOf("\\");
  const separator =
    slash >= 0 && (backslash < 0 || slash < backslash) ? slash : backslash >= 0 ? backslash : slash;
  if (separator <= 0) return { modelId: slug };
  let modelId = slug.slice(separator + 1);
  let reasoningLevel: string | undefined;
  const levelSeparator = modelId.indexOf("$");
  if (levelSeparator > 0 && levelSeparator < modelId.length - 1) {
    reasoningLevel = modelId.slice(levelSeparator + 1);
    modelId = modelId.slice(0, levelSeparator);
  }
  return { providerId: slug.slice(0, separator), modelId, reasoningLevel };
}

export interface ZcodeResolvedModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevel: string;
}

/**
 * Resolve a T3 model slug (`<providerId>/<modelId>`, a bare `<modelId>`, or
 * `default` for the session's current selection) plus runtime reasoning
 * effort into the wire ModelSelection; legacy slug shapes migrate to current
 * ids. Undefined means no model can be named — the session selection applies.
 */
export function zcodeResolveModelSelection(input: {
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly config?: ZCodeSchema.SessionConfigState | null;
}): ZcodeResolvedModelSelection | undefined {
  const slug = input.model.trim();
  const parsed = zcodeParseModelSlug(slug);
  const slugProviderId = parsed.providerId === "" ? undefined : parsed.providerId;
  const configProviderId = input.config?.modelSelection?.providerId ?? input.config?.provider;
  const providerId =
    slugProviderId ??
    (configProviderId === undefined || configProviderId === "" ? undefined : configProviderId);
  const configModelId = input.config?.modelSelection?.modelId ?? input.config?.model;
  const modelId =
    slug === "" || slug === ZCODE_DEFAULT_MODEL_SLUG_VALUE
      ? configModelId
      : (parsed.modelId ?? configModelId);
  if (providerId === undefined || modelId === undefined || modelId === "") return undefined;
  if (ZCODE_LEGACY_BACKEND_PROVIDER_IDS.has(providerId)) return undefined;
  const migratedProviderId = zcodeMigrateLegacyProviderId(providerId);
  if (migratedProviderId === undefined) return undefined;
  const resolvedModelId = ZCODE_OFFICIAL_GLM_PROVIDER_PATTERN.test(providerId)
    ? (ZCODE_OFFICIAL_GLM_MODEL_ID_BY_LOWERCASE.get(modelId.toLowerCase()) ?? modelId)
    : modelId;
  const levels = input.config?.thoughtLevels;
  const reasoningLevel =
    input.reasoningEffort?.trim() ||
    parsed.reasoningLevel?.trim() ||
    input.config?.modelSelection?.options?.reasoningLevel ||
    input.config?.thought ||
    (levels !== undefined && levels.length > 0
      ? levels.includes(ZCODE_DEFAULT_REASONING_LEVEL)
        ? ZCODE_DEFAULT_REASONING_LEVEL
        : (levels[0] ?? ZCODE_DEFAULT_REASONING_LEVEL)
      : ZCODE_DEFAULT_REASONING_LEVEL);
  return { providerId: migratedProviderId, modelId: resolvedModelId, reasoningLevel };
}

/**
 * T3 runtime modes onto ZCode submission modes (§4 of the plan):
 * approval-required→build, auto-accept-edits→edit, auto→guarded,
 * full-access→yolo.
 */
export function zcodeSessionModeForRuntimeMode(
  runtimeMode: RuntimeMode,
): ZCodeSchema.SubmissionMode {
  switch (runtimeMode) {
    case "approval-required":
      return "build";
    case "auto-accept-edits":
      return "edit";
    case "auto":
      return "guarded";
    case "full-access":
      return "yolo";
    default: {
      const unreachable: never = runtimeMode;
      return unreachable;
    }
  }
}

/**
 * Full per-input execution state for a sendText/firstInput intent:
 * T3's permission-shaped runtimeMode maps to zcode `mode`; plan mode is the
 * orthogonal `planEnabled` flag (zcode `mode:"plan"` collapses to it).
 */
export function zcodeExecutionStateForRuntimePolicy(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): { readonly mode: ZCodeSchema.SubmissionMode; readonly planEnabled: boolean } {
  return {
    mode: zcodeSessionModeForRuntimeMode(input.runtimeMode),
    planEnabled: input.interactionMode === "plan",
  };
}

/**
 * The session config projection (provider/model/thought or the pinned
 * modelSelection) rendered as a T3 ModelSelection for
 * providerThread.nativeMetadata — how zcode-side model switches surface.
 */
export function zcodeReportedModelSelection(input: {
  readonly config: ZCodeSchema.SessionConfigState | null;
  readonly instanceId: ProviderInstanceId;
}): ModelSelection | undefined {
  const config = input.config;
  if (config === null) return undefined;
  const providerId = config.modelSelection?.providerId ?? config.provider;
  const modelId = config.modelSelection?.modelId ?? config.model;
  // Legacy `builtin:` session configs report their migrated id so the slug
  // matches the registry-published (picker) provider.
  const reportedProviderId =
    providerId === "" ? undefined : (zcodeMigrateLegacyProviderId(providerId) ?? providerId);
  if (reportedProviderId === undefined || modelId === "") return undefined;
  const thought =
    config.modelSelection?.options?.reasoningLevel ??
    (config.thought === "" ? undefined : config.thought);
  return {
    instanceId: input.instanceId,
    model: `${reportedProviderId}/${modelId}`,
    options: thought === undefined ? [] : [{ id: "reasoningEffort", value: thought }],
  };
}

type PermissionOption = ZCodeSchema.PermissionRequestPayload["options"][number];
const isZCodePermissionResponse = Schema.is(ZCodeSchema.ZCodePermissionResponse);

/** optionId upstream assigns the session-scoped always-allow choice. */
export const ZCODE_SESSION_ALLOW_OPTION_ID = "allowSession";
/** Mirror of upstream's deny reason text (permission-options.ts). */
export const ZCODE_PERMISSION_DENIED_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export function zcodePermissionDeniedReason(feedback?: string): string {
  const trimmed = feedback?.trim();
  return trimmed === undefined || trimmed === ""
    ? ZCODE_PERMISSION_DENIED_CONTENT
    : `${ZCODE_PERMISSION_DENIED_CONTENT} To tell you how to proceed, the user said:\n${trimmed}`;
}

/**
 * Pick the advertised option for a T3 approval decision. Session scope prefers
 * the `allowSession` optionId, then `fullAccess` (the only session-scope grant
 * the wire offers when no allowSession option exists); both under-grant to
 * allowOnce rather than over-grant to a project rule.
 */
export function zcodePermissionOptionForDecision(input: {
  readonly options: ReadonlyArray<PermissionOption>;
  readonly fullAccessOption?: ZCodeSchema.PermissionRequestPayload["fullAccessOption"];
  readonly decision: ProviderApprovalDecision;
}): PermissionOption | undefined {
  const byKind = (kind: PermissionOption["kind"]) =>
    input.options.find((option) => option.kind === kind);
  switch (input.decision) {
    case "accept":
      return byKind("allowOnce");
    case "acceptAlways":
      return byKind("allowAlways") ?? byKind("allowOnce");
    case "acceptForSession": {
      const session = input.options.find(
        (option) => option.optionId === ZCODE_SESSION_ALLOW_OPTION_ID,
      );
      if (session !== undefined) return session;
      if (input.fullAccessOption !== undefined) return input.fullAccessOption;
      return byKind("allowOnce");
    }
    case "decline":
      return byKind("deny");
    case "cancel":
      return undefined;
    default: {
      const unreachable: never = input.decision;
      return unreachable;
    }
  }
}

/**
 * Wire options → T3 approval options. `custom` kind entries (workflow Refine)
 * are decline-shaped and would collide on the decision key, so they stay off
 * the card; decline-with-feedback still reaches them via freeText.
 */
export function zcodeApprovalOptions(
  payload: ZCodeSchema.PermissionRequestPayload,
): ReadonlyArray<ProviderApprovalOption> {
  const options = payload.options.flatMap((option): ReadonlyArray<ProviderApprovalOption> => {
    if (option.kind === "custom") return [];
    const decision =
      option.kind === "allowOnce"
        ? ("accept" as const)
        : option.kind === "allowAlways"
          ? option.optionId === ZCODE_SESSION_ALLOW_OPTION_ID
            ? ("acceptForSession" as const)
            : ("acceptAlways" as const)
          : ("decline" as const);
    return [{ decision, label: option.label }];
  });
  if (payload.fullAccessOption !== undefined) {
    options.push({
      decision: "acceptForSession",
      label: payload.fullAccessOption.label,
      warning: "Grants the agent full access for this session.",
    });
  }
  return options;
}

export type ZcodeInteractionAnswer = {
  readonly optionId?: string;
  readonly freeText?: string;
  readonly action?: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
};

/** Build the `resolveInteraction` answer for a pending permission. */
export function zcodePermissionAnswer(input: {
  readonly payload: ZCodeSchema.PermissionRequestPayload;
  readonly decision: ProviderApprovalDecision;
  readonly feedback?: string;
}): ZcodeInteractionAnswer {
  if (input.decision === "cancel") return { action: "cancel" };
  const feedback = input.feedback?.trim();
  // A custom (Refine) option only earns its optionId when the decline carries
  // feedback; a bare decline hits the plain deny option like upstream.
  if (input.decision === "decline" && feedback !== undefined && feedback !== "") {
    const custom = input.payload.options.find((option) => option.kind === "custom");
    if (custom !== undefined) return { optionId: custom.optionId, freeText: feedback };
  }
  const option = zcodePermissionOptionForDecision({
    options: input.payload.options,
    ...(input.payload.fullAccessOption === undefined
      ? {}
      : { fullAccessOption: input.payload.fullAccessOption }),
    decision: input.decision,
  });
  if (option === undefined) {
    return input.decision === "decline" ? { action: "decline" } : { action: "cancel" };
  }
  return {
    optionId: option.optionId,
    ...(feedback === undefined || feedback === "" ? {} : { freeText: feedback }),
  };
}

/**
 * Equivalent response for the legacy `interaction/requestPermission` leg: it
 * races resolveInteraction for the same interaction, so completing it mirrors
 * the command answer. `fullAccess` has no RPC-leg form — resolveFullAccess
 * already resolved the broker as allowOnce by the time these fire.
 */
export function zcodePermissionRpcResponse(input: {
  readonly payload: ZCodeSchema.PermissionRequestPayload;
  readonly decision: ProviderApprovalDecision;
  readonly feedback?: string;
}): ZCodeSchema.ZCodePermissionResponse {
  const option = zcodePermissionOptionForDecision({
    options: input.payload.options,
    ...(input.payload.fullAccessOption === undefined
      ? {}
      : { fullAccessOption: input.payload.fullAccessOption }),
    decision: input.decision,
  });
  if (
    input.decision === "decline" ||
    input.decision === "cancel" ||
    option === undefined ||
    option.optionId === ZCodeSchema.PERMISSION_FULL_ACCESS_OPTION_ID
  ) {
    return {
      decision: "deny",
      reason: zcodePermissionDeniedReason(input.feedback),
    };
  }
  return option.response !== undefined && isZCodePermissionResponse(option.response)
    ? option.response
    : { decision: "allow", reason: "Approved once" };
}

export interface ZcodeProjectedQuestion {
  readonly id: string;
  readonly questionText: string;
  readonly multiSelect: boolean;
}

/**
 * T3 question ids are answer-record keys; zcode answers key on question text.
 * Dedupe headers so two same-header questions keep distinct ids.
 */
export function zcodeProjectedQuestions(
  payload: ZCodeSchema.UserInputRequestPayload,
): ReadonlyArray<ZcodeProjectedQuestion> {
  const questions = payload.questions;
  if (questions === undefined || questions.length === 0) {
    return [{ id: "answer", questionText: payload.prompt, multiSelect: false }];
  }
  const used = new Set<string>();
  return questions.map((question, index) => {
    const base = question.header || `question-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return { id, questionText: question.question, multiSelect: question.multiSelect === true };
  });
}

const answerStrings = (value: unknown): ReadonlyArray<string> => {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );
};

/**
 * Mirror of upstream `buildElicitationResponseContent`: `answers` keys on
 * question text, plus `answer_N` per answered question and `answer` for the
 * single-question compat readers (plan approval, free-form input).
 */
export function zcodeUserInputContent(input: {
  readonly questions: ReadonlyArray<ZcodeProjectedQuestion>;
  readonly answers: Record<string, unknown>;
}): Record<string, unknown> {
  const answers: Record<string, string> = {};
  const content: Record<string, unknown> = {};
  input.questions.forEach((question, index) => {
    const values = answerStrings(input.answers[question.id]);
    if (values.length === 0) return;
    answers[question.questionText] = values.join(", ");
    content[`answer_${index}`] = question.multiSelect ? [...values] : values[0];
  });
  content.answers = answers;
  if (input.questions.length === 1) {
    const question = input.questions[0];
    if (question !== undefined) {
      const values = answerStrings(input.answers[question.id]);
      if (values.length > 0) {
        content.answer = question.multiSelect ? [...values] : values[0];
      }
    }
  }
  return content;
}

/** Build the `resolveInteraction` answer for a pending userInput. */
export function zcodeUserInputAnswer(input: {
  readonly questions: ReadonlyArray<ZcodeProjectedQuestion>;
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: Record<string, unknown>;
}): {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
} {
  if (input.decision === "cancel") return { action: "cancel" };
  if (input.decision === "decline") return { action: "decline" };
  if (input.answers === undefined) return { action: "accept" };
  return {
    action: "accept",
    content: zcodeUserInputContent({ questions: input.questions, answers: input.answers }),
  };
}

const ZCODE_HOOK_REVIEW_TRUSTABLE_STATES: ReadonlySet<
  ZCodeSchema.WorkspaceHookReviewRequestPayload["items"][number]["trustState"]
> = new Set(["pending_trust", "revoked", "stale_digest"]);

/** reviewItemIds a coarse "trust" decision should cover (empty → nothing grantable). */
export function zcodeHookReviewTrustItemIds(
  payload: ZCodeSchema.WorkspaceHookReviewRequestPayload,
): ReadonlyArray<string> {
  const trustable = payload.items
    .filter((item) => ZCODE_HOOK_REVIEW_TRUSTABLE_STATES.has(item.trustState))
    .map((item) => item.reviewItemId);
  return trustable.length > 0 ? trustable : payload.items.map((item) => item.reviewItemId);
}

const ZCODE_HOOK_REVIEW_MAX_LISTED_ITEMS = 8;

/** One-paragraph approval-card prompt for a workspace hook review. */
export function zcodeHookReviewPrompt(
  payload: ZCodeSchema.WorkspaceHookReviewRequestPayload,
): string {
  const listed = payload.items
    .slice(0, ZCODE_HOOK_REVIEW_MAX_LISTED_ITEMS)
    .map((item) => `- ${item.displayName} (${item.event})`);
  const remainder = payload.items.length - listed.length;
  const lines = [
    `ZCode asks to trust ${payload.summary.hookCount} workspace hook(s) from ${payload.workspaceLabel}.`,
    ...listed,
    ...(remainder > 0 ? [`…and ${remainder} more.`] : []),
  ];
  return lines.join("\n");
}
