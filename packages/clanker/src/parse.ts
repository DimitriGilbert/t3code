/**
 * Content-level Clanker workflow parsing: accepts YAML or JSON (JSON is a
 * YAML subset), decodes against {@link ClankerWorkflow} with excess-key
 * rejection, and reports every problem as a {@link ClankerDiagnostic} instead
 * of throwing — a broken file still gets a list of issues to show.
 */
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { parse as parseYaml } from "yaml";

import { ClankerHookObject, ClankerWorkflow, type ClankerHooks, type ClankerQa } from "./format.ts";

export const ClankerDiagnosticSeverity = Schema.Literals(["error", "warning", "unsupported"]);
export type ClankerDiagnosticSeverity = typeof ClankerDiagnosticSeverity.Type;

export const ClankerDiagnostic = Schema.Struct({
  severity: ClankerDiagnosticSeverity,
  message: Schema.String,
  path: Schema.optional(Schema.String),
});
export type ClankerDiagnostic = typeof ClankerDiagnostic.Type;

export interface ClankerParseResult {
  readonly workflow?: ClankerWorkflow | undefined;
  readonly diagnostics: ReadonlyArray<ClankerDiagnostic>;
}

const decodeWorkflow = Schema.decodeUnknownExit(ClankerWorkflow, {
  errors: "all",
  onExcessProperty: "error",
});

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPathSegment(segments: ReadonlyArray<unknown>): string {
  let path = "";
  for (const raw of segments) {
    const segment =
      typeof raw === "object" && raw !== null && "key" in raw
        ? (raw as { readonly key: unknown }).key
        : raw;
    if (typeof segment === "number") {
      path += `[${segment}]`;
    } else if (typeof segment === "string" || typeof segment === "symbol") {
      path += path.length > 0 ? `.${String(segment)}` : String(segment);
    }
  }
  return path;
}

const isHookObject = Schema.is(ClankerHookObject);

function hookEntries(
  hooks: ClankerHooks,
): ReadonlyArray<{ readonly path: string; readonly hook: ClankerHookObject }> {
  const entries: { path: string; hook: ClankerHookObject }[] = [];
  for (const phase of Object.keys(hooks)) {
    const list = hooks[phase];
    if (list === undefined) continue;
    for (let k = 0; k < list.length; k++) {
      const entry = list[k];
      if (entry === undefined) continue;
      if (isHookObject(entry)) {
        entries.push({ path: `${phase}[${k}]`, hook: entry });
      } else {
        for (let l = 0; l < entry.length; l++) {
          const hook = entry[l];
          if (hook === undefined) continue;
          entries.push({ path: `${phase}[${k}][${l}]`, hook });
        }
      }
    }
  }
  return entries;
}

function collectQaDiagnostics(
  qa: ClankerQa,
  basePath: string,
  diagnostics: ClankerDiagnostic[],
): void {
  if (qa.escalate !== undefined && qa.escalate.length > 0) {
    diagnostics.push({
      severity: "unsupported",
      message: "Escalation handlers (AI and HIL) are not supported by the T3 Code runner.",
      path: `${basePath}.escalate`,
    });
  }
  if (qa.checks !== undefined) {
    for (let j = 0; j < qa.checks.length; j++) {
      const check = qa.checks[j];
      if (check !== undefined && check.type === "fn") {
        diagnostics.push({
          severity: "unsupported",
          message: "fn QA checks are not supported by the T3 Code runner.",
          path: `${basePath}.checks[${j}]`,
        });
      }
    }
  }
}

function collectHookDiagnostics(
  hooks: ClankerHooks,
  basePath: string,
  diagnostics: ClankerDiagnostic[],
): void {
  for (const { path, hook } of hookEntries(hooks)) {
    if ("fn" in hook) {
      diagnostics.push({
        severity: "unsupported",
        message: "fn hooks are not supported by the T3 Code runner.",
        path: `${basePath}.${path}`,
      });
    }
  }
}

function collectStepDiagnostics(
  step: ClankerWorkflow["steps"][number],
  index: number,
  diagnostics: ClankerDiagnostic[],
): void {
  const sp = `steps[${index}]`;

  if (step.conditions !== undefined) {
    diagnostics.push({
      severity: "unsupported",
      message: "Step conditions are not supported by the T3 Code runner.",
      path: `${sp}.conditions`,
    });
  }
  if (step.conditions_mode !== undefined) {
    diagnostics.push({
      severity: "unsupported",
      message: "conditions_mode is not supported by the T3 Code runner.",
      path: `${sp}.conditions_mode`,
    });
  }
  if (step.run !== undefined) {
    diagnostics.push({
      severity: "unsupported",
      message: "run steps are not supported by the T3 Code runner.",
      path: `${sp}.run`,
    });
  }
  if (step.workflow !== undefined) {
    diagnostics.push({
      severity: "unsupported",
      message: "Sub-workflows are not supported by the T3 Code runner.",
      path: `${sp}.workflow`,
    });
  }
  if (step.agent !== undefined) {
    diagnostics.push({
      severity: "unsupported",
      message: "Agent definition files are not supported by the T3 Code runner.",
      path: `${sp}.agent`,
    });
  }
  if (step.skills !== undefined && step.skills.length > 0) {
    diagnostics.push({
      severity: "warning",
      message: "Step skills are ignored by the T3 Code runner.",
      path: `${sp}.skills`,
    });
  }
  if (step.template_engine === "jinja2") {
    diagnostics.push({
      severity: "unsupported",
      message: "The jinja2 template engine is not supported; use handlebars or none.",
      path: `${sp}.template_engine`,
    });
  }
  if (
    step.prompts === undefined &&
    step.agent === undefined &&
    step.workflow === undefined &&
    step.run === undefined
  ) {
    diagnostics.push({
      severity: "error",
      message: "prompts is required unless agent, workflow, or run is present.",
      path: sp,
    });
  }
  if (step.workflow !== undefined && (step.prompts !== undefined || step.run !== undefined)) {
    diagnostics.push({
      severity: "error",
      message: "workflow is mutually exclusive with prompts and run",
      path: sp,
    });
  }
  if (step.run !== undefined && step.prompts !== undefined) {
    diagnostics.push({
      severity: "error",
      message: "run and prompts are mutually exclusive",
      path: sp,
    });
  }
  if (
    step.models !== undefined &&
    step.prompts === undefined &&
    step.agent === undefined &&
    step.workflow === undefined
  ) {
    diagnostics.push({
      severity: "error",
      message: "models requires prompts, agent, or workflow.",
      path: `${sp}.models`,
    });
  }
  if (step.hooks !== undefined) {
    collectHookDiagnostics(step.hooks, `${sp}.hooks`, diagnostics);
  }
  if (step.qa !== undefined) {
    collectQaDiagnostics(step.qa, `${sp}.qa`, diagnostics);
  }
}

export function parseClankerWorkflow(content: string): ClankerParseResult {
  const diagnostics: ClankerDiagnostic[] = [];

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (cause) {
    diagnostics.push({
      severity: "error",
      message: `Failed to parse workflow file: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return { diagnostics };
  }

  if (!isPlainObject(raw)) {
    diagnostics.push({
      severity: "error",
      message: "Workflow must be a YAML/JSON object.",
    });
    return { diagnostics };
  }

  const decoded = decodeWorkflow(raw);
  if (Exit.isFailure(decoded)) {
    const schemaError = Cause.findErrorOption(decoded.cause);
    if (Option.isSome(schemaError)) {
      for (const issue of formatIssue(schemaError.value.issue).issues) {
        const path = formatPathSegment(issue.path ?? []);
        diagnostics.push({
          severity: "error",
          message: issue.message,
          ...(path.length > 0 ? { path } : {}),
        });
      }
    } else {
      diagnostics.push({
        severity: "error",
        message: "Workflow failed schema validation.",
      });
    }
    return { diagnostics };
  }

  const workflow = decoded.value;
  const defaults = workflow.defaults;
  if (defaults?.template_engine === "jinja2") {
    diagnostics.push({
      severity: "unsupported",
      message: "The jinja2 template engine is not supported; use handlebars or none.",
      path: "defaults.template_engine",
    });
  }
  if (defaults?.hooks !== undefined) {
    collectHookDiagnostics(defaults.hooks, "defaults.hooks", diagnostics);
  }
  if (defaults?.qa !== undefined) {
    collectQaDiagnostics(defaults.qa, "defaults.qa", diagnostics);
  }
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (step !== undefined) {
      collectStepDiagnostics(step, i, diagnostics);
    }
  }

  return { workflow, diagnostics };
}
