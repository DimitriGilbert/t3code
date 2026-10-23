/**
 * Merge a workflow's `defaults` block into each step with the Clanker runner's
 * merge semantics (not the schema's "replaces" prose): step values win for
 * scalars and `qa.on_fail`/`qa.escalate`; `hooks` and `qa.checks` concatenate
 * step-first; `models` defaults apply only when the step declares none.
 */
import type {
  ClankerDefaults,
  ClankerHookEntry,
  ClankerHooks,
  ClankerQa,
  ClankerStep,
  ClankerWorkflow,
} from "./format.ts";

/** Mirrors Clanker's `mergeHooks`: per phase, step entries then defaults entries. */
function mergeHooks(
  stepHooks: ClankerHooks | undefined,
  defaultHooks: ClankerHooks | undefined,
): ClankerHooks | undefined {
  if (stepHooks === undefined) return defaultHooks;
  if (defaultHooks === undefined) return stepHooks;
  const merged: Record<string, Array<ClankerHookEntry>> = {};
  const phases = new Set([...Object.keys(stepHooks), ...Object.keys(defaultHooks)]);
  for (const phase of phases) {
    merged[phase] = [...(stepHooks[phase] ?? []), ...(defaultHooks[phase] ?? [])];
  }
  return merged;
}

/** Step checks first, then defaults checks (`mergeQAChecks`); on_fail/escalate fall back per field. */
function mergeQa(
  stepQa: ClankerQa | undefined,
  defaultQa: ClankerQa | undefined,
): ClankerQa | undefined {
  if (stepQa === undefined) return defaultQa;
  if (defaultQa === undefined) return stepQa;
  const onFail = stepQa.on_fail ?? defaultQa.on_fail;
  const escalate = stepQa.escalate ?? defaultQa.escalate;
  const checks =
    stepQa.checks !== undefined || defaultQa.checks !== undefined
      ? [...(stepQa.checks ?? []), ...(defaultQa.checks ?? [])]
      : undefined;
  return {
    ...(onFail !== undefined ? { on_fail: onFail } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(escalate !== undefined ? { escalate } : {}),
  };
}

export function applyClankerStepDefaults(
  step: ClankerStep,
  defaults: ClankerDefaults | undefined,
): ClankerStep {
  if (defaults === undefined) return step;

  let models = step.models;
  if (models === undefined && (defaults.model !== undefined || defaults.provider !== undefined)) {
    const id = defaults.model ?? "default";
    models = [defaults.provider === undefined ? { id } : { id, provider: defaults.provider }];
  }

  const hooks = mergeHooks(step.hooks, defaults.hooks);
  const qa = mergeQa(step.qa, defaults.qa);

  return {
    ...step,
    ...(step.timeout === undefined && defaults.timeout !== undefined
      ? { timeout: defaults.timeout }
      : {}),
    ...(step.retry === undefined && defaults.retry !== undefined ? { retry: defaults.retry } : {}),
    ...(step.concurrency === undefined && defaults.concurrency !== undefined
      ? { concurrency: defaults.concurrency }
      : {}),
    ...(step.template_engine === undefined && defaults.template_engine !== undefined
      ? { template_engine: defaults.template_engine }
      : {}),
    ...(step.output_format === undefined && defaults.output_format !== undefined
      ? { output_format: defaults.output_format }
      : {}),
    ...(hooks !== step.hooks && hooks !== undefined ? { hooks } : {}),
    ...(qa !== step.qa && qa !== undefined ? { qa } : {}),
    ...(models !== step.models && models !== undefined ? { models } : {}),
  };
}

export function applyClankerWorkflowDefaults(workflow: ClankerWorkflow): ClankerWorkflow {
  const defaults = workflow.defaults;
  if (defaults === undefined) return workflow;
  return {
    ...workflow,
    steps: workflow.steps.map((step) => applyClankerStepDefaults(step, defaults)),
  };
}
