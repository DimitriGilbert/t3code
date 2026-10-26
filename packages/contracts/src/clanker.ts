import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** Project-relative path to a `.yml`/`.yaml`/`.json` clanker workflow file. */
export const ClankerWorkflowPath = TrimmedNonEmptyString.pipe(Schema.brand("ClankerWorkflowPath"));
export type ClankerWorkflowPath = typeof ClankerWorkflowPath.Type;

export const ClankerDiagnosticSeverity = Schema.Literals(["error", "warning", "unsupported"]);
export type ClankerDiagnosticSeverity = typeof ClankerDiagnosticSeverity.Type;

export const ClankerDiagnostic = Schema.Struct({
  severity: ClankerDiagnosticSeverity,
  message: Schema.String,
  path: Schema.optional(Schema.String),
});
export type ClankerDiagnostic = typeof ClankerDiagnostic.Type;

export const ClankerWorkflowSummary = Schema.Struct({
  path: ClankerWorkflowPath,
  name: TrimmedNonEmptyString,
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  stepCount: NonNegativeInt,
  modifiedAt: Schema.NullOr(IsoDateTime),
  /** Count of diagnostics with severity "error" or "unsupported". */
  issueCount: NonNegativeInt,
});
export type ClankerWorkflowSummary = typeof ClankerWorkflowSummary.Type;

export const ClankerWorkflowDocument = Schema.Struct({
  path: ClankerWorkflowPath,
  content: Schema.String,
  diagnostics: ForwardCompatibleArray(ClankerDiagnostic),
  waves: Schema.Array(Schema.Array(Schema.String)),
});
export type ClankerWorkflowDocument = typeof ClankerWorkflowDocument.Type;

export class ClankerWorkflowNotFoundError extends Schema.TaggedError<ClankerWorkflowNotFoundError>()(
  "ClankerWorkflowNotFoundError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Clanker workflow '${this.path}' does not exist.`;
  }
}

export class ClankerWorkflowOutsideRootError extends Schema.TaggedError<ClankerWorkflowOutsideRootError>()(
  "ClankerWorkflowOutsideRootError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Clanker workflow path '${this.path}' resolves outside the project root.`;
  }
}

export class ClankerWorkflowInvalidNameError extends Schema.TaggedError<ClankerWorkflowInvalidNameError>()(
  "ClankerWorkflowInvalidNameError",
  { name: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Invalid clanker workflow name '${this.name}': ${this.detail}.`;
  }
}

export class ClankerWorkflowReadError extends Schema.TaggedError<ClankerWorkflowReadError>()(
  "ClankerWorkflowReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read clanker workflow '${this.path}'.`;
  }
}

export class ClankerWorkflowWriteError extends Schema.TaggedError<ClankerWorkflowWriteError>()(
  "ClankerWorkflowWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to write clanker workflow '${this.path}'.`;
  }
}

export const ClankerWorkflowError = Schema.Union([
  ClankerWorkflowNotFoundError,
  ClankerWorkflowOutsideRootError,
  ClankerWorkflowInvalidNameError,
  ClankerWorkflowReadError,
  ClankerWorkflowWriteError,
]);
export type ClankerWorkflowError = typeof ClankerWorkflowError.Type;

export const ClankerWorkflowListInput = Schema.Struct({
  projectId: ProjectId,
});
export type ClankerWorkflowListInput = typeof ClankerWorkflowListInput.Type;

export const ClankerWorkflowListResult = Schema.Struct({
  workflows: Schema.Array(ClankerWorkflowSummary),
});
export type ClankerWorkflowListResult = typeof ClankerWorkflowListResult.Type;

export const ClankerWorkflowGetInput = Schema.Struct({
  projectId: ProjectId,
  path: ClankerWorkflowPath,
});
export type ClankerWorkflowGetInput = typeof ClankerWorkflowGetInput.Type;

export const ClankerWorkflowCreateInput = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  content: Schema.optional(Schema.String),
});
export type ClankerWorkflowCreateInput = typeof ClankerWorkflowCreateInput.Type;

export const ClankerWorkflowUpdateInput = Schema.Struct({
  projectId: ProjectId,
  path: ClankerWorkflowPath,
  content: Schema.String,
});
export type ClankerWorkflowUpdateInput = typeof ClankerWorkflowUpdateInput.Type;

export const ClankerWorkflowDeleteInput = Schema.Struct({
  projectId: ProjectId,
  path: ClankerWorkflowPath,
});
export type ClankerWorkflowDeleteInput = typeof ClankerWorkflowDeleteInput.Type;

export const ClankerWorkflowValidateInput = Schema.Struct({
  projectId: ProjectId,
  content: Schema.String,
});
export type ClankerWorkflowValidateInput = typeof ClankerWorkflowValidateInput.Type;

export const ClankerWorkflowValidateResult = Schema.Struct({
  diagnostics: ForwardCompatibleArray(ClankerDiagnostic),
});
export type ClankerWorkflowValidateResult = typeof ClankerWorkflowValidateResult.Type;

// Run-state field shapes are redeclared from `packages/clanker/src/runState.ts`
// so contracts stays free of an @t3tools/clanker dependency.

export const ClankerRunId = TrimmedNonEmptyString.pipe(Schema.brand("ClankerRunId"));
export type ClankerRunId = typeof ClankerRunId.Type;

export const ClankerRunStatus = Schema.Literals(["running", "failed", "completed", "cancelled"]);
export type ClankerRunStatus = typeof ClankerRunStatus.Type;

export const ClankerStepStatus = Schema.Literals([
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
]);
export type ClankerStepStatus = typeof ClankerStepStatus.Type;

export const ClankerStepResponse = Schema.Struct({
  prompt_index: Schema.Int,
  model_id: Schema.String,
  response: Schema.String,
});
export type ClankerStepResponse = typeof ClankerStepResponse.Type;

const ClankerStringMap = Schema.Record(Schema.String, Schema.String);

export const ClankerStepState = Schema.Struct({
  status: ClankerStepStatus,
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  retryCount: NonNegativeInt,
  responses: Schema.Array(ClankerStepResponse),
  declaredOutputs: ClankerStringMap,
  outputs: ClankerStringMap,
  error: Schema.optional(Schema.String),
});
export type ClankerStepState = typeof ClankerStepState.Type;

export const ClankerRunSummary = Schema.Struct({
  runId: ClankerRunId,
  workflowName: TrimmedNonEmptyString,
  workflowPath: Schema.optional(ClankerWorkflowPath),
  status: ClankerRunStatus,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  stepTotal: NonNegativeInt,
  passedSteps: NonNegativeInt,
  failedSteps: NonNegativeInt,
  /** Names of the steps currently executing, so a list row can name them without fetching the detail. */
  runningStepNames: Schema.Array(Schema.String),
});
export type ClankerRunSummary = typeof ClankerRunSummary.Type;

export const ClankerStepThread = Schema.Struct({
  stepName: Schema.String,
  threadId: Schema.optional(ThreadId),
});
export type ClankerStepThread = typeof ClankerStepThread.Type;

/** `ClankerPersistedRunState`-shaped fields plus the per-step thread mapping. */
export const ClankerRunDetail = Schema.Struct({
  runId: ClankerRunId,
  projectId: ProjectId,
  workflowName: Schema.String,
  workflowPath: Schema.optional(ClankerWorkflowPath),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  status: ClankerRunStatus,
  steps: Schema.Record(Schema.String, ClankerStepState),
  stepThreads: Schema.Array(ClankerStepThread),
});
export type ClankerRunDetail = typeof ClankerRunDetail.Type;

export class ClankerRunNotFoundError extends Schema.TaggedError<ClankerRunNotFoundError>()(
  "ClankerRunNotFoundError",
  { runId: Schema.String },
) {
  override get message(): string {
    return `Clanker run '${this.runId}' does not exist.`;
  }
}

export class ClankerRunAlreadyRunningError extends Schema.TaggedError<ClankerRunAlreadyRunningError>()(
  "ClankerRunAlreadyRunningError",
  { workflowPath: Schema.String, runId: Schema.String },
) {
  override get message(): string {
    return `Clanker workflow '${this.workflowPath}' already has a running run '${this.runId}'.`;
  }
}

export class ClankerRunInvalidStateError extends Schema.TaggedError<ClankerRunInvalidStateError>()(
  "ClankerRunInvalidStateError",
  { runId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Clanker run '${this.runId}' is in an invalid state: ${this.detail}.`;
  }
}

export class ClankerRunIoError extends Schema.TaggedError<ClankerRunIoError>()(
  "ClankerRunIoError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Clanker run storage failed for '${this.path}'.`;
  }
}

export const ClankerRunError = Schema.Union([
  ClankerRunNotFoundError,
  ClankerRunAlreadyRunningError,
  ClankerRunInvalidStateError,
  ClankerRunIoError,
]);
export type ClankerRunError = typeof ClankerRunError.Type;

export const ClankerRunListInput = Schema.Struct({
  projectId: ProjectId,
});
export type ClankerRunListInput = typeof ClankerRunListInput.Type;

export const ClankerRunListResult = Schema.Struct({
  runs: Schema.Array(ClankerRunSummary),
});
export type ClankerRunListResult = typeof ClankerRunListResult.Type;

export const ClankerRunGetInput = Schema.Struct({
  projectId: ProjectId,
  runId: ClankerRunId,
});
export type ClankerRunGetInput = typeof ClankerRunGetInput.Type;

export const ClankerRunStartInput = Schema.Struct({
  projectId: ProjectId,
  workflowPath: ClankerWorkflowPath,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  startFromStep: Schema.optional(TrimmedNonEmptyString),
  /**
   * Modes for the step threads the run launches. Absent resolves to the
   * project's effective defaults server-side; callers that launch on an
   * agent's behalf (MCP) pass modes already capped to that caller's limits.
   */
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ClankerRunStartInput = typeof ClankerRunStartInput.Type;

export const ClankerRunStartResult = Schema.Struct({
  runId: ClankerRunId,
});
export type ClankerRunStartResult = typeof ClankerRunStartResult.Type;

export const ClankerRunCancelInput = Schema.Struct({
  projectId: ProjectId,
  runId: ClankerRunId,
});
export type ClankerRunCancelInput = typeof ClankerRunCancelInput.Type;

export const ClankerRunResumeInput = Schema.Struct({
  projectId: ProjectId,
  runId: ClankerRunId,
  startFromStep: Schema.optional(TrimmedNonEmptyString),
  /** Same resolution as {@link ClankerRunStartInput}'s mode fields. */
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ClankerRunResumeInput = typeof ClankerRunResumeInput.Type;

export const ClankerRunResumeResult = Schema.Struct({
  runId: ClankerRunId,
});
export type ClankerRunResumeResult = typeof ClankerRunResumeResult.Type;
