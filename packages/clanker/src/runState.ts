/**
 * Schemas for the Clanker runner's persisted run artifacts — `state.json`
 * (`PersistedRunState`) and `result.json` (`RunResult`). Field names and
 * optionality mirror `apps/cli/src/runner/run-state.ts` and `types.ts` in the
 * Clanker repo so existing run directories decode as-is.
 */
import * as Schema from "effect/Schema";

export const ClankerStepStatus = Schema.Literals([
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
]);
export type ClankerStepStatus = typeof ClankerStepStatus.Type;

export const ClankerRunStatus = Schema.Literals(["running", "failed", "completed", "cancelled"]);
export type ClankerRunStatus = typeof ClankerRunStatus.Type;

export const ClankerStepResponse = Schema.Struct({
  prompt_index: Schema.Int,
  model_id: Schema.String,
  response: Schema.String,
});
export type ClankerStepResponse = typeof ClankerStepResponse.Type;

const StringMap = Schema.Record(Schema.String, Schema.String);
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ClankerStepState = Schema.Struct({
  status: ClankerStepStatus,
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  retryCount: NonNegativeInt,
  responses: Schema.Array(ClankerStepResponse),
  declaredOutputs: StringMap,
  outputs: StringMap,
  error: Schema.optional(Schema.String),
});
export type ClankerStepState = typeof ClankerStepState.Type;

export const ClankerPersistedRunState = Schema.Struct({
  runId: Schema.String,
  workflowName: Schema.String,
  workflowPath: Schema.optional(Schema.String),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  status: ClankerRunStatus,
  steps: Schema.Record(Schema.String, ClankerStepState),
});
export type ClankerPersistedRunState = typeof ClankerPersistedRunState.Type;

export const ClankerStepResult = Schema.Struct({
  stepName: Schema.String,
  success: Schema.Boolean,
  skipped: Schema.Boolean,
  durationMs: Schema.Number,
  responses: Schema.Array(ClankerStepResponse),
  declaredOutputs: StringMap,
  outputs: StringMap,
  error: Schema.optional(Schema.String),
  retryCount: NonNegativeInt,
});
export type ClankerStepResult = typeof ClankerStepResult.Type;

export const ClankerRunResult = Schema.Struct({
  runId: Schema.optional(Schema.String),
  success: Schema.Boolean,
  cancelled: Schema.Boolean,
  name: Schema.String,
  steps: Schema.Array(ClankerStepResult),
  validation: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
export type ClankerRunResult = typeof ClankerRunResult.Type;
