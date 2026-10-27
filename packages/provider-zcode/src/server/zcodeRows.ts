/**
 * Pure ZCode v4 row → orchestration projection helpers (row kinds, statuses,
 * tool-call item kinds, timeline text, permission answers). No Effect code.
 *
 * @module provider-zcode/server/zcodeRows
 */
import type {
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderRequestKind,
  RuntimeMode,
} from "@t3tools/contracts";
import type * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";

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

export interface ZcodeResolvedModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevel: string;
}

/**
 * Resolve a T3 model slug (`<providerId>/<modelId>`, a bare `<modelId>`, or
 * `default` for the session's current selection) plus runtime reasoning
 * effort into the wire ModelSelection. Returns undefined when no model can be
 * named — the session's current selection then applies.
 */
export function zcodeResolveModelSelection(input: {
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly config?: ZCodeSchema.SessionConfigState | null;
}): ZcodeResolvedModelSelection | undefined {
  const slug = input.model.trim();
  const separator = slug.indexOf("/");
  const configProviderId = input.config?.modelSelection?.providerId ?? input.config?.provider;
  const providerId =
    (separator > 0 ? slug.slice(0, separator) : undefined) ??
    (configProviderId === undefined || configProviderId === "" ? undefined : configProviderId);
  const modelId =
    separator > 0
      ? slug.slice(separator + 1)
      : slug === "" || slug === ZCODE_DEFAULT_MODEL_SLUG_VALUE
        ? (input.config?.modelSelection?.modelId ?? input.config?.model)
        : slug;
  if (providerId === undefined || modelId === undefined || modelId === "") return undefined;
  const levels = input.config?.thoughtLevels;
  const reasoningLevel =
    input.reasoningEffort?.trim() ||
    input.config?.modelSelection?.options?.reasoningLevel ||
    input.config?.thought ||
    (levels !== undefined && levels.length > 0
      ? levels.includes(ZCODE_DEFAULT_REASONING_LEVEL)
        ? ZCODE_DEFAULT_REASONING_LEVEL
        : (levels[0] ?? ZCODE_DEFAULT_REASONING_LEVEL)
      : ZCODE_DEFAULT_REASONING_LEVEL);
  return { providerId, modelId, reasoningLevel };
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

type PermissionOption = ZCodeSchema.PermissionRequestPayload["options"][number];

/** Pick the advertised option for a T3 approval decision (P4 refines). */
export function zcodePermissionOptionForDecision(input: {
  readonly options: ReadonlyArray<PermissionOption>;
  readonly fullAccessOption?: ZCodeSchema.PermissionRequestPayload["fullAccessOption"];
  readonly decision: ProviderApprovalDecision;
}): PermissionOption | undefined {
  const wanted =
    input.decision === "accept"
      ? "allowOnce"
      : input.decision === "acceptAlways" || input.decision === "acceptForSession"
        ? "allowAlways"
        : "deny";
  const match = input.options.find((option) => option.kind === wanted);
  if (match !== undefined) return match;
  if (
    (input.decision === "acceptAlways" || input.decision === "acceptForSession") &&
    input.fullAccessOption !== undefined
  ) {
    return {
      optionId: input.fullAccessOption.optionId,
      label: input.fullAccessOption.label,
      kind: input.fullAccessOption.kind,
      ...(input.fullAccessOption.response === undefined
        ? {}
        : { response: input.fullAccessOption.response }),
    };
  }
  return undefined;
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
  if (input.decision === "cancel") {
    return { action: "cancel" };
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
    ...(input.feedback === undefined || input.feedback === "" ? {} : { freeText: input.feedback }),
  };
}
