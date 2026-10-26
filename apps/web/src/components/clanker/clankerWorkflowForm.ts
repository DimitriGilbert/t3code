/**
 * Draft model behind the structured clanker workflow editor. Every field the
 * form does not render is kept per node in `extra` and merged back on
 * serialization, so editing a workflow never drops keys the form ignores.
 */
import type {
  ClankerOutputFormat,
  ClankerQaOnFail,
  ClankerOnFail,
  ClankerTemplateEngine,
} from "@t3tools/clanker/format";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ClankerTextRow {
  readonly rowId: string;
  readonly value: string;
}

export interface ClankerKeyValueRow {
  readonly rowId: string;
  readonly key: string;
  readonly value: string;
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
  /** `context` and any other key the form does not render. */
  readonly extra: UnknownRecord;
}

export type ClankerHookKind = "cmd" | "fn";

export interface ClankerHookDraft {
  readonly rowId: string;
  readonly kind: ClankerHookKind;
  readonly cmd: string;
  readonly fn: string;
  readonly runtime: string;
  /** `args` and any other key the form does not render. */
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
  readonly runtime: string;
  readonly onFail: ClankerOnFail | "";
  readonly extra: UnknownRecord;
}

export interface ClankerQaDraft {
  readonly enabled: boolean;
  readonly onFail: ClankerQaOnFail | "";
  readonly checks: ReadonlyArray<ClankerQaCheckDraft>;
  /** `escalate` and any other key the form does not render. */
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
  readonly agent: string;
  readonly timeout: string;
  readonly retry: string;
  readonly concurrency: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<ClankerTextRow>;
  /** `workflow` in its string form; an inline sub-workflow lands in `extra`. */
  readonly workflowRef: string;
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
  /** `run`, `conditions`, inline sub-workflows, and unknown keys. */
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

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
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

function modelDrafts(value: unknown, path: string): ReadonlyArray<ClankerModelDraft> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const source = isRecord(entry) ? entry : {};
    return {
      rowId: `${path}/${index}`,
      id: asText(source["id"]),
      provider: asText(source["provider"]),
      harness: asText(source["harness"]),
      extra: omit(source, ["id", "provider", "harness"]),
    };
  });
}

function promptDrafts(value: unknown, path: string): ReadonlyArray<ClankerPromptDraft> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    // A bare string is not in the schema, but reads as the obvious inline prompt.
    const source = isRecord(entry) ? entry : { text: asText(entry) };
    const kind: ClankerPromptKind = "file" in source && !("text" in source) ? "file" : "text";
    return {
      rowId: `${path}/${index}`,
      kind,
      text: asText(source["text"]),
      file: asText(source["file"]),
      extra: omit(source, ["text", "file"]),
    };
  });
}

function hookDraft(value: unknown, rowId: string): ClankerHookDraft {
  const source = isRecord(value) ? value : { cmd: asText(value) };
  const kind: ClankerHookKind = "fn" in source && !("cmd" in source) ? "fn" : "cmd";
  return {
    rowId,
    kind,
    cmd: asText(source["cmd"]),
    fn: asText(source["fn"]),
    runtime: asText(source["runtime"]),
    extra: omit(source, ["cmd", "fn", "runtime"]),
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
      runtime: asText(source["runtime"]),
      onFail: literalOf(source["on_fail"], CLANKER_CHECK_ON_FAIL_LABELS),
      extra: omit(source, ["type", "target", "name", "prompt", "cmd", "fn", "runtime", "on_fail"]),
    };
  });
}

function qaDraft(value: unknown, path: string): ClankerQaDraft {
  if (!isRecord(value)) return emptyClankerQaDraft();
  return {
    enabled: true,
    onFail: literalOf(value["on_fail"], CLANKER_QA_ON_FAIL_LABELS),
    checks: qaCheckDrafts(value["checks"], `${path}/checks`),
    extra: omit(value, ["on_fail", "checks"]),
  };
}

let rowIdCounter = 0;

/** Unique id for a row the user just added; parsed rows key off their position. */
export function nextClankerRowId(prefix: string): string {
  rowIdCounter += 1;
  return `${prefix}/new-${rowIdCounter}`;
}

export function emptyClankerQaDraft(): ClankerQaDraft {
  return { enabled: false, onFail: "", checks: [], extra: {} };
}

function defaultsDraft(value: unknown, path: string): ClankerDefaultsDraft {
  const source = isRecord(value) ? value : {};
  return {
    timeout: asText(source["timeout"]),
    retry: asText(source["retry"]),
    model: asText(source["model"]),
    provider: asText(source["provider"]),
    concurrency: asText(source["concurrency"]),
    templateEngine: literalOf(source["template_engine"], CLANKER_TEMPLATE_ENGINE_LABELS),
    outputFormat: literalOf(source["output_format"], CLANKER_OUTPUT_FORMAT_LABELS),
    hooks: hookPhaseDrafts(source["hooks"], `${path}/hooks`),
    qa: qaDraft(source["qa"], `${path}/qa`),
    extra: omit(source, [
      "timeout",
      "retry",
      "model",
      "provider",
      "concurrency",
      "template_engine",
      "output_format",
      "hooks",
      "qa",
    ]),
  };
}

const STEP_OWNED_KEYS = [
  "name",
  "description",
  "condition",
  "timeout",
  "retry",
  "concurrency",
  "depends_on",
  "skills",
  "agent",
  "env",
  "inputs",
  "outputs",
  "tags",
  "models",
  "prompts",
  "template_engine",
  "output_format",
  "hooks",
  "qa",
];

function stepDraft(source: UnknownRecord, index: number): ClankerStepDraft {
  const path = `steps/${index}`;
  const workflow = source["workflow"];
  const workflowRef = typeof workflow === "string" ? workflow : "";
  return {
    rowId: path,
    name: asText(source["name"]),
    description: asText(source["description"]),
    condition: asText(source["condition"]),
    agent: asText(source["agent"]),
    timeout: asText(source["timeout"]),
    retry: asText(source["retry"]),
    concurrency: asText(source["concurrency"]),
    dependsOn: asTextList(source["depends_on"]),
    skills: textRows(source["skills"], `${path}/skills`),
    workflowRef,
    env: keyValueRows(source["env"], `${path}/env`),
    inputs: keyValueRows(source["inputs"], `${path}/inputs`),
    outputs: keyValueRows(source["outputs"], `${path}/outputs`),
    tags: keyValueRows(source["tags"], `${path}/tags`),
    models: modelDrafts(source["models"], `${path}/models`),
    prompts: promptDrafts(source["prompts"], `${path}/prompts`),
    templateEngine: literalOf(source["template_engine"], CLANKER_TEMPLATE_ENGINE_LABELS),
    outputFormat: literalOf(source["output_format"], CLANKER_OUTPUT_FORMAT_LABELS),
    hooks: hookPhaseDrafts(source["hooks"], `${path}/hooks`),
    qa: qaDraft(source["qa"], `${path}/qa`),
    extra: omit(source, workflowRef === "" ? STEP_OWNED_KEYS : [...STEP_OWNED_KEYS, "workflow"]),
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
  const steps = (rawSteps ?? []) as ReadonlyArray<unknown>;
  if (steps.some((step) => step !== null && step !== undefined && !isRecord(step))) {
    return { ok: false, error: "Every entry in `steps` must be an object." };
  }
  return {
    ok: true,
    draft: {
      name: asText(raw["name"]),
      version: asText(raw["version"]),
      description: asText(raw["description"]),
      secrets: textRows(raw["secrets"], "secrets"),
      defaults: defaultsDraft(raw["defaults"], "defaults"),
      steps: steps.map((step, index) => stepDraft(isRecord(step) ? step : {}, index)),
      extra: omit(raw, ["name", "version", "description", "secrets", "defaults", "steps"]),
    },
  };
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

function hookObject(hook: ClankerHookDraft): Record<string, unknown> {
  return {
    ...compact(
      hook.kind === "cmd"
        ? { cmd: hook.cmd, runtime: textOrUndefined(hook.runtime) }
        : { fn: hook.fn, runtime: textOrUndefined(hook.runtime) },
    ),
    ...hook.extra,
  };
}

function hooksObject(
  phases: ReadonlyArray<ClankerHookPhaseDraft>,
): Record<string, ReadonlyArray<Record<string, unknown>>> | undefined {
  const named = phases.filter((phase) => phase.phase.trim() !== "");
  if (named.length === 0) return undefined;
  return Object.fromEntries(named.map((phase) => [phase.phase, phase.hooks.map(hookObject)]));
}

function qaCheckObject(check: ClankerQaCheckDraft): Record<string, unknown> {
  const fields: Record<string, unknown> =
    check.kind === "ref"
      ? { target: check.target }
      : check.kind === "inline"
        ? { name: check.name, prompt: check.prompt }
        : check.kind === "cmd"
          ? { cmd: check.cmd, runtime: textOrUndefined(check.runtime) }
          : { fn: check.fn };
  return {
    ...compact({ type: check.kind, ...fields, on_fail: textOrUndefined(check.onFail) }),
    ...check.extra,
  };
}

function qaObject(qa: ClankerQaDraft): Record<string, unknown> | undefined {
  if (!qa.enabled) return undefined;
  return {
    ...compact({
      on_fail: textOrUndefined(qa.onFail),
      checks: qa.checks.map(qaCheckObject),
    }),
    ...qa.extra,
  };
}

function defaultsObject(defaults: ClankerDefaultsDraft): Record<string, unknown> | undefined {
  const object = {
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
    ...defaults.extra,
  };
  return Object.keys(object).length === 0 ? undefined : object;
}

function promptObject(prompt: ClankerPromptDraft): Record<string, unknown> {
  return {
    ...compact(prompt.kind === "text" ? { text: prompt.text } : { file: prompt.file }),
    ...prompt.extra,
  };
}

function stepObject(step: ClankerStepDraft): Record<string, unknown> {
  return {
    ...compact({
      name: step.name,
      description: textOrUndefined(step.description),
      condition: textOrUndefined(step.condition),
      depends_on: step.dependsOn.filter((name) => name.trim() !== ""),
      timeout: numericOrText(step.timeout),
      retry: numericOrText(step.retry),
      concurrency: numericOrText(step.concurrency),
      agent: textOrUndefined(step.agent),
      workflow: textOrUndefined(step.workflowRef),
      skills: textListValues(step.skills),
      env: keyValueObject(step.env),
      inputs: keyValueObject(step.inputs),
      outputs: keyValueObject(step.outputs),
      tags: keyValueObject(step.tags),
      models: step.models.map((model) => ({
        ...compact({
          id: model.id,
          provider: textOrUndefined(model.provider),
          harness: textOrUndefined(model.harness),
        }),
        ...model.extra,
      })),
      prompts: step.prompts.map(promptObject),
      template_engine: textOrUndefined(step.templateEngine),
      output_format: textOrUndefined(step.outputFormat),
      hooks: hooksObject(step.hooks),
      qa: qaObject(step.qa),
    }),
    ...step.extra,
  };
}

export function clankerWorkflowDraftToObject(draft: ClankerWorkflowDraft): Record<string, unknown> {
  return {
    ...compact({
      name: draft.name,
      version: draft.version,
      description: textOrUndefined(draft.description),
      defaults: defaultsObject(draft.defaults),
      secrets: textListValues(draft.secrets),
      steps: draft.steps.map(stepObject),
    }),
    ...draft.extra,
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

export function emptyClankerWorkflowDraft(): ClankerWorkflowDraft {
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
    agent: "",
    timeout: "",
    retry: "",
    concurrency: "",
    dependsOn: [],
    skills: [],
    workflowRef: "",
    env: [],
    inputs: [],
    outputs: [],
    tags: [],
    models: [],
    prompts: [{ rowId: `${path}/prompts/0`, kind: "text", text: "", file: "", extra: {} }],
    templateEngine: "",
    outputFormat: "",
    hooks: [],
    qa: emptyClankerQaDraft(),
    extra: {},
  };
}

export function emptyClankerPromptDraft(rowId: string): ClankerPromptDraft {
  return { rowId, kind: "text", text: "", file: "", extra: {} };
}

export function emptyClankerModelDraft(rowId: string): ClankerModelDraft {
  return { rowId, id: "", provider: "", harness: "", extra: {} };
}

export function emptyClankerHookDraft(rowId: string): ClankerHookDraft {
  return { rowId, kind: "cmd", cmd: "", fn: "", runtime: "", extra: {} };
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
    runtime: "",
    onFail: "",
    extra: {},
  };
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
