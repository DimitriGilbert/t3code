/**
 * Reference resolution and the supported subset of handlebars templating for
 * Clanker prompts/inputs: `{{dot.path}}` interpolation, `env.NAME` lookups,
 * `steps.<step>.outputs.<key>` lookups, and the condition expression forms
 * T3 Code can evaluate without a harness.
 */
import type { ClankerDiagnostic } from "./parse.ts";

export interface ClankerRefContext {
  /** Environment variables available to `env.NAME` references. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Per-step outputs, keyed by step name then output key. */
  readonly stepOutputs?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
  /** Top-level template variables (resolved inputs, prompt context). */
  readonly values?: Readonly<Record<string, unknown>> | undefined;
}

const DANGEROUS_KEYS = new Set(["constructor", "__proto__", "prototype"]);

/**
 * Resolve a reference string. `env.X` looks up the environment record,
 * `steps.<step>.outputs.<key>` looks up produced outputs, anything else is a
 * bare literal that resolves to itself. Missing refs return `undefined`
 * rather than throwing so callers decide how to render them.
 */
export function resolveClankerRef(ref: string, ctx: ClankerRefContext): string | undefined {
  if (ref.startsWith("env.")) {
    const key = ref.slice(4);
    if (DANGEROUS_KEYS.has(key)) return undefined;
    if (ctx.env === undefined || !Object.hasOwn(ctx.env, key)) return undefined;
    return ctx.env[key];
  }

  if (ref.startsWith("steps.")) {
    const rest = ref.slice(6);
    const dotIndex = rest.indexOf(".");
    if (dotIndex === -1) return undefined;
    const stepName = rest.slice(0, dotIndex);
    const property = rest.slice(dotIndex + 1);
    if (DANGEROUS_KEYS.has(stepName)) return undefined;
    if (!property.startsWith("outputs.")) return undefined;
    const outputKey = property.slice(8);
    if (DANGEROUS_KEYS.has(outputKey)) return undefined;
    const stepOutputs = ctx.stepOutputs;
    if (stepOutputs === undefined || !Object.hasOwn(stepOutputs, stepName)) {
      return undefined;
    }
    const outputs = stepOutputs[stepName];
    if (outputs === undefined || !Object.hasOwn(outputs, outputKey)) return undefined;
    return outputs[outputKey];
  }

  return ref;
}

const TEMPLATE_TOKEN = /\{\{([^{}]*)\}\}/g;
const BLOCK_TOKEN = /^[#/^>!&{]|^else\b/;

function lookupTemplatePath(path: string, ctx: ClankerRefContext): unknown {
  if (path === "else" || path.length === 0) return undefined;
  if (path.startsWith("env.") || path.startsWith("steps.")) {
    return resolveClankerRef(path, ctx);
  }
  let current: unknown = ctx.values;
  for (const segment of path.split(".")) {
    if (DANGEROUS_KEYS.has(segment)) return undefined;
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export interface ClankerTemplateResult {
  readonly text: string;
  readonly diagnostics: ReadonlyArray<ClankerDiagnostic>;
}

/**
 * Render the supported handlebars subset: `{{dot.path}}` interpolation only.
 * Helpers, sections, partials, and `{{else}}` report `unsupported`
 * diagnostics and render as empty strings.
 */
export function renderClankerTemplate(
  template: string,
  ctx: ClankerRefContext,
): ClankerTemplateResult {
  const diagnostics: ClankerDiagnostic[] = [];
  const unsupported = new Set<string>();

  const text = template.replace(TEMPLATE_TOKEN, (_match, inner: string) => {
    const path = inner.trim();
    if (BLOCK_TOKEN.test(path)) {
      if (!unsupported.has(path)) {
        unsupported.add(path);
        diagnostics.push({
          severity: "unsupported",
          message: `Unsupported handlebars construct '{{${path}}}'.`,
        });
      }
      return "";
    }
    return renderValue(lookupTemplatePath(path, ctx));
  });

  if (text.includes("{{") || text.includes("}}")) {
    diagnostics.push({
      severity: "unsupported",
      message: "Unbalanced or nested handlebars braces are not supported.",
    });
  }

  return { text, diagnostics };
}

const CONDITION_PATTERN = /^(!?)([\w.-]+?)(?:\s*(==|!=)\s*(?:'([^']*)'|"([^"]*)"))?\s*$/;

/**
 * Evaluate the supported condition forms: bare ref truthiness, `!ref`,
 * `ref == 'lit'`/`!=`, and double-quoted literals. Returns `undefined` for
 * syntax outside this subset so callers can surface it as unsupported.
 */
export function evalClankerCondition(
  expression: string,
  ctx: ClankerRefContext,
): boolean | undefined {
  const match = CONDITION_PATTERN.exec(expression.trim());
  if (match === null) return undefined;

  const negated = match[1] === "!";
  const ref = match[2];
  const operator = match[3];
  const literal = match[4] ?? match[5];
  if (ref === undefined) return undefined;

  const resolved =
    ref.startsWith("env.") || ref.startsWith("steps.")
      ? resolveClankerRef(ref, ctx)
      : lookupTemplatePath(ref, ctx);

  const value =
    operator === undefined
      ? resolved !== undefined &&
        resolved !== null &&
        resolved !== false &&
        resolved !== 0 &&
        resolved !== "" &&
        !(Array.isArray(resolved) && resolved.length === 0)
      : operator === "=="
        ? resolved !== undefined && String(resolved) === literal
        : resolved === undefined || String(resolved) !== literal;
  return negated ? !value : value;
}
