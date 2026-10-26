/**
 * Draft model for the clanker workflow form. Keys the form does not render
 * stay in each node's `extra` and merge back on write; sub-workflows recurse.
 */
import type {
  ClankerOutputFormat,
  ClankerQaOnFail,
  ClankerOnFail,
  ClankerTemplateEngine,
} from "@t3tools/clanker/format";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { writeClankerWorkflowYaml } from "./clankerWorkflowYaml";

export interface ClankerTextRow {
  readonly rowId: string;
  readonly value: string;
}

export interface ClankerKeyValueRow {
  readonly rowId: string;
  readonly key: string;
  readonly value: string;
}

/** One arbitrary record, edited as JSON text so no value shape is lost. */
export interface ClankerJsonRow {
  readonly rowId: string;
  readonly text: string;
}

export interface ClankerModelDraft {
  readonly rowId: string;
  readonly id: string;
  readonly provider: string;
  readonly harness: string;
  readonly extra: UnknownRecord;
}

export type ClankerPromptKind = "text" | "file";

export interface ClankerPromptDraft {
  readonly rowId: string;
  readonly kind: ClankerPromptKind;
  readonly text: string;
  readonly file: string;
  /** `context` as JSON text; blank means the key is absent. */
  readonly context: string;
  readonly extra: UnknownRecord;
}

export type ClankerHookKind = "cmd" | "fn";

/** Also the draft for `step.run`, which shares the hook object shape. */
export interface ClankerHookDraft {
  readonly rowId: string;
  readonly kind: ClankerHookKind;
  readonly cmd: string;
  readonly fn: string;
  /** `args` as JSON text, written only for the `fn` kind. */
  readonly args: string;
  readonly runtime: string;
  readonly extra: UnknownRecord;
}

export interface ClankerHookPhaseDraft {
  readonly rowId: string;
  readonly phase: string;
  readonly hooks: ReadonlyArray<ClankerHookDraft>;
}

export type ClankerQaCheckKind = "ref" | "inline" | "cmd" | "fn";

export interface ClankerQaCheckDraft {
  readonly rowId: string;
  readonly kind: ClankerQaCheckKind;
  readonly target: string;
  readonly name: string;
  readonly prompt: string;
  readonly cmd: string;
  readonly fn: string;
  readonly args: string;
  readonly runtime: string;
  readonly onFail: ClankerOnFail | "";
  readonly extra: UnknownRecord;
}

export type ClankerEscalateType = "AI" | "HIL";

/** Which shape `escalate[].ref` takes; "none" leaves the key out. */
export type ClankerEscalateRefKind = "none" | "path" | "workflow" | "step";

export interface ClankerEscalateModelDraft {
  readonly id: string;
  readonly provider: string;
  readonly extra: UnknownRecord;
}

export interface ClankerEscalateDraft {
  readonly rowId: string;
  readonly type: ClankerEscalateType;
  readonly prompt: string;
  readonly model: ClankerEscalateModelDraft;
  readonly refKind: ClankerEscalateRefKind;
  readonly refPath: string;
  readonly refWorkflow: ClankerWorkflowDraft | null;
  readonly refStep: ClankerStepDraft | null;
  readonly extra: UnknownRecord;
}

export interface ClankerQaDraft {
  readonly enabled: boolean;
  readonly onFail: ClankerQaOnFail | "";
  readonly checks: ReadonlyArray<ClankerQaCheckDraft>;
  readonly escalate: ReadonlyArray<ClankerEscalateDraft>;
  readonly extra: UnknownRecord;
}

export interface ClankerDefaultsDraft {
  readonly timeout: string;
  readonly retry: string;
  readonly model: string;
  readonly provider: string;
  readonly concurrency: string;
  readonly templateEngine: ClankerTemplateEngine | "";
  readonly outputFormat: ClankerOutputFormat | "";
  readonly hooks: ReadonlyArray<ClankerHookPhaseDraft>;
  readonly qa: ClankerQaDraft;
  readonly extra: UnknownRecord;
}

export interface ClankerStepDraft {
  readonly rowId: string;
  readonly name: string;
  readonly description: string;
  readonly condition: string;
  readonly conditions: ReadonlyArray<ClankerJsonRow>;
  readonly conditionsMode: string;
  readonly agent: string;
  readonly timeout: string;
  readonly retry: string;
  readonly concurrency: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<ClankerTextRow>;
  /** `run`; null means the step has no run block. */
  readonly run: ClankerHookDraft | null;
  /** `workflow` in its string form, used when `subWorkflow` is null. */
  readonly workflowRef: string;
  /** `workflow` in its inline object form; takes precedence when set. */
  readonly subWorkflow: ClankerWorkflowDraft | null;
  readonly env: ReadonlyArray<ClankerKeyValueRow>;
  readonly inputs: ReadonlyArray<ClankerKeyValueRow>;
  readonly outputs: ReadonlyArray<ClankerKeyValueRow>;
  readonly tags: ReadonlyArray<ClankerKeyValueRow>;
  readonly models: ReadonlyArray<ClankerModelDraft>;
  readonly prompts: ReadonlyArray<ClankerPromptDraft>;
  readonly templateEngine: ClankerTemplateEngine | "";
  readonly outputFormat: ClankerOutputFormat | "";
  readonly hooks: ReadonlyArray<ClankerHookPhaseDraft>;
  readonly qa: ClankerQaDraft;
  readonly extra: UnknownRecord;
}

export interface ClankerWorkflowDraft {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly secrets: ReadonlyArray<ClankerTextRow>;
  readonly defaults: ClankerDefaultsDraft;
  readonly steps: ReadonlyArray<ClankerStepDraft>;
  readonly extra: UnknownRecord;
}

export type ClankerDraftParse =
  | { readonly ok: true; readonly draft: ClankerWorkflowDraft }
  | { readonly ok: false; readonly error: string };

/** An unparsable JSON field, keyed by a path the editor can show. */
export interface ClankerDraftIssue {
  readonly path: string;
  readonly message: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

export const CLANKER_TEMPLATE_ENGINE_LABELS: Record<ClankerTemplateEngine, string> = {
  jinja2: "jinja2",
  handlebars: "handlebars",
  none: "none",
};

export const CLANKER_OUTPUT_FORMAT_LABELS: Record<ClankerOutputFormat, string> = {
  json: "JSON",
  markdown: "Markdown",
  text: "Text",
};

export const CLANKER_QA_ON_FAIL_LABELS: Record<ClankerQaOnFail, string> = {
  abort: "Abort the run",
  continue: "Continue anyway",
};

export const CLANKER_CHECK_ON_FAIL_LABELS: Record<ClankerOnFail, string> = {
  rerun: "Rerun the step",
  abort: "Abort the run",
  continue: "Continue anyway",
  escalate: "Escalate",
};

export const CLANKER_HOOK_KIND_LABELS: Record<ClankerHookKind, string> = {
  cmd: "Command",
  fn: "Function",
};

export const CLANKER_PROMPT_KIND_LABELS: Record<ClankerPromptKind, string> = {
  text: "Inline text",
  file: "Prompt file",
};

export const CLANKER_QA_CHECK_LABELS: Record<ClankerQaCheckKind, string> = {
  ref: "Reference",
  inline: "Inline prompt",
  cmd: "Command",
  fn: "Function",
};

export const CLANKER_ESCALATE_TYPE_LABELS: Record<ClankerEscalateType, string> = {
  AI: "AI",
  HIL: "Human in the loop",
};

export const CLANKER_ESCALATE_REF_LABELS: Record<ClankerEscalateRefKind, string> = {
  none: "No handoff",
  path: "Reference by name",
  workflow: "Inline workflow",
  step: "Inline step",
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ClankerShapeCheck = (value: unknown) => boolean;

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

const scalarOrAbsent: ClankerShapeCheck = (value) => value === undefined || isScalar(value);
const stringOrAbsent: ClankerShapeCheck = (value) =>
  value === undefined || typeof value === "string";
const recordOrAbsent: ClankerShapeCheck = (value) => value === undefined || isRecord(value);
const stringListOrAbsent: ClankerShapeCheck = (value) =>
  value === undefined ||
  (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
const recordListOrAbsent: ClankerShapeCheck = (value) =>
  value === undefined || (Array.isArray(value) && value.every(isRecord));
const draftableListOrAbsent: ClankerShapeCheck = (value) =>
  value === undefined ||
  (Array.isArray(value) && value.every((entry) => isRecord(entry) || isScalar(entry)));
const keyValueOrAbsent: ClankerShapeCheck = (value) =>
  value === undefined ||
  (isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"));

function draftableHooks(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entries) => {
    const list = Array.isArray(entries) ? entries : [entries];
    return list.every((entry) =>
      Array.isArray(entry)
        ? entry.every((nested) => isRecord(nested) || isScalar(nested))
        : isRecord(entry) || isScalar(entry),
    );
  });
}
const hooksOrAbsent: ClankerShapeCheck = (value) => value === undefined || draftableHooks(value);

/** A record the nested workflow editor can represent, steps included. */
function draftableWorkflow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const steps = value["steps"];
  return steps === undefined || (Array.isArray(steps) && steps.every(isRecord));
}

const workflowOrAbsent: ClankerShapeCheck = (value) =>
  value === undefined || typeof value === "string" || draftableWorkflow(value);

function draftableEscalateRef(value: unknown): boolean {
  if (value === undefined || typeof value === "string") return true;
  if (!isRecord(value)) return false;
  return "steps" in value ? draftableWorkflow(value) : true;
}

function draftableEscalate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = value["type"];
  if (type !== "AI" && type !== "HIL") return false;
  return recordOrAbsent(value["model"]) && draftableEscalateRef(value["ref"]);
}

const escalateListOrAbsent: ClankerShapeCheck = (value) =>
  value === undefined || (Array.isArray(value) && value.every(draftableEscalate));

function literalShape(labels: Readonly<Record<string, string>>): ClankerShapeCheck {
  return (value) =>
    value === undefined || (typeof value === "string" && Object.hasOwn(labels, value));
}

/**
 * Owned keys whose YAML value matches the shape the form edits. A malformed
 * value stays in `extra` so it round-trips verbatim instead of dropping.
 */
function ownedKeys(
  source: UnknownRecord,
  shapes: Readonly<Record<string, ClankerShapeCheck>>,
): ReadonlyArray<string> {
  return Object.entries(shapes)
    .filter(([key, check]) => check(source[key]))
    .map(([key]) => key);
}

/** String-typed fields only; other scalars stay in `extra`, not stringified. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Number-typed fields show a scalar's text form for the numeric input. */
function asScalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asTextList(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry !== null && entry !== undefined).map(asText);
}

function omit(source: UnknownRecord, owned: ReadonlyArray<string>): UnknownRecord {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (owned.includes(key)) continue;
    rest[key] = value;
  }
  return rest;
}

function literalOf<T extends string>(value: unknown, labels: Readonly<Record<T, string>>): T | "" {
  return typeof value === "string" && Object.hasOwn(labels, value) ? (value as T) : "";
}

function textRows(value: unknown, path: string): ReadonlyArray<ClankerTextRow> {
  return asTextList(value).map((entry, index) => ({ rowId: `${path}/${index}`, value: entry }));
}

function keyValueRows(value: unknown, path: string): ReadonlyArray<ClankerKeyValueRow> {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([key, entry], index) => ({
    rowId: `${path}/${index}`,
    key,
    value: asText(entry),
  }));
}

/** Compact JSON so an arbitrary record fits a one-line editor control. */
function jsonTextOf(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value);
}

function jsonRows(value: unknown, path: string): ReadonlyArray<ClankerJsonRow> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => ({ rowId: `${path}/${index}`, text: jsonTextOf(entry) }));
}

const ROOT_KEY_SHAPES: Record<string, ClankerShapeCheck> = {
  name: stringOrAbsent,
  version: stringOrAbsent,
  description: stringOrAbsent,
  secrets: stringListOrAbsent,
  defaults: recordOrAbsent,
};

const DEFAULTS_KEY_SHAPES: Record<string, ClankerShapeCheck> = {
  timeout: scalarOrAbsent,
  retry: scalarOrAbsent,
  model: stringOrAbsent,
  provider: stringOrAbsent,
  concurrency: scalarOrAbsent,
  template_engine: literalShape(CLANKER_TEMPLATE_ENGINE_LABELS),
  output_format: literalShape(CLANKER_OUTPUT_FORMAT_LABELS),
  hooks: hooksOrAbsent,
  qa: recordOrAbsent,
};

const STEP_KEY_SHAPES: Record<string, ClankerShapeCheck> = {
  name: stringOrAbsent,
  description: stringOrAbsent,
  condition: stringOrAbsent,
  conditions: recordListOrAbsent,
  conditions_mode: stringOrAbsent,
  timeout: scalarOrAbsent,
  retry: scalarOrAbsent,
  concurrency: scalarOrAbsent,
  depends_on: stringListOrAbsent,
  skills: stringListOrAbsent,
  agent: stringOrAbsent,
  run: recordOrAbsent,
  env: keyValueOrAbsent,
  inputs: keyValueOrAbsent,
  outputs: keyValueOrAbsent,
  tags: keyValueOrAbsent,
  models: draftableListOrAbsent,
  prompts: draftableListOrAbsent,
  template_engine: literalShape(CLANKER_TEMPLATE_ENGINE_LABELS),
  output_format: literalShape(CLANKER_OUTPUT_FORMAT_LABELS),
  hooks: hooksOrAbsent,
  qa: recordOrAbsent,
  workflow: workflowOrAbsent,
};

const QA_KEY_SHAPES: Record<string, ClankerShapeCheck> = {
  on_fail: literalShape(CLANKER_QA_ON_FAIL_LABELS),
  checks: recordListOrAbsent,
  escalate: escalateListOrAbsent,
};

const ESCALATE_KEY_SHAPES: Record<string, ClankerShapeCheck> = {
  type: literalShape(CLANKER_ESCALATE_TYPE_LABELS),
  prompt: stringOrAbsent,
  model: recordOrAbsent,
  ref: draftableEscalateRef,
};

const ESCALATE_MODEL_KEY_SHAPES: Record<string, ClankerShapeCheck> = {
  id: stringOrAbsent,
  provider: stringOrAbsent,
};

const MODEL_KEY_SHAPES: Record<string, ClankerShapeCheck> = {
  id: stringOrAbsent,
  provider: stringOrAbsent,
  harness: stringOrAbsent,
};

const PROMPT_KEY_SHAPES: Record<string, ClankerShapeCheck> = {
  text: stringOrAbsent,
  file: stringOrAbsent,
  context: recordOrAbsent,
};

// Keys only one kind writes back are owned only for that kind, so a `cmd`
// hook's stray `fn` round-trips through `extra` instead of dropping.
const HOOK_KEY_SHAPES: Record<ClankerHookKind, Record<string, ClankerShapeCheck>> = {
  cmd: { cmd: stringOrAbsent, runtime: stringOrAbsent },
  fn: { fn: stringOrAbsent, args: recordOrAbsent, runtime: stringOrAbsent },
};

const QA_CHECK_BASE_SHAPES: Record<string, ClankerShapeCheck> = {
  type: literalShape(CLANKER_QA_CHECK_LABELS),
  on_fail: literalShape(CLANKER_CHECK_ON_FAIL_LABELS),
};

const QA_CHECK_KEY_SHAPES: Record<ClankerQaCheckKind, Record<string, ClankerShapeCheck>> = {
  ref: { ...QA_CHECK_BASE_SHAPES, target: stringOrAbsent },
  inline: { ...QA_CHECK_BASE_SHAPES, name: stringOrAbsent, prompt: stringOrAbsent },
  cmd: { ...QA_CHECK_BASE_SHAPES, cmd: stringOrAbsent, runtime: stringOrAbsent },
  fn: { ...QA_CHECK_BASE_SHAPES, fn: stringOrAbsent, args: recordOrAbsent },
};

function hookShapes(kind: ClankerHookKind): Record<string, ClankerShapeCheck> {
  return HOOK_KEY_SHAPES[kind];
}

function qaCheckShapes(kind: ClankerQaCheckKind): Record<string, ClankerShapeCheck> {
  return QA_CHECK_KEY_SHAPES[kind];
}

function modelDrafts(value: unknown, path: string): ReadonlyArray<ClankerModelDraft> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    // A bare scalar reads as the model id, like a bare-string prompt.
    const source = isRecord(entry) ? entry : { id: asScalarText(entry) };
    return {
      rowId: `${path}/${index}`,
      id: asText(source["id"]),
      provider: asText(source["provider"]),
      harness: asText(source["harness"]),
      extra: omit(source, ownedKeys(source, MODEL_KEY_SHAPES)),
    };
  });
}

function promptDrafts(value: unknown, path: string): ReadonlyArray<ClankerPromptDraft> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    // A bare string is not in the schema, but reads as the obvious inline prompt.
    const source = isRecord(entry) ? entry : { text: asScalarText(entry) };
    const kind: ClankerPromptKind = "file" in source && !("text" in source) ? "file" : "text";
    return {
      rowId: `${path}/${index}`,
      kind,
      text: asText(source["text"]),
      file: asText(source["file"]),
      context: isRecord(source["context"]) ? jsonTextOf(source["context"]) : "",
      extra: omit(source, ownedKeys(source, PROMPT_KEY_SHAPES)),
    };
  });
}

function hookDraft(value: unknown, rowId: string): ClankerHookDraft {
  const source = isRecord(value) ? value : { cmd: asScalarText(value) };
  const kind: ClankerHookKind = "fn" in source && !("cmd" in source) ? "fn" : "cmd";
  return {
    rowId,
    kind,
    cmd: asText(source["cmd"]),
    fn: asText(source["fn"]),
    args: kind === "fn" && isRecord(source["args"]) ? jsonTextOf(source["args"]) : "",
    runtime: asText(source["runtime"]),
    extra: omit(source, ownedKeys(source, hookShapes(kind))),
  };
}

/** Nested entry arrays flatten into sibling hooks; both run the phase in order. */
function hookPhaseDrafts(value: unknown, path: string): ReadonlyArray<ClankerHookPhaseDraft> {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([phase, entries], phaseIndex) => {
    const rowId = `${path}/${phaseIndex}`;
    const list = Array.isArray(entries) ? entries : [entries];
    const hooks = list.flatMap((entry, index) =>
      Array.isArray(entry)
        ? entry.map((nested, nestedIndex) => hookDraft(nested, `${rowId}/${index}/${nestedIndex}`))
        : [hookDraft(entry, `${rowId}/${index}`)],
    );
    return { rowId, phase, hooks };
  });
}

function qaCheckDrafts(value: unknown, path: string): ReadonlyArray<ClankerQaCheckDraft> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const source = isRecord(entry) ? entry : {};
    const rawKind = asText(source["type"]);
    const kind: ClankerQaCheckKind =
      rawKind === "inline" || rawKind === "cmd" || rawKind === "fn" ? rawKind : "ref";
    return {
      rowId: `${path}/${index}`,
      kind,
      target: asText(source["target"]),
      name: asText(source["name"]),
      prompt: asText(source["prompt"]),
      cmd: asText(source["cmd"]),
      fn: asText(source["fn"]),
      args: kind === "fn" && isRecord(source["args"]) ? jsonTextOf(source["args"]) : "",
      runtime: kind === "cmd" ? asText(source["runtime"]) : "",
      onFail: literalOf(source["on_fail"], CLANKER_CHECK_ON_FAIL_LABELS),
      extra: omit(source, ownedKeys(source, qaCheckShapes(kind))),
    };
  });
}

function escalateModelDraft(value: unknown): ClankerEscalateModelDraft {
  if (!isRecord(value)) return { id: "", provider: "", extra: {} };
  return {
    id: asText(value["id"]),
    provider: asText(value["provider"]),
    extra: omit(value, ownedKeys(value, ESCALATE_MODEL_KEY_SHAPES)),
  };
}

/** A `ref` record with `steps` is a workflow; any other record is a step. */
function escalateRefKind(ref: unknown): ClankerEscalateRefKind {
  if (typeof ref === "string") return "path";
  if (!isRecord(ref)) return "none";
  return "steps" in ref ? "workflow" : "step";
}

function escalateDrafts(value: unknown, path: string): ReadonlyArray<ClankerEscalateDraft> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const source = isRecord(entry) ? entry : {};
    const rowId = `${path}/${index}`;
    const ref = source["ref"];
    const refKind = escalateRefKind(ref);
    return {
      rowId,
      type: source["type"] === "HIL" ? "HIL" : "AI",
      prompt: asText(source["prompt"]),
      model: escalateModelDraft(source["model"]),
      refKind,
      refPath: refKind === "path" ? asText(ref) : "",
      refWorkflow:
        refKind === "workflow" && isRecord(ref) ? workflowDraft(ref, `${rowId}/ref`) : null,
      refStep: refKind === "step" && isRecord(ref) ? stepDraft(ref, `${rowId}/ref`) : null,
      extra: omit(source, ownedKeys(source, ESCALATE_KEY_SHAPES)),
    };
  });
}

function qaDraft(value: unknown, path: string): ClankerQaDraft {
  if (!isRecord(value)) return emptyClankerQaDraft();
  const owned = ownedKeys(value, QA_KEY_SHAPES);
  return {
    enabled: true,
    onFail: literalOf(value["on_fail"], CLANKER_QA_ON_FAIL_LABELS),
    checks: owned.includes("checks") ? qaCheckDrafts(value["checks"], `${path}/checks`) : [],
    escalate: owned.includes("escalate")
      ? escalateDrafts(value["escalate"], `${path}/escalate`)
      : [],
    extra: omit(value, owned),
  };
}

let rowIdCounter = 0;

/** Unique id for a row the user just added; parsed rows key off their position. */
export function nextClankerRowId(prefix: string): string {
  rowIdCounter += 1;
  return `${prefix}/new-${rowIdCounter}`;
}

function emptyClankerQaDraft(): ClankerQaDraft {
  return { enabled: false, onFail: "", checks: [], escalate: [], extra: {} };
}

function defaultsDraft(value: unknown, path: string): ClankerDefaultsDraft {
  const source = isRecord(value) ? value : {};
  const owned = ownedKeys(source, DEFAULTS_KEY_SHAPES);
  return {
    timeout: asScalarText(source["timeout"]),
    retry: asScalarText(source["retry"]),
    model: asText(source["model"]),
    provider: asText(source["provider"]),
    concurrency: asScalarText(source["concurrency"]),
    templateEngine: literalOf(source["template_engine"], CLANKER_TEMPLATE_ENGINE_LABELS),
    outputFormat: literalOf(source["output_format"], CLANKER_OUTPUT_FORMAT_LABELS),
    hooks: owned.includes("hooks") ? hookPhaseDrafts(source["hooks"], `${path}/hooks`) : [],
    qa: owned.includes("qa") ? qaDraft(source["qa"], `${path}/qa`) : emptyClankerQaDraft(),
    extra: omit(source, owned),
  };
}

function stepDraft(source: UnknownRecord, path: string): ClankerStepDraft {
  const workflow = source["workflow"];
  const run = source["run"];
  // A key whose value the form cannot represent is only kept in `extra`, never
  // drafted too, so it cannot be written twice.
  const owned = ownedKeys(source, STEP_KEY_SHAPES);
  const drafted = <T>(key: string, read: () => ReadonlyArray<T>): ReadonlyArray<T> =>
    owned.includes(key) ? read() : [];
  return {
    rowId: path,
    name: asText(source["name"]),
    description: asText(source["description"]),
    condition: asText(source["condition"]),
    conditions: drafted("conditions", () => jsonRows(source["conditions"], `${path}/conditions`)),
    conditionsMode: asText(source["conditions_mode"]),
    agent: asText(source["agent"]),
    timeout: asScalarText(source["timeout"]),
    retry: asScalarText(source["retry"]),
    concurrency: asScalarText(source["concurrency"]),
    dependsOn: drafted("depends_on", () => asTextList(source["depends_on"])),
    skills: drafted("skills", () => textRows(source["skills"], `${path}/skills`)),
    run: isRecord(run) ? hookDraft(run, `${path}/run`) : null,
    workflowRef: typeof workflow === "string" ? workflow : "",
    subWorkflow: draftableWorkflow(workflow) ? workflowDraft(workflow, `${path}/workflow`) : null,
    env: drafted("env", () => keyValueRows(source["env"], `${path}/env`)),
    inputs: drafted("inputs", () => keyValueRows(source["inputs"], `${path}/inputs`)),
    outputs: drafted("outputs", () => keyValueRows(source["outputs"], `${path}/outputs`)),
    tags: drafted("tags", () => keyValueRows(source["tags"], `${path}/tags`)),
    models: drafted("models", () => modelDrafts(source["models"], `${path}/models`)),
    prompts: drafted("prompts", () => promptDrafts(source["prompts"], `${path}/prompts`)),
    templateEngine: literalOf(source["template_engine"], CLANKER_TEMPLATE_ENGINE_LABELS),
    outputFormat: literalOf(source["output_format"], CLANKER_OUTPUT_FORMAT_LABELS),
    hooks: drafted("hooks", () => hookPhaseDrafts(source["hooks"], `${path}/hooks`)),
    qa: owned.includes("qa") ? qaDraft(source["qa"], `${path}/qa`) : emptyClankerQaDraft(),
    extra: omit(source, owned),
  };
}

/** Shared by the root document and every inline sub-workflow. */
function workflowDraft(value: unknown, path: string): ClankerWorkflowDraft {
  const source = isRecord(value) ? value : {};
  const rawSteps = source["steps"];
  const steps = Array.isArray(rawSteps) ? rawSteps.filter(isRecord) : [];
  const prefix = path === "" ? "" : `${path}/`;
  const owned = ownedKeys(source, ROOT_KEY_SHAPES);
  return {
    name: asText(source["name"]),
    version: asText(source["version"]),
    description: asText(source["description"]),
    secrets: owned.includes("secrets") ? textRows(source["secrets"], `${prefix}secrets`) : [],
    defaults: owned.includes("defaults")
      ? defaultsDraft(source["defaults"], `${prefix}defaults`)
      : emptyClankerDefaultsDraft(),
    steps: steps.map((step, index) => stepDraft(step, `${prefix}steps/${index}`)),
    extra: omit(source, [...owned, "steps"]),
  };
}

/**
 * Builds the form draft from workflow YAML. Fails only when the document
 * cannot be represented as a workflow at all, so the editor can keep the user
 * in YAML mode instead of rewriting a file it misread.
 */
export function parseClankerWorkflowDraft(content: string): ClankerDraftParse {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  if (raw === null || raw === undefined) {
    return { ok: true, draft: emptyClankerWorkflowDraft() };
  }
  if (!isRecord(raw)) return { ok: false, error: "The workflow file must be a YAML object." };
  const rawSteps = raw["steps"];
  if (rawSteps !== undefined && !Array.isArray(rawSteps)) {
    return { ok: false, error: "`steps` must be a list of steps." };
  }
  const rawStepList = (rawSteps ?? []) as ReadonlyArray<unknown>;
  if (rawStepList.some((step) => !isRecord(step))) {
    return { ok: false, error: "Every entry in `steps` must be an object." };
  }
  return { ok: true, draft: workflowDraft(raw, "") };
}

function parseJsonRecord(
  text: string,
):
  | { readonly ok: true; readonly value: UnknownRecord }
  | { readonly ok: false; readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  return { ok: true, value: parsed };
}

/** Inline validation for a JSON object field; blank means the key is absent. */
export function clankerJsonRecordError(text: string): string | null {
  if (text.trim() === "") return null;
  const parsed = parseJsonRecord(text);
  return parsed.ok ? null : parsed.error;
}

/**
 * Unparsable JSON keeps the raw text as the value, so a typo surfaces as a
 * schema error from the server instead of silently dropping what was typed.
 * The editor blocks the YAML sync while any issue stands, so this is a
 * last-resort fallback.
 */
function jsonRecordValue(text: string): unknown {
  if (text.trim() === "") return undefined;
  const parsed = parseJsonRecord(text);
  return parsed.ok ? parsed.value : text;
}

function issuePath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function pushJsonIssue(issues: ClankerDraftIssue[], path: string, text: string): void {
  const message = clankerJsonRecordError(text);
  if (message !== null) issues.push({ path, message });
}

function collectHookPhaseIssues(
  issues: ClankerDraftIssue[],
  phases: ReadonlyArray<ClankerHookPhaseDraft>,
  prefix: string,
): void {
  phases.forEach((phase) => {
    phase.hooks.forEach((hook, index) => {
      if (hook.kind === "fn") {
        pushJsonIssue(issues, `${prefix}.${phase.phase}[${index}].args`, hook.args);
      }
    });
  });
}

function collectQaIssues(issues: ClankerDraftIssue[], qa: ClankerQaDraft, prefix: string): void {
  if (!qa.enabled) return;
  qa.checks.forEach((check, index) => {
    if (check.kind === "fn") pushJsonIssue(issues, `${prefix}.checks[${index}].args`, check.args);
  });
  qa.escalate.forEach((handler, index) => {
    const path = `${prefix}.escalate[${index}].ref`;
    if (handler.refWorkflow !== null) collectWorkflowIssues(issues, handler.refWorkflow, path);
    if (handler.refStep !== null) collectStepIssues(issues, handler.refStep, path);
  });
}

function collectStepIssues(
  issues: ClankerDraftIssue[],
  step: ClankerStepDraft,
  prefix: string,
): void {
  step.prompts.forEach((prompt, index) => {
    pushJsonIssue(issues, `${prefix}.prompts[${index}].context`, prompt.context);
  });
  step.conditions.forEach((row, index) => {
    pushJsonIssue(issues, `${prefix}.conditions[${index}]`, row.text);
  });
  if (step.run !== null && step.run.kind === "fn") {
    pushJsonIssue(issues, `${prefix}.run.args`, step.run.args);
  }
  collectHookPhaseIssues(issues, step.hooks, `${prefix}.hooks`);
  collectQaIssues(issues, step.qa, `${prefix}.qa`);
  if (step.subWorkflow !== null)
    collectWorkflowIssues(issues, step.subWorkflow, `${prefix}.workflow`);
}

function collectWorkflowIssues(
  issues: ClankerDraftIssue[],
  draft: ClankerWorkflowDraft,
  prefix: string,
): void {
  collectHookPhaseIssues(issues, draft.defaults.hooks, issuePath(prefix, "defaults.hooks"));
  collectQaIssues(issues, draft.defaults.qa, issuePath(prefix, "defaults.qa"));
  draft.steps.forEach((step, index) => {
    collectStepIssues(issues, step, issuePath(prefix, `steps[${index}]`));
  });
}

/** Every JSON field the user left unparsable, anywhere in the draft. */
export function clankerDraftJsonIssues(
  draft: ClankerWorkflowDraft,
): ReadonlyArray<ClankerDraftIssue> {
  const issues: ClankerDraftIssue[] = [];
  collectWorkflowIssues(issues, draft, "");
  return issues;
}

function numericOrText(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // Non-numeric input stays a string so the server reports it instead of the
  // form quietly dropping what the user typed.
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : trimmed;
}

function compact(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value === "") continue;
    result[key] = value;
  }
  return result;
}

function textOrUndefined(value: string): string | undefined {
  return value === "" ? undefined : value;
}

function recordOrUndefined(object: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(object).length === 0 ? undefined : object;
}

function keyValueObject(
  rows: ReadonlyArray<ClankerKeyValueRow>,
): Record<string, string> | undefined {
  const named = rows.filter((row) => row.key.trim() !== "");
  if (named.length === 0) return undefined;
  return Object.fromEntries(named.map((row) => [row.key, row.value]));
}

function textListValues(rows: ReadonlyArray<ClankerTextRow>): ReadonlyArray<string> {
  return rows.filter((row) => row.value.trim() !== "").map((row) => row.value);
}

function jsonRowValues(rows: ReadonlyArray<ClankerJsonRow>): ReadonlyArray<unknown> {
  return rows
    .filter((row) => row.text.trim() !== "")
    .map((row) => jsonRecordValue(row.text))
    .filter((value) => value !== undefined);
}

function extraIsEmpty(extra: UnknownRecord): boolean {
  return Object.keys(extra).length === 0;
}

function modelIsBlank(model: ClankerModelDraft): boolean {
  return (
    model.id.trim() === "" &&
    model.provider.trim() === "" &&
    model.harness.trim() === "" &&
    extraIsEmpty(model.extra)
  );
}

function promptIsBlank(prompt: ClankerPromptDraft): boolean {
  return (
    prompt.text.trim() === "" &&
    prompt.file.trim() === "" &&
    prompt.context.trim() === "" &&
    extraIsEmpty(prompt.extra)
  );
}

function hookIsBlank(hook: ClankerHookDraft): boolean {
  return (
    hook.cmd.trim() === "" &&
    hook.fn.trim() === "" &&
    hook.args.trim() === "" &&
    hook.runtime.trim() === "" &&
    extraIsEmpty(hook.extra)
  );
}

function qaCheckIsBlank(check: ClankerQaCheckDraft): boolean {
  return (
    check.target.trim() === "" &&
    check.name.trim() === "" &&
    check.prompt.trim() === "" &&
    check.cmd.trim() === "" &&
    check.fn.trim() === "" &&
    check.args.trim() === "" &&
    check.runtime.trim() === "" &&
    check.onFail === "" &&
    extraIsEmpty(check.extra)
  );
}

function hookObject(hook: ClankerHookDraft): Record<string, unknown> {
  return {
    ...hook.extra,
    ...compact(
      hook.kind === "cmd"
        ? { cmd: hook.cmd, runtime: textOrUndefined(hook.runtime) }
        : {
            fn: hook.fn,
            args: jsonRecordValue(hook.args),
            runtime: textOrUndefined(hook.runtime),
          },
    ),
  };
}

function hooksObject(
  phases: ReadonlyArray<ClankerHookPhaseDraft>,
): Record<string, unknown> | undefined {
  // Same-named phases merge so a duplicate name cannot silently drop hooks.
  const merged: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  for (const phase of phases) {
    if (phase.phase.trim() === "") continue;
    const hooks = phase.hooks.filter((hook) => !hookIsBlank(hook)).map(hookObject);
    if (hooks.length === 0) continue;
    merged[phase.phase] = [...(merged[phase.phase] ?? []), ...hooks];
  }
  return recordOrUndefined(merged);
}

function runObject(run: ClankerHookDraft | null): Record<string, unknown> | undefined {
  if (run === null || hookIsBlank(run)) return undefined;
  return recordOrUndefined(hookObject(run));
}

function qaCheckObject(check: ClankerQaCheckDraft): Record<string, unknown> {
  const fields: Record<string, unknown> =
    check.kind === "ref"
      ? { target: check.target }
      : check.kind === "inline"
        ? { name: check.name, prompt: check.prompt }
        : check.kind === "cmd"
          ? { cmd: check.cmd, runtime: textOrUndefined(check.runtime) }
          : { fn: check.fn, args: jsonRecordValue(check.args) };
  return {
    ...check.extra,
    ...compact({ type: check.kind, ...fields, on_fail: textOrUndefined(check.onFail) }),
  };
}

function escalateModelObject(
  model: ClankerEscalateModelDraft,
): Record<string, unknown> | undefined {
  return recordOrUndefined({
    ...model.extra,
    ...compact({ id: model.id, provider: textOrUndefined(model.provider) }),
  });
}

function escalateRefValue(handler: ClankerEscalateDraft): unknown {
  if (handler.refKind === "path") return textOrUndefined(handler.refPath);
  if (handler.refKind === "workflow" && handler.refWorkflow !== null) {
    return recordOrUndefined(clankerWorkflowDraftToObject(handler.refWorkflow));
  }
  if (handler.refKind === "step" && handler.refStep !== null) {
    return recordOrUndefined(stepObject(handler.refStep));
  }
  return undefined;
}

function escalateObject(handler: ClankerEscalateDraft): Record<string, unknown> {
  return {
    ...handler.extra,
    ...compact({
      type: handler.type,
      prompt: textOrUndefined(handler.prompt),
      model: escalateModelObject(handler.model),
      ref: escalateRefValue(handler),
    }),
  };
}

function qaObject(qa: ClankerQaDraft): Record<string, unknown> | undefined {
  if (!qa.enabled) return undefined;
  return recordOrUndefined({
    ...qa.extra,
    ...compact({
      on_fail: textOrUndefined(qa.onFail),
      checks: qa.checks.filter((check) => !qaCheckIsBlank(check)).map(qaCheckObject),
      escalate: qa.escalate.map(escalateObject),
    }),
  });
}

function defaultsObject(defaults: ClankerDefaultsDraft): Record<string, unknown> | undefined {
  return recordOrUndefined({
    ...defaults.extra,
    ...compact({
      timeout: numericOrText(defaults.timeout),
      retry: numericOrText(defaults.retry),
      concurrency: numericOrText(defaults.concurrency),
      model: textOrUndefined(defaults.model),
      provider: textOrUndefined(defaults.provider),
      template_engine: textOrUndefined(defaults.templateEngine),
      output_format: textOrUndefined(defaults.outputFormat),
      hooks: hooksObject(defaults.hooks),
      qa: qaObject(defaults.qa),
    }),
  });
}

function promptObject(prompt: ClankerPromptDraft): Record<string, unknown> {
  return {
    ...prompt.extra,
    ...compact({
      ...(prompt.kind === "text" ? { text: prompt.text } : { file: prompt.file }),
      context: jsonRecordValue(prompt.context),
    }),
  };
}

function subWorkflowValue(step: ClankerStepDraft): unknown {
  if (step.subWorkflow === null) return textOrUndefined(step.workflowRef);
  return recordOrUndefined(clankerWorkflowDraftToObject(step.subWorkflow));
}

function stepObject(step: ClankerStepDraft): Record<string, unknown> {
  return {
    ...step.extra,
    ...compact({
      name: step.name,
      description: textOrUndefined(step.description),
      condition: textOrUndefined(step.condition),
      conditions: jsonRowValues(step.conditions),
      conditions_mode: textOrUndefined(step.conditionsMode),
      depends_on: step.dependsOn.filter((name) => name.trim() !== ""),
      timeout: numericOrText(step.timeout),
      retry: numericOrText(step.retry),
      concurrency: numericOrText(step.concurrency),
      agent: textOrUndefined(step.agent),
      run: runObject(step.run),
      workflow: subWorkflowValue(step),
      skills: textListValues(step.skills),
      env: keyValueObject(step.env),
      inputs: keyValueObject(step.inputs),
      outputs: keyValueObject(step.outputs),
      tags: keyValueObject(step.tags),
      models: step.models
        .filter((model) => !modelIsBlank(model))
        .map((model) => ({
          ...model.extra,
          ...compact({
            id: model.id,
            provider: textOrUndefined(model.provider),
            harness: textOrUndefined(model.harness),
          }),
        })),
      prompts: step.prompts.filter((prompt) => !promptIsBlank(prompt)).map(promptObject),
      template_engine: textOrUndefined(step.templateEngine),
      output_format: textOrUndefined(step.outputFormat),
      hooks: hooksObject(step.hooks),
      qa: qaObject(step.qa),
    }),
  };
}

export function clankerWorkflowDraftToObject(draft: ClankerWorkflowDraft): Record<string, unknown> {
  return {
    ...draft.extra,
    ...compact({
      name: draft.name,
      version: draft.version,
      description: textOrUndefined(draft.description),
      defaults: defaultsObject(draft.defaults),
      secrets: textListValues(draft.secrets),
      steps: draft.steps.map(stepObject).filter((step) => Object.keys(step).length > 0),
    }),
  };
}

/** Whether the defaults block would still be written to the file. */
export function clankerDefaultsAreSet(defaults: ClankerDefaultsDraft): boolean {
  return defaultsObject(defaults) !== undefined;
}

export function serializeClankerWorkflowDraft(draft: ClankerWorkflowDraft): string {
  // lineWidth 0 keeps prompts and commands on one line instead of folding them.
  return stringifyYaml(clankerWorkflowDraftToObject(draft), { lineWidth: 0 });
}

/**
 * Writes the draft onto the YAML it was parsed from, keeping comments and
 * formatting on nodes the form did not change.
 */
export function writeClankerWorkflowDraft(draft: ClankerWorkflowDraft, baseText: string): string {
  return writeClankerWorkflowYaml(clankerWorkflowDraftToObject(draft), baseText);
}

function emptyClankerWorkflowDraft(): ClankerWorkflowDraft {
  return {
    name: "",
    version: "",
    description: "",
    secrets: [],
    defaults: emptyClankerDefaultsDraft(),
    steps: [],
    extra: {},
  };
}

/** A sub-workflow starts with the one step the format requires. */
export function emptyClankerSubWorkflowDraft(): ClankerWorkflowDraft {
  return { ...emptyClankerWorkflowDraft(), version: "1", steps: [emptyClankerStepDraft()] };
}

export function emptyClankerDefaultsDraft(): ClankerDefaultsDraft {
  return {
    timeout: "",
    retry: "",
    model: "",
    provider: "",
    concurrency: "",
    templateEngine: "",
    outputFormat: "",
    hooks: [],
    qa: emptyClankerQaDraft(),
    extra: {},
  };
}

export function emptyClankerStepDraft(): ClankerStepDraft {
  const path = nextClankerRowId("steps");
  return {
    rowId: path,
    name: "",
    description: "",
    condition: "",
    conditions: [],
    conditionsMode: "",
    agent: "",
    timeout: "",
    retry: "",
    concurrency: "",
    dependsOn: [],
    skills: [],
    run: null,
    workflowRef: "",
    subWorkflow: null,
    env: [],
    inputs: [],
    outputs: [],
    tags: [],
    models: [],
    prompts: [
      { rowId: `${path}/prompts/0`, kind: "text", text: "", file: "", context: "", extra: {} },
    ],
    templateEngine: "",
    outputFormat: "",
    hooks: [],
    qa: emptyClankerQaDraft(),
    extra: {},
  };
}

export function emptyClankerPromptDraft(rowId: string): ClankerPromptDraft {
  return { rowId, kind: "text", text: "", file: "", context: "", extra: {} };
}

export function emptyClankerModelDraft(rowId: string): ClankerModelDraft {
  return { rowId, id: "", provider: "", harness: "", extra: {} };
}

export function emptyClankerHookDraft(rowId: string): ClankerHookDraft {
  return { rowId, kind: "cmd", cmd: "", fn: "", args: "", runtime: "", extra: {} };
}

export function emptyClankerQaCheckDraft(rowId: string): ClankerQaCheckDraft {
  return {
    rowId,
    kind: "cmd",
    target: "",
    name: "",
    prompt: "",
    cmd: "",
    fn: "",
    args: "",
    runtime: "",
    onFail: "",
    extra: {},
  };
}

export function emptyClankerEscalateDraft(rowId: string): ClankerEscalateDraft {
  return {
    rowId,
    type: "AI",
    prompt: "",
    model: { id: "", provider: "", extra: {} },
    refKind: "none",
    refPath: "",
    refWorkflow: null,
    refStep: null,
    extra: {},
  };
}

export function emptyClankerJsonRow(rowId: string): ClankerJsonRow {
  return { rowId, text: "" };
}

/** Step names a step may depend on: its named siblings, in file order. */
export function clankerDependsOnOptions(
  draft: ClankerWorkflowDraft,
  stepIndex: number,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const options: string[] = [];
  draft.steps.forEach((step, index) => {
    if (index === stepIndex) return;
    const name = step.name.trim();
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    options.push(name);
  });
  return options;
}

export function moveClankerStep(
  draft: ClankerWorkflowDraft,
  index: number,
  delta: number,
): ClankerWorkflowDraft {
  const target = index + delta;
  const moving = draft.steps[index];
  const displaced = draft.steps[target];
  if (moving === undefined || displaced === undefined) return draft;
  const steps = [...draft.steps];
  steps[target] = moving;
  steps[index] = displaced;
  return { ...draft, steps };
}
