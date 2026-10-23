/**
 * Effect Schema port of the Clanker workflow file format
 * (`workflow.schema.json`), including the zod-dialect step keys the real
 * Clanker parser accepts (`conditions`, `conditions_mode`, `run`).
 */
import * as Schema from "effect/Schema";

export const ClankerTemplateEngine = Schema.Literals(["jinja2", "handlebars", "none"]);
export type ClankerTemplateEngine = typeof ClankerTemplateEngine.Type;

export const ClankerOutputFormat = Schema.Literals(["json", "markdown", "text"]);
export type ClankerOutputFormat = typeof ClankerOutputFormat.Type;

/** What to do when a QA check fails. */
export const ClankerOnFail = Schema.Literals(["rerun", "abort", "continue", "escalate"]);
export type ClankerOnFail = typeof ClankerOnFail.Type;

/** Step-level default QA failure policy; `rerun`/`escalate` are per-check only. */
export const ClankerQaOnFail = Schema.Literals(["abort", "continue"]);
export type ClankerQaOnFail = typeof ClankerQaOnFail.Type;

const StringRecord = Schema.Record(Schema.String, Schema.String);
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export const ClankerCmdHook = Schema.Struct({
  cmd: Schema.String,
  runtime: Schema.optional(Schema.String),
});
export type ClankerCmdHook = typeof ClankerCmdHook.Type;

export const ClankerFnHook = Schema.Struct({
  fn: Schema.String,
  args: Schema.optional(UnknownRecord),
  runtime: Schema.optional(Schema.String),
});
export type ClankerFnHook = typeof ClankerFnHook.Type;

export const ClankerHookObject = Schema.Union([ClankerCmdHook, ClankerFnHook]);
export type ClankerHookObject = typeof ClankerHookObject.Type;

export const ClankerHookEntry = Schema.Union([ClankerHookObject, Schema.Array(ClankerHookObject)]);
export type ClankerHookEntry = typeof ClankerHookEntry.Type;

/**
 * `run` shares the hook object shape — `{cmd, runtime?}` or
 * `{fn, args?, runtime?}` — matching Clanker's `RunSchema`. Unlike hooks it
 * is never a bare string and never a list.
 */
export const ClankerRunObject = ClankerHookObject;
export type ClankerRunObject = ClankerHookObject;

/** Phase name ("before", "after", "on_error", or custom) -> hook entries. */
export const ClankerHooks = Schema.Record(Schema.String, Schema.Array(ClankerHookEntry));
export type ClankerHooks = typeof ClankerHooks.Type;

export const ClankerInlinePrompt = Schema.Struct({
  text: Schema.String,
  context: Schema.optional(UnknownRecord),
});
export type ClankerInlinePrompt = typeof ClankerInlinePrompt.Type;

export const ClankerFilePrompt = Schema.Struct({
  file: Schema.String,
  context: Schema.optional(UnknownRecord),
});
export type ClankerFilePrompt = typeof ClankerFilePrompt.Type;

export const ClankerPrompt = Schema.Union([ClankerInlinePrompt, ClankerFilePrompt]);
export type ClankerPrompt = typeof ClankerPrompt.Type;

export const ClankerModel = Schema.Struct({
  id: Schema.String,
  provider: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
});
export type ClankerModel = typeof ClankerModel.Type;

export const ClankerRefCheck = Schema.Struct({
  type: Schema.Literal("ref"),
  target: Schema.String,
  on_fail: Schema.optional(ClankerOnFail),
});
export type ClankerRefCheck = typeof ClankerRefCheck.Type;

export const ClankerInlineCheck = Schema.Struct({
  type: Schema.Literal("inline"),
  name: Schema.String,
  prompt: Schema.String,
  on_fail: Schema.optional(ClankerOnFail),
});
export type ClankerInlineCheck = typeof ClankerInlineCheck.Type;

export const ClankerCmdCheck = Schema.Struct({
  type: Schema.Literal("cmd"),
  cmd: Schema.String,
  runtime: Schema.optional(Schema.String),
  on_fail: Schema.optional(ClankerOnFail),
});
export type ClankerCmdCheck = typeof ClankerCmdCheck.Type;

export const ClankerFnCheck = Schema.Struct({
  type: Schema.Literal("fn"),
  fn: Schema.String,
  args: Schema.optional(UnknownRecord),
  on_fail: Schema.optional(ClankerOnFail),
});
export type ClankerFnCheck = typeof ClankerFnCheck.Type;

export const ClankerQaCheck = Schema.Union([
  ClankerRefCheck,
  ClankerInlineCheck,
  ClankerCmdCheck,
  ClankerFnCheck,
]);
export type ClankerQaCheck = typeof ClankerQaCheck.Type;

export const ClankerEscalateModel = Schema.Struct({
  id: Schema.String,
  provider: Schema.optional(Schema.String),
});
export type ClankerEscalateModel = typeof ClankerEscalateModel.Type;

export interface ClankerWorkflow {
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly defaults?: ClankerDefaults | undefined;
  readonly secrets?: ReadonlyArray<string> | undefined;
  readonly steps: ReadonlyArray<ClankerStep>;
}

export interface ClankerStep {
  readonly name: string;
  readonly description?: string | undefined;
  readonly condition?: string | undefined;
  readonly conditions?: ReadonlyArray<Readonly<Record<string, unknown>>> | undefined;
  readonly conditions_mode?: string | undefined;
  readonly timeout?: number | undefined;
  readonly retry?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly depends_on?: ReadonlyArray<string> | undefined;
  readonly run?: ClankerRunObject | undefined;
  readonly workflow?: string | ClankerWorkflow | undefined;
  readonly skills?: ReadonlyArray<string> | undefined;
  readonly agent?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly inputs?: Readonly<Record<string, string>> | undefined;
  readonly outputs?: Readonly<Record<string, string>> | undefined;
  readonly models?: ReadonlyArray<ClankerModel> | undefined;
  readonly prompts?: ReadonlyArray<ClankerPrompt> | undefined;
  readonly template_engine?: ClankerTemplateEngine | undefined;
  readonly output_format?: ClankerOutputFormat | undefined;
  readonly hooks?: ClankerHooks | undefined;
  readonly qa?: ClankerQa | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

// `step.workflow` and `escalate.ref` recurse into workflow/step; the lazy
// suspends only resolve once the schemas below finish initializing.
const ClankerStepRef: Schema.Codec<ClankerStep> = Schema.suspend(() => ClankerStep);
const ClankerWorkflowRef: Schema.Codec<ClankerWorkflow> = Schema.suspend(() => ClankerWorkflow);

export const ClankerEscalateHandler = Schema.Struct({
  type: Schema.Literals(["AI", "HIL"]),
  prompt: Schema.optional(Schema.String),
  model: Schema.optional(ClankerEscalateModel),
  ref: Schema.optional(Schema.Union([Schema.String, ClankerWorkflowRef, ClankerStepRef])),
});
export type ClankerEscalateHandler = typeof ClankerEscalateHandler.Type;

export const ClankerQa = Schema.Struct({
  on_fail: Schema.optional(ClankerQaOnFail),
  checks: Schema.optional(Schema.Array(ClankerQaCheck)),
  escalate: Schema.optional(Schema.Array(ClankerEscalateHandler)),
});
export type ClankerQa = typeof ClankerQa.Type;

export const ClankerDefaults = Schema.Struct({
  timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  retry: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  model: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  template_engine: Schema.optional(ClankerTemplateEngine),
  output_format: Schema.optional(ClankerOutputFormat),
  concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  hooks: Schema.optional(ClankerHooks),
  qa: Schema.optional(ClankerQa),
});
export type ClankerDefaults = typeof ClankerDefaults.Type;

export const ClankerStep = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  condition: Schema.optional(Schema.String),
  // Zod-dialect keys the real Clanker parser allows; decoded loosely so real
  // files parse, then reported `unsupported` by parseClankerWorkflow.
  conditions: Schema.optional(Schema.Array(UnknownRecord)),
  conditions_mode: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  retry: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  depends_on: Schema.optional(Schema.Array(Schema.String)),
  run: Schema.optional(ClankerRunObject),
  workflow: Schema.optional(Schema.Union([Schema.String, ClankerWorkflowRef])),
  skills: Schema.optional(Schema.Array(Schema.String)),
  agent: Schema.optional(Schema.String),
  env: Schema.optional(StringRecord),
  inputs: Schema.optional(StringRecord),
  outputs: Schema.optional(StringRecord),
  models: Schema.optional(Schema.Array(ClankerModel).check(Schema.isMinLength(1))),
  prompts: Schema.optional(Schema.Array(ClankerPrompt).check(Schema.isMinLength(1))),
  template_engine: Schema.optional(ClankerTemplateEngine),
  output_format: Schema.optional(ClankerOutputFormat),
  hooks: Schema.optional(ClankerHooks),
  qa: Schema.optional(ClankerQa),
  tags: Schema.optional(StringRecord),
});

export const ClankerWorkflow = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  description: Schema.optional(Schema.String),
  defaults: Schema.optional(ClankerDefaults),
  secrets: Schema.optional(Schema.Array(Schema.String)),
  steps: Schema.Array(ClankerStep).check(Schema.isMinLength(1)),
});
