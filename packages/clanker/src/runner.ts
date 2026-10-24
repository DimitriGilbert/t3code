/**
 * Pure run engine for Clanker workflows. No I/O and no Effect: the engine is a
 * deterministic state machine that takes settlement events from the server
 * (prompt turn finished, cmd exited, step failed) and returns the next engine
 * state plus the actions the server should execute. All policy lives here so
 * it is trivially testable; all execution lives in the driving service.
 *
 * Semantics mirror `apps/cli/src/runner` in the Clanker repo:
 *
 * - `step-runner.ts`: per step, evaluate conditions -> run `before` hooks ->
 *   retry loop of attempts (prompt x model pairs, then every QA check) ->
 *   `after` hooks -> `on_error` hooks when the final attempt failed. A failed
 *   attempt is coerced to success when `qa.on_fail === "continue"`, retried
 *   while `retryCount < (step.retry ?? defaults.retry ?? 0)`, and the retry
 *   loop runs QA checks even when the prompts themselves failed.
 * - `wave-executor.ts`/`workflow-runner.ts`: steps in a wave dispatch in
 *   batches of `defaults.concurrency`; a batch's replacement only starts once
 *   every dispatched step is terminal. Any step that ends `failed` (after
 *   retry/`continue` handling) fails the whole run: later waves never start
 *   and their steps stay `pending`. Nothing after a failed wave is marked
 *   `skipped` — Clanker simply never reaches it.
 * - `wave-executor.ts` catch path: a hard step failure (thrown rather than a
 *   settled bad result) fails the step immediately with no retry, matching
 *   the engine's `stepFailed` event.
 *
 * Per-check `qa.checks[].on_fail` is richer than upstream (the Clanker parser
 * accepts `rerun`/`abort`/`continue`/`escalate` per check but its runner only
 * applies the step-level `qa.on_fail`). Here a check-level policy wins over
 * the step-level default: `continue` tolerates that check and moves on,
 * `rerun` forces an attempt retry, `abort` fails the step without retrying,
 * and `escalate` — like `qa.escalate` handlers generally — fails the step as
 * v1-unsupported. With no check-level policy the step falls back to the
 * Clanker behavior described above.
 *
 * Constructs the T3 Code runner cannot execute (`conditions`,
 * `conditions_mode`, `run`, `workflow`, `agent`, jinja2 templates, fn hooks,
 * non-cmd QA checks, escalation handlers) fail the step fast with a clear
 * reason, consistent with the `unsupported` diagnostics `parse.ts` reports.
 */
import { buildClankerWaves } from "./dag.ts";
import { applyClankerWorkflowDefaults } from "./defaults.ts";
import type {
  ClankerFnHook,
  ClankerHookObject,
  ClankerHooks,
  ClankerModel,
  ClankerStep,
  ClankerWorkflow,
} from "./format.ts";
import type { ClankerDiagnostic } from "./parse.ts";
import {
  evalClankerCondition,
  renderClankerTemplate,
  resolveClankerRef,
  type ClankerRefContext,
} from "./refs.ts";
import type {
  ClankerPersistedRunState,
  ClankerRunResult,
  ClankerStepResponse,
  ClankerStepResult,
  ClankerStepState,
} from "./runState.ts";

export type ClankerEngineStatus = "running" | "completed" | "failed" | "cancelled";

/** Phases inside a step's lifecycle; the step is `running` while one is set. */
export type ClankerStepPhase = "hook-before" | "prompt" | "qa" | "hook-after" | "hook-on-error";

export type ClankerHookPhase = "before" | "after" | "on_error";

export type ClankerStepRunStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface ClankerPromptPair {
  readonly promptIndex: number;
  readonly modelIndex: number;
  readonly model: ClankerModel;
  readonly renderedPrompt: string;
}

interface ClankerPromptPairRef {
  readonly promptIndex: number;
  readonly modelIndex: number;
}

/**
 * Engine-level per-attempt detail, richer than the persisted
 * `ClankerStepState` (`runState.ts`): the queue positions let the server
 * correlate settlements with dispatches via `attempt` (the retry index, so
 * the first attempt is 0, matching what Clanker persists as `retryCount`).
 */
export interface ClankerStepRunState {
  readonly status: ClankerStepRunStatus;
  /** Retry index of the current/last attempt; persisted as `retryCount`. */
  readonly attempt: number;
  readonly phase?: ClankerStepPhase | undefined;
  /** Index of the in-flight group inside the phase's flattened hook plan. */
  readonly hookGroupIndex: number;
  /** Flat hook ordinals dispatched for the current group, awaiting settle. */
  readonly pendingHooks: ReadonlyArray<number>;
  /** Error recorded by a settled hook in the current group, if any. */
  readonly hookError?: string | undefined;
  /** Prompt x model pairs dispatched for this attempt, awaiting settle. */
  readonly pendingPairs: ReadonlyArray<ClankerPromptPairRef>;
  /** Prompt x model pairs not yet dispatched this attempt (concurrency cap). */
  readonly pairQueue: ReadonlyArray<ClankerPromptPair>;
  /** Next QA check index to dispatch for this attempt. */
  readonly qaCheckIndex: number;
  /** QA check index dispatched and awaiting settle. */
  readonly pendingQaCheck?: number | undefined;
  /** Errors from prompt pairs that failed during the current attempt. */
  readonly attemptErrors: ReadonlyArray<string>;
  /** QA failures tolerated by a check-level `on_fail: "continue"`. */
  readonly toleratedErrors: ReadonlyArray<string>;
  readonly resolvedInputs: Readonly<Record<string, unknown>>;
  readonly responses: ReadonlyArray<ClankerStepResponse>;
  readonly declaredOutputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly error?: string | undefined;
  /** Set when the attempt outcome already resolved to a terminal failure. */
  readonly failed: boolean;
}

const pendingStepRunState = (declaredOutputs: Readonly<Record<string, string>>) =>
  ({
    status: "pending",
    attempt: 0,
    hookGroupIndex: 0,
    pendingHooks: [],
    pendingPairs: [],
    pairQueue: [],
    qaCheckIndex: 0,
    attemptErrors: [],
    toleratedErrors: [],
    resolvedInputs: {},
    responses: [],
    declaredOutputs: { ...declaredOutputs },
    outputs: {},
    failed: false,
  }) satisfies ClankerStepRunState;

/** A step the server restores from a prior run's persisted state instead of re-running. */
export interface ClankerRestoredStep {
  readonly name: string;
  readonly status: "passed" | "skipped";
  readonly outputs?: Readonly<Record<string, string>> | undefined;
  readonly declaredOutputs?: Readonly<Record<string, string>> | undefined;
  readonly responses?: ReadonlyArray<ClankerStepResponse> | undefined;
  readonly retryCount?: number | undefined;
  readonly error?: string | undefined;
}

/** Immutable snapshot describing a run in progress. */
export interface ClankerEngineState {
  /** Workflow with `defaults` merged into every step. */
  readonly workflow: ClankerWorkflow;
  readonly stepsByName: ReadonlyMap<string, ClankerStep>;
  readonly waves: ReadonlyArray<ReadonlyArray<string>>;
  readonly stepStates: ReadonlyMap<string, ClankerStepRunState>;
  readonly status: ClankerEngineStatus;
  /**
   * Step-name -> produced outputs, the `steps.` half of the template context.
   * Seeded for every restored step up front (Clanker hydrates prior run state
   * before wave 0) and updated as each step reaches a terminal status.
   */
  readonly stepOutputs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly waveIndex: number;
  /** Environment visible to conditions, template `env.` refs, and cmd exec. */
  readonly env: Readonly<Record<string, string>>;
  /** `file:` prompt contents, keyed by the raw `file` path as written. */
  readonly files: Readonly<Record<string, string>>;
  readonly resumeGateOpen: boolean;
  readonly startFromStep?: string | undefined;
  readonly restoredByName: ReadonlyMap<string, ClankerRestoredStep>;
}

export type ClankerEngineAction =
  | {
      readonly type: "dispatchPrompt";
      readonly stepName: string;
      readonly attempt: number;
      readonly promptIndex: number;
      readonly modelIndex: number;
      readonly renderedPrompt: string;
      readonly model: ClankerModel;
    }
  | {
      readonly type: "runCmd";
      readonly stepName: string;
      readonly attempt: number;
      readonly kind: "hook" | "qa";
      readonly cmd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly phase?: ClankerHookPhase | undefined;
      readonly hookIndex?: number | undefined;
      readonly checkIndex?: number | undefined;
    }
  | {
      readonly type: "stepPassed";
      readonly stepName: string;
      readonly attempt: number;
    }
  | {
      readonly type: "stepFailed";
      readonly stepName: string;
      readonly attempt: number;
      readonly error: string;
    }
  | {
      readonly type: "stepSkipped";
      readonly stepName: string;
      readonly reason: string;
    }
  | {
      readonly type: "runCompleted";
      readonly result: ClankerRunResult;
    };

export interface ClankerEngineStartOptions {
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * Contents for `prompts[].file` entries, keyed by the raw `file` path as
   * written in the workflow. The driving service resolves and reads them; a
   * missing entry fails the step with a clear reason.
   */
  readonly files?: Readonly<Record<string, string>> | undefined;
  /**
   * Clanker's `resumeFrom`: the gate stays closed until this step is reached
   * in wave order. Before the gate opens, steps with a restored entry are
   * restored and steps without one still run — matching the CLI.
   */
  readonly startFromStep?: string | undefined;
  /**
   * Prior outputs/state to carry in (the spec's `priorOutputs` plus the
   * passed/skipped distinction Clanker persists). Their outputs seed the
   * `steps.` template context for the whole run.
   */
  readonly restoredSteps?: ReadonlyArray<ClankerRestoredStep> | undefined;
}

export interface ClankerEngineTransition {
  readonly state: ClankerEngineState;
  readonly actions: ReadonlyArray<ClankerEngineAction>;
  /** Non-blocking diagnostics, e.g. unsupported template constructs. */
  readonly diagnostics: ReadonlyArray<ClankerDiagnostic>;
}

/**
 * Mutable work-in-progress passed down the synchronous transition chain;
 * each helper appends to `actions`/`diagnostics` and returns the next state.
 */
interface ClankerEngineWork {
  state: ClankerEngineState;
  actions: ClankerEngineAction[];
  diagnostics: ClankerDiagnostic[];
}

const work = (state: ClankerEngineState): ClankerEngineWork => ({
  state,
  actions: [],
  diagnostics: [],
});

const done = (w: ClankerEngineWork): ClankerEngineTransition => ({
  state: w.state,
  actions: w.actions,
  diagnostics: w.diagnostics,
});

const updateStep = (
  state: ClankerEngineState,
  stepName: string,
  patch: Partial<ClankerStepRunState>,
): ClankerEngineState => {
  const current = state.stepStates.get(stepName);
  if (current === undefined) return state;
  const stepStates = new Map(state.stepStates);
  stepStates.set(stepName, { ...current, ...patch });
  return { ...state, stepStates };
};

const stepOutputsRecord = (
  state: ClankerEngineState,
): Record<string, Readonly<Record<string, string>>> => {
  const record: Record<string, Readonly<Record<string, string>>> = {};
  for (const [name, outputs] of state.stepOutputs) {
    record[name] = Object.fromEntries(outputs);
  }
  return record;
};

const localEnv = (state: ClankerEngineState, step: ClankerStep): Record<string, string> => ({
  ...state.env,
  ...(step.env ?? {}),
});

const refContext = (state: ClankerEngineState, step: ClankerStep): ClankerRefContext => ({
  env: localEnv(state, step),
  stepOutputs: stepOutputsRecord(state),
});

const isHookGroup = (
  entry: ClankerHooks[string][number],
): entry is ReadonlyArray<ClankerHookObject> => Array.isArray(entry);

/** Flatten a hook phase's entries into sequential groups of parallel hooks. */
const hookGroups = (entries: ReadonlyArray<ClankerHooks[string][number]>) => {
  const groups: Array<Array<{ index: number; hook: ClankerHookObject }>> = [];
  let index = 0;
  for (const entry of entries) {
    if (isHookGroup(entry)) {
      groups.push(entry.map((hook) => ({ index: index++, hook })));
    } else {
      groups.push([{ index: index++, hook: entry }]);
    }
  }
  return groups;
};

const hookPhaseFor = (enginePhase: ClankerStepPhase & `hook-${string}`): ClankerHookPhase =>
  enginePhase === "hook-before" ? "before" : enginePhase === "hook-after" ? "after" : "on_error";

const ENGINE_PHASE_BY_HOOK: Record<ClankerHookPhase, ClankerStepPhase & `hook-${string}`> = {
  before: "hook-before",
  after: "hook-after",
  on_error: "hook-on-error",
};

const currentWave = (state: ClankerEngineState): ReadonlyArray<string> =>
  state.waves[state.waveIndex] ?? [];

const toClankerRunResult = (state: ClankerEngineState): ClankerRunResult => {
  const steps: ClankerStepResult[] = [];
  for (const wave of state.waves) {
    for (const name of wave) {
      const stepState = state.stepStates.get(name);
      if (stepState === undefined || stepState.status === "pending") continue;
      const inFlight = stepState.status === "running";
      steps.push({
        stepName: name,
        success: stepState.status === "passed" || stepState.status === "skipped",
        skipped: stepState.status === "skipped",
        durationMs: 0,
        responses: [...stepState.responses],
        declaredOutputs: { ...stepState.declaredOutputs },
        outputs: { ...stepState.outputs },
        ...(stepState.error !== undefined || inFlight
          ? {
              error: stepState.error ?? "Step was still running when the run ended.",
            }
          : {}),
        retryCount: stepState.attempt,
      });
    }
  }
  const firstFailure = steps.find((step) => !step.success && !step.skipped);
  return {
    success: state.status === "completed",
    cancelled: state.status === "cancelled",
    name: state.workflow.name,
    steps,
    ...(state.status === "failed" ? { error: firstFailure?.error ?? "Workflow failed" } : {}),
  };
};

const finishRun = (w: ClankerEngineWork, status: Exclude<ClankerEngineStatus, "running">): void => {
  w.state = { ...w.state, status };
  w.actions.push({ type: "runCompleted", result: toClankerRunResult(w.state) });
};

/** Seed a terminal step's outputs into the shared `steps.` context. */
const seedStepOutputs = (
  state: ClankerEngineState,
  stepName: string,
  outputs: Readonly<Record<string, string>>,
): ClankerEngineState => {
  const stepOutputs = new Map(state.stepOutputs);
  stepOutputs.set(stepName, new Map(Object.entries(outputs)));
  return { ...state, stepOutputs };
};

const markTerminal = (
  w: ClankerEngineWork,
  stepName: string,
  terminal:
    | { status: "passed" }
    | { status: "skipped"; reason?: string }
    | { status: "failed"; error: string },
): void => {
  const stepState = w.state.stepStates.get(stepName);
  if (
    stepState === undefined ||
    stepState.status === "passed" ||
    stepState.status === "failed" ||
    stepState.status === "skipped"
  ) {
    // Terminal states are final — a second mark must not emit another
    // action (a fail-fast inside hook dispatch can precede the caller's
    // own terminal path).
    return;
  }
  let next = seedStepOutputs(
    w.state,
    stepName,
    terminal.status === "skipped" ? {} : stepState.outputs,
  );
  next = updateStep(next, stepName, {
    status: terminal.status,
    phase: undefined,
    pendingHooks: [],
    pendingPairs: [],
    pairQueue: [],
    pendingQaCheck: undefined,
    hookError: undefined,
    ...(terminal.status === "failed" ? { error: terminal.error } : {}),
  });
  w.state = next;
  if (terminal.status === "passed") {
    w.actions.push({ type: "stepPassed", stepName, attempt: stepState.attempt });
  } else if (terminal.status === "skipped") {
    w.actions.push({
      type: "stepSkipped",
      stepName,
      reason: terminal.reason ?? "Step skipped.",
    });
  } else {
    w.actions.push({
      type: "stepFailed",
      stepName,
      attempt: stepState.attempt,
      error: terminal.error,
    });
  }
};

/**
 * Mark a wave's restored steps before its runnable batch is computed.
 * Mirrors workflow-runner.ts: before the resume gate opens at
 * `startFromStep`, restored steps are restored and un-restored ones still
 * run; afterwards every pending step runs.
 */
const enterWave = (w: ClankerEngineWork): void => {
  let gateOpen = w.state.resumeGateOpen;
  for (const name of currentWave(w.state)) {
    const stepState = w.state.stepStates.get(name);
    if (stepState === undefined || stepState.status !== "pending") continue;
    if (!gateOpen && name === w.state.startFromStep) {
      gateOpen = true;
      continue;
    }
    if (gateOpen) continue;
    const restored = w.state.restoredByName.get(name);
    if (restored === undefined) continue;
    w.state = updateStep(w.state, name, {
      status: restored.status,
      attempt: restored.retryCount ?? 0,
      responses: [...(restored.responses ?? [])],
      declaredOutputs: { ...(restored.declaredOutputs ?? restored.outputs ?? {}) },
      outputs: { ...(restored.outputs ?? {}) },
      error: restored.error,
    });
    if (restored.status === "passed") {
      w.actions.push({ type: "stepPassed", stepName: name, attempt: restored.retryCount ?? 0 });
    } else {
      w.actions.push({
        type: "stepSkipped",
        stepName: name,
        reason: restored.error ?? "Restored from prior run.",
      });
    }
  }
  if (gateOpen !== w.state.resumeGateOpen) {
    w.state = { ...w.state, resumeGateOpen: gateOpen };
  }
};

/**
 * Dispatch the next group in a hook phase that has cmd hooks. Leaves
 * `pendingHooks` non-empty while waiting on settlements. A group
 * containing an `fn` hook fails the step fast — fn hooks are
 * v1-unsupported (the `unsupported` diagnostics in parse.ts) and running
 * the group's cmd hooks without it would misreport the workflow. When the
 * step is already failing (after/on_error hooks on a failed attempt) the
 * original error wins and the hook is reported as a diagnostic instead —
 * matching Clanker, where the step always reports its own error
 * (step-runner.ts:203-213).
 */
const dispatchHookPhase = (
  w: ClankerEngineWork,
  stepName: string,
  step: ClankerStep,
  enginePhase: ClankerStepPhase & `hook-${string}`,
  fromGroup: number,
): void => {
  const phase = hookPhaseFor(enginePhase);
  const groups = hookGroups(step.hooks?.[phase] ?? []);
  const stepState = w.state.stepStates.get(stepName);
  const attempt = stepState?.attempt ?? 0;

  for (let groupIndex = fromGroup; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (group === undefined) continue;
    const fnHook = group.find(
      (entry): entry is { index: number; hook: ClankerFnHook } => "fn" in entry.hook,
    );
    if (fnHook !== undefined) {
      const reason = `fn hooks are not supported by the T3 Code runner (hook "${fnHook.hook.fn}").`;
      const current = w.state.stepStates.get(stepName);
      const originalError = current?.failed === true ? current.error : undefined;
      if (originalError !== undefined) {
        w.diagnostics.push({ severity: "unsupported", message: reason });
        markTerminal(w, stepName, { status: "failed", error: originalError });
      } else {
        markTerminal(w, stepName, { status: "failed", error: reason });
      }
      return;
    }
    const pendingHooks: number[] = [];
    for (const { index, hook } of group) {
      if (!("cmd" in hook)) continue;
      pendingHooks.push(index);
      w.actions.push({
        type: "runCmd",
        stepName,
        attempt,
        kind: "hook",
        cmd: hook.cmd,
        env: localEnv(w.state, step),
        phase,
        hookIndex: index,
      });
    }
    if (pendingHooks.length > 0) {
      w.state = updateStep(w.state, stepName, {
        status: "running",
        phase: enginePhase,
        hookGroupIndex: groupIndex,
        pendingHooks,
        hookError: undefined,
      });
      return;
    }
  }

  // Phase exhausted with nothing dispatched — the caller's phase-done path
  // sees `pendingHooks` empty and `hookError` undefined.
  w.state = updateStep(w.state, stepName, {
    phase: enginePhase,
    hookGroupIndex: groups.length,
    pendingHooks: [],
    hookError: undefined,
  });
};

/** A hook phase finished (all groups settled or failed); advance the step. */
const afterHookPhase = (
  w: ClankerEngineWork,
  stepName: string,
  enginePhase: ClankerStepPhase & `hook-${string}`,
  hookError: string | undefined,
): void => {
  const step = w.state.stepsByName.get(stepName);
  const stepState = w.state.stepStates.get(stepName);
  // `status !== "running"` means hook dispatch already ended the step (an
  // fn-hook fail-fast) — nothing left to advance.
  if (step === undefined || stepState === undefined || stepState.status !== "running") return;

  if (enginePhase === "hook-before") {
    if (hookError !== undefined) {
      // Before-hook failure skips the attempt loop entirely: straight to
      // on_error hooks (best-effort), then terminal fail
      // (step-runner.ts:133-145 — `after` hooks do not run).
      w.state = updateStep(w.state, stepName, { error: hookError, failed: true });
      dispatchHookPhase(w, stepName, step, "hook-on-error", 0);
      const blocked = w.state.stepStates.get(stepName);
      if (blocked !== undefined && blocked.pendingHooks.length > 0) return;
      afterHookPhase(w, stepName, "hook-on-error", blocked?.hookError);
      return;
    }
    enterPromptPhase(w, stepName, step);
    return;
  }

  if (enginePhase === "hook-after") {
    // After-hook failures are ignored by Clanker; the attempt outcome decides.
    if (stepState.failed) {
      dispatchHookPhase(w, stepName, step, "hook-on-error", 0);
      const blocked = w.state.stepStates.get(stepName);
      if (blocked !== undefined && blocked.pendingHooks.length > 0) return;
      markTerminal(w, stepName, {
        status: "failed",
        error: stepState.error ?? "Step failed.",
      });
      return;
    }
    markTerminal(w, stepName, { status: "passed" });
    return;
  }

  // hook-on-error: best-effort phase; failures are ignored — the step fails.
  const errored = w.state.stepStates.get(stepName);
  markTerminal(w, stepName, {
    status: "failed",
    error: errored?.error ?? "Step failed.",
  });
};

const renderStepPrompts = (
  w: ClankerEngineWork,
  step: ClankerStep,
  stepState: ClankerStepRunState,
): { prompts?: ReadonlyArray<string>; error?: string } => {
  const rendered: string[] = [];
  for (const prompt of step.prompts ?? []) {
    let text: string;
    if ("file" in prompt) {
      const content = w.state.files[prompt.file];
      if (content === undefined) {
        return {
          error: `Prompt file '${prompt.file}' was not provided to the T3 Code runner.`,
        };
      }
      text = content;
    } else {
      text = prompt.text;
    }
    // Clanker only interpolates with an explicit `handlebars` engine — unset
    // and `none` both pass the text through untouched (prompt.ts:61-77).
    if (step.template_engine !== "handlebars") {
      rendered.push(text);
      continue;
    }
    const result = renderClankerTemplate(text, {
      ...refContext(w.state, step),
      values: { ...stepState.resolvedInputs, ...(prompt.context ?? {}) },
    });
    w.diagnostics.push(...result.diagnostics);
    rendered.push(result.text);
  }

  // Prompt suffix the CLI appends (prompt.ts:152-158). Skills stay ignored,
  // matching the warning parse.ts reports for them.
  const outputPaths = Object.values(step.outputs ?? {});
  if (step.output_format !== undefined && outputPaths.length > 0) {
    return {
      prompts: rendered.map(
        (prompt) =>
          `${prompt}\n${outputPaths
            .map(
              (outputPath) => `Save your response in ${step.output_format} format to ${outputPath}`,
            )
            .join("\n")}`,
      ),
    };
  }
  return { prompts: rendered };
};

const enterPromptPhase = (w: ClankerEngineWork, stepName: string, step: ClankerStep): void => {
  const stepState = w.state.stepStates.get(stepName);
  if (stepState === undefined) return;

  const rendered = renderStepPrompts(w, step, stepState);
  if (rendered.error !== undefined || rendered.prompts === undefined) {
    markTerminal(w, stepName, {
      status: "failed",
      error: rendered.error ?? "Failed to render prompts.",
    });
    return;
  }
  if (rendered.prompts.length === 0) {
    markTerminal(w, stepName, { status: "failed", error: "Step has no prompts to dispatch." });
    return;
  }

  const models = step.models ?? [{ id: "default" }];
  const pairs: ClankerPromptPair[] = [];
  for (let promptIndex = 0; promptIndex < rendered.prompts.length; promptIndex++) {
    const renderedPrompt = rendered.prompts[promptIndex];
    if (renderedPrompt === undefined) continue;
    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      const model = models[modelIndex];
      if (model === undefined) continue;
      pairs.push({ promptIndex, modelIndex, model, renderedPrompt });
    }
  }

  dispatchPairBatch(w, stepName, step, pairs, stepState.attempt);
};

/**
 * Emit the next batch of prompt x model pairs. Like Clanker's
 * `Promise.allSettled` batching in `executePromptStep`, the following batch
 * only dispatches once the whole current one has settled.
 */
const dispatchPairBatch = (
  w: ClankerEngineWork,
  stepName: string,
  step: ClankerStep,
  queue: ReadonlyArray<ClankerPromptPair>,
  attempt: number,
): void => {
  const cap = step.concurrency;
  const batch = queue.slice(0, cap ?? queue.length);
  const rest = queue.slice(batch.length);
  for (const pair of batch) {
    w.actions.push({
      type: "dispatchPrompt",
      stepName,
      attempt,
      promptIndex: pair.promptIndex,
      modelIndex: pair.modelIndex,
      renderedPrompt: pair.renderedPrompt,
      model: pair.model,
    });
  }
  w.state = updateStep(w.state, stepName, {
    status: "running",
    phase: "prompt",
    pendingPairs: batch.map(({ promptIndex, modelIndex }) => ({ promptIndex, modelIndex })),
    pairQueue: rest,
  });
};

const enterQaPhase = (w: ClankerEngineWork, stepName: string, step: ClankerStep): void => {
  const stepState = w.state.stepStates.get(stepName);
  if (stepState === undefined) return;

  const checks = step.qa?.checks ?? [];
  const check = checks[stepState.qaCheckIndex];
  if (check === undefined) {
    settleAttempt(w, stepName, step, undefined);
    return;
  }
  if (check.type !== "cmd") {
    markTerminal(w, stepName, {
      status: "failed",
      error: `QA check type '${check.type}' is not supported by the T3 Code runner.`,
    });
    return;
  }
  w.actions.push({
    type: "runCmd",
    stepName,
    attempt: stepState.attempt,
    kind: "qa",
    cmd: check.cmd,
    env: localEnv(w.state, step),
    checkIndex: stepState.qaCheckIndex,
  });
  w.state = updateStep(w.state, stepName, {
    status: "running",
    phase: "qa",
    pendingQaCheck: stepState.qaCheckIndex,
  });
};

/**
 * Attempt outcome, mirroring the retry loop in step-runner.ts: `continue`
 * coerces a failure to success without retrying, a retry re-runs the attempt
 * (escalation handlers would reshape it — v1-unsupported), and exhausting
 * `step.retry` fails the step. Both the passing and failing exits still run
 * `after` hooks; only the failing exit continues to `on_error` hooks.
 */
const settleAttempt = (
  w: ClankerEngineWork,
  stepName: string,
  step: ClankerStep,
  attemptError: { error: string; mode: "standard" | "retry-only" | "no-retry" } | undefined,
): void => {
  const stepState = w.state.stepStates.get(stepName);
  if (stepState === undefined) return;

  // Prompt-pair errors take precedence over QA errors (step-runner.ts:255-271).
  const error =
    stepState.attemptErrors.length > 0 ? stepState.attemptErrors.join("; ") : attemptError?.error;

  const qaOnFail = step.qa?.on_fail;
  // `mode` defaults to standard for prompt-pair failures (no QA error passed),
  // so `continue` coerces those too — Clanker applies it to any attempt failure.
  const mode = attemptError?.mode ?? "standard";
  const coerced = error !== undefined && mode === "standard" && qaOnFail === "continue";

  if (error === undefined || coerced) {
    w.state = updateStep(w.state, stepName, {
      attemptErrors: [],
      pendingQaCheck: undefined,
      error: coerced
        ? error
        : stepState.toleratedErrors.length > 0
          ? stepState.toleratedErrors.join("; ")
          : undefined,
      failed: false,
    });
    dispatchHookPhase(w, stepName, step, "hook-after", 0);
    const blocked = w.state.stepStates.get(stepName);
    if (blocked !== undefined && blocked.pendingHooks.length > 0) return;
    afterHookPhase(w, stepName, "hook-after", blocked?.hookError);
    return;
  }

  const maxRetries = step.retry ?? 0;
  const canRetry = mode !== "no-retry" && stepState.attempt < maxRetries && !stepState.failed;
  if (canRetry) {
    if ((step.qa?.escalate ?? []).length > 0) {
      markTerminal(w, stepName, {
        status: "failed",
        error: "Escalation handlers are not supported by the T3 Code runner.",
      });
      return;
    }
    // Clanker overwrites `lastAttempt` wholesale each retry
    // (step-runner.ts:162): the new attempt starts with empty
    // responses/outputs and only the final attempt's values persist.
    w.state = updateStep(w.state, stepName, {
      attempt: stepState.attempt + 1,
      pendingQaCheck: undefined,
      qaCheckIndex: 0,
      attemptErrors: [],
      toleratedErrors: [],
      responses: [],
      outputs: {},
      declaredOutputs: { ...(step.outputs ?? {}) },
      error: undefined,
    });
    enterPromptPhase(w, stepName, step);
    return;
  }

  w.state = updateStep(w.state, stepName, {
    pendingQaCheck: undefined,
    error,
    failed: true,
  });
  dispatchHookPhase(w, stepName, step, "hook-after", 0);
  const blocked = w.state.stepStates.get(stepName);
  if (blocked !== undefined && blocked.pendingHooks.length > 0) return;
  afterHookPhase(w, stepName, "hook-after", blocked?.hookError);
};

/**
 * Drive the current wave forward: dispatch the next batch of pending steps
 * once the previous batch is fully terminal, or close the wave — and the
 * run — when everything in it is terminal.
 */
const settleWave = (w: ClankerEngineWork): void => {
  if (w.state.status !== "running") return;

  const wave = currentWave(w.state);
  const statusOf = (name: string) => w.state.stepStates.get(name)?.status;
  const running = wave.some((name) => statusOf(name) === "running");
  const pending = wave.filter((name) => statusOf(name) === "pending");

  // Clanker batches a wave by `defaults.concurrency`: the next batch starts
  // only once every dispatched step is terminal, so a quick step finishing
  // early does not pull a queued one forward (wave-executor.ts:114-124).
  if (!running && pending.length > 0) {
    const cap = w.state.workflow.defaults?.concurrency;
    const batch = pending.slice(0, cap ?? pending.length);
    for (const name of batch) {
      beginStep(w, name);
    }
    settleWave(w);
    return;
  }

  if (running || pending.length > 0) return;

  // Wave fully settled. A failed step fails the run here — later waves never
  // start and their steps stay `pending` (workflow-runner.ts:249-252).
  if (wave.some((name) => statusOf(name) === "failed")) {
    finishRun(w, "failed");
    return;
  }

  const waveIndex = w.state.waveIndex + 1;
  if (waveIndex >= w.state.waves.length) {
    finishRun(w, "completed");
    return;
  }

  w.state = { ...w.state, waveIndex };
  enterWave(w);
  settleWave(w);
};

const beginStep = (w: ClankerEngineWork, stepName: string): void => {
  const step = w.state.stepsByName.get(stepName);
  const stepState = w.state.stepStates.get(stepName);
  if (step === undefined || stepState === undefined) return;

  const failFast = (error: string): void => {
    w.state = updateStep(w.state, stepName, { status: "running" });
    markTerminal(w, stepName, { status: "failed", error });
  };

  // Unsupported execution constructs fail fast, consistent with the
  // `unsupported` diagnostics parse.ts reports for the same fields.
  if (step.conditions !== undefined || step.conditions_mode !== undefined) {
    failFast(
      "Step conditions (conditions/conditions_mode) are not supported by the T3 Code runner.",
    );
    return;
  }

  if (step.condition !== undefined) {
    const result = evalClankerCondition(step.condition, refContext(w.state, step));
    if (result === undefined) {
      failFast(
        `Cannot evaluate condition '${step.condition}' with the T3 Code runner's expression subset.`,
      );
      return;
    }
    if (!result) {
      w.state = updateStep(w.state, stepName, { status: "running" });
      markTerminal(w, stepName, {
        status: "skipped",
        reason: `Condition '${step.condition}' evaluated to false.`,
      });
      return;
    }
  }

  if (step.workflow !== undefined) {
    failFast("Sub-workflows are not supported by the T3 Code runner.");
    return;
  }
  if (step.run !== undefined) {
    failFast("run steps are not supported by the T3 Code runner.");
    return;
  }
  if (step.agent !== undefined) {
    failFast("Agent definition files are not supported by the T3 Code runner.");
    return;
  }
  if (step.template_engine === "jinja2") {
    failFast("The jinja2 template engine is not supported; use handlebars or none.");
    return;
  }
  if (step.prompts === undefined) {
    failFast("prompts is required unless agent, workflow, or run is present.");
    return;
  }
  for (const check of step.qa?.checks ?? []) {
    if (check.type !== "cmd") {
      failFast(`QA check type '${check.type}' is not supported by the T3 Code runner.`);
      return;
    }
  }

  // Inputs resolve once per step like Clanker's resolveInputs; a missing ref
  // fails the step fast with a clear diagnostic rather than rendering "".
  const resolvedInputs: Record<string, unknown> = {};
  const ctx = refContext(w.state, step);
  for (const [key, ref] of Object.entries(step.inputs ?? {})) {
    const resolved = resolveClankerRef(ref, ctx);
    if (resolved === undefined) {
      failFast(`Cannot resolve input '${key}': reference '${ref}' is missing.`);
      return;
    }
    resolvedInputs[key] = resolved;
  }

  w.state = updateStep(w.state, stepName, {
    status: "running",
    resolvedInputs,
    declaredOutputs: { ...(step.outputs ?? {}) },
  });

  dispatchHookPhase(w, stepName, step, "hook-before", 0);
  const blocked = w.state.stepStates.get(stepName);
  if (blocked === undefined) return;
  if (blocked.pendingHooks.length > 0) return;
  if (blocked.hookError !== undefined) {
    afterHookPhase(w, stepName, "hook-before", blocked.hookError);
    return;
  }
  if (blocked.phase === "hook-before") {
    // No before hooks at all — dispatchHookPhase walked off the end.
    enterPromptPhase(w, stepName, step);
  }
};

export function startClankerRun(
  workflow: ClankerWorkflow,
  options: ClankerEngineStartOptions = {},
): ClankerEngineTransition {
  const merged = applyClankerWorkflowDefaults(workflow);
  const stepsByName = new Map<string, ClankerStep>();
  const stepStates = new Map<string, ClankerStepRunState>();
  for (const step of merged.steps) {
    if (stepsByName.has(step.name)) continue;
    stepsByName.set(step.name, step);
    stepStates.set(step.name, pendingStepRunState(step.outputs ?? {}));
  }

  const restoredByName = new Map<string, ClankerRestoredStep>();
  for (const restored of options.restoredSteps ?? []) {
    if (stepStates.has(restored.name)) restoredByName.set(restored.name, restored);
  }

  const stepOutputs = new Map<string, ReadonlyMap<string, string>>();
  for (const restored of restoredByName.values()) {
    // Restored outputs hydrate the template context for the entire run,
    // matching hydrateContextFromRunState in workflow-runner.ts.
    stepOutputs.set(restored.name, new Map(Object.entries(restored.outputs ?? {})));
  }

  const wavesResult = buildClankerWaves(merged.steps);
  const w = work({
    workflow: merged,
    stepsByName,
    waves: wavesResult.waves,
    stepStates,
    status: "running",
    stepOutputs,
    waveIndex: 0,
    env: options.env ?? {},
    files: options.files ?? {},
    resumeGateOpen: options.startFromStep === undefined,
    startFromStep: options.startFromStep,
    restoredByName,
  });
  w.diagnostics.push(...wavesResult.diagnostics);

  const blocking = wavesResult.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  if (blocking || wavesResult.waves.length === 0) {
    const message =
      wavesResult.waves.length === 0 && !blocking
        ? "No executable steps. Check your depends_on configuration."
        : wavesResult.diagnostics
            .filter((diagnostic) => diagnostic.severity === "error")
            .map((diagnostic) => diagnostic.message)
            .join("; ");
    w.diagnostics.push({ severity: "error", message });
    finishRun(w, "failed");
    return done(w);
  }

  enterWave(w);
  settleWave(w);
  return done(w);
}

export interface ClankerPromptSettledEvent {
  readonly stepName: string;
  readonly attempt: number;
  readonly promptIndex: number;
  readonly modelIndex: number;
  /** Provider response text; absent when `error` is set. */
  readonly response?: string | undefined;
  /** Pair-level failure (nonzero exit, turn error); the pair counts as failed. */
  readonly error?: string | undefined;
  /** Outputs the server verified for this pair, merged into the step's outputs. */
  readonly outputs?: Readonly<Record<string, string>> | undefined;
}

export function clankerPromptSettled(
  state: ClankerEngineState,
  event: ClankerPromptSettledEvent,
): ClankerEngineTransition {
  const w = work(state);
  const step = state.stepsByName.get(event.stepName);
  const stepState = state.stepStates.get(event.stepName);
  if (
    state.status !== "running" ||
    step === undefined ||
    stepState === undefined ||
    stepState.status !== "running" ||
    stepState.phase !== "prompt" ||
    stepState.attempt !== event.attempt
  ) {
    return done(w);
  }

  const pendingIndex = stepState.pendingPairs.findIndex(
    (pair) => pair.promptIndex === event.promptIndex && pair.modelIndex === event.modelIndex,
  );
  if (pendingIndex === -1) return done(w);

  const pendingPairs = stepState.pendingPairs.filter((_, index) => index !== pendingIndex);
  const attemptErrors =
    event.error !== undefined ? [...stepState.attemptErrors, event.error] : stepState.attemptErrors;
  const model = step.models?.[event.modelIndex] ?? { id: "default" };
  const responses =
    event.error === undefined
      ? [
          ...stepState.responses,
          { prompt_index: event.promptIndex, model_id: model.id, response: event.response ?? "" },
        ]
      : stepState.responses;
  const outputs = { ...stepState.outputs, ...(event.outputs ?? {}) };

  w.state = updateStep(w.state, event.stepName, {
    pendingPairs,
    attemptErrors,
    responses,
    outputs,
  });

  if (pendingPairs.length > 0) return done(w);

  const queue = w.state.stepStates.get(event.stepName)?.pairQueue ?? [];
  if (queue.length > 0) {
    dispatchPairBatch(w, event.stepName, step, queue, event.attempt);
    return done(w);
  }

  // All pairs settled — QA checks run next, even when pairs failed
  // (step-runner.ts:249-253 runs them before reading runResult.success).
  w.state = updateStep(w.state, event.stepName, { phase: "qa", qaCheckIndex: 0 });
  enterQaPhase(w, event.stepName, step);
  settleWave(w);
  return done(w);
}

export interface ClankerCmdHookSettledEvent {
  readonly stepName: string;
  readonly attempt: number;
  readonly phase: ClankerHookPhase;
  readonly hookIndex: number;
  /** `null` when the process never produced an exit code (spawn failure, signal). */
  readonly exitCode: number | null;
  readonly error?: string | undefined;
}

export function clankerCmdHookSettled(
  state: ClankerEngineState,
  event: ClankerCmdHookSettledEvent,
): ClankerEngineTransition {
  const w = work(state);
  const stepState = state.stepStates.get(event.stepName);
  const step = state.stepsByName.get(event.stepName);
  const enginePhase = ENGINE_PHASE_BY_HOOK[event.phase];
  if (
    state.status !== "running" ||
    step === undefined ||
    stepState === undefined ||
    stepState.status !== "running" ||
    stepState.phase !== enginePhase ||
    stepState.attempt !== event.attempt ||
    !stepState.pendingHooks.includes(event.hookIndex)
  ) {
    return done(w);
  }

  const pendingHooks = stepState.pendingHooks.filter((index) => index !== event.hookIndex);
  const failed = event.exitCode !== 0 || event.error !== undefined;
  const hookError =
    failed && stepState.hookError === undefined
      ? (event.error ?? `Hook ${event.hookIndex} exited with code ${event.exitCode ?? "unknown"}.`)
      : stepState.hookError;
  w.state = updateStep(w.state, event.stepName, { pendingHooks, hookError });
  if (pendingHooks.length > 0) {
    // The rest of the parallel group still settles; the outcome is read once
    // the group drains (allSettled within a group, fail at its boundary —
    // hooks.ts:53-87).
    return done(w);
  }

  const settledState = w.state.stepStates.get(event.stepName);
  // on_error is best-effort: every group still dispatches after a hook
  // error (hooks.ts:48 — `bestEffort` skips the early return). Other
  // phases stop at the first failed group.
  if (settledState?.hookError === undefined || enginePhase === "hook-on-error") {
    dispatchHookPhase(
      w,
      event.stepName,
      step,
      enginePhase,
      (settledState?.hookGroupIndex ?? -1) + 1,
    );
  }
  const after = w.state.stepStates.get(event.stepName);
  if (after !== undefined && after.pendingHooks.length > 0) return done(w);
  afterHookPhase(w, event.stepName, enginePhase, after?.hookError);
  settleWave(w);
  return done(w);
}

export interface ClankerQaCheckSettledEvent {
  readonly stepName: string;
  readonly attempt: number;
  readonly checkIndex: number;
  readonly exitCode: number | null;
  readonly error?: string | undefined;
}

export function clankerQaCheckSettled(
  state: ClankerEngineState,
  event: ClankerQaCheckSettledEvent,
): ClankerEngineTransition {
  const w = work(state);
  const step = state.stepsByName.get(event.stepName);
  const stepState = state.stepStates.get(event.stepName);
  if (
    state.status !== "running" ||
    step === undefined ||
    stepState === undefined ||
    stepState.status !== "running" ||
    stepState.phase !== "qa" ||
    stepState.attempt !== event.attempt ||
    stepState.pendingQaCheck !== event.checkIndex
  ) {
    return done(w);
  }

  const check = step.qa?.checks?.[event.checkIndex];
  const passed = event.exitCode === 0 && event.error === undefined;
  const nextIndex = stepState.qaCheckIndex + 1;
  w.state = updateStep(w.state, event.stepName, { pendingQaCheck: undefined });

  if (passed) {
    w.state = updateStep(w.state, event.stepName, { qaCheckIndex: nextIndex });
    enterQaPhase(w, event.stepName, step);
    settleWave(w);
    return done(w);
  }

  const error =
    event.error ?? `QA check ${event.checkIndex} exited with code ${event.exitCode ?? "unknown"}.`;

  switch (check?.on_fail) {
    case "continue": {
      w.state = updateStep(w.state, event.stepName, {
        qaCheckIndex: nextIndex,
        toleratedErrors: [...stepState.toleratedErrors, error],
      });
      enterQaPhase(w, event.stepName, step);
      settleWave(w);
      return done(w);
    }
    case "escalate": {
      markTerminal(w, event.stepName, {
        status: "failed",
        error: "Escalation handlers are not supported by the T3 Code runner.",
      });
      settleWave(w);
      return done(w);
    }
    case "rerun": {
      settleAttempt(w, event.stepName, step, { error, mode: "retry-only" });
      settleWave(w);
      return done(w);
    }
    case "abort": {
      settleAttempt(w, event.stepName, step, { error, mode: "no-retry" });
      settleWave(w);
      return done(w);
    }
    default: {
      settleAttempt(w, event.stepName, step, { error, mode: "standard" });
      settleWave(w);
      return done(w);
    }
  }
}

export interface ClankerStepFailedEvent {
  readonly stepName: string;
  readonly attempt: number;
  readonly reason: string;
}

/**
 * A hard failure reported by the driver (turn aborted, spawn error). Matches
 * Clanker's exception path (wave-executor.ts:67-79): the step fails without
 * entering the retry loop — a failure during `before` hooks still gets its
 * `on_error` hooks first.
 */
export function clankerStepFailed(
  state: ClankerEngineState,
  event: ClankerStepFailedEvent,
): ClankerEngineTransition {
  const w = work(state);
  const step = state.stepsByName.get(event.stepName);
  const stepState = state.stepStates.get(event.stepName);
  if (
    state.status !== "running" ||
    step === undefined ||
    stepState === undefined ||
    stepState.status !== "running" ||
    stepState.attempt !== event.attempt
  ) {
    return done(w);
  }

  if (stepState.phase === "hook-before") {
    w.state = updateStep(w.state, event.stepName, { error: event.reason, failed: true });
    dispatchHookPhase(w, event.stepName, step, "hook-on-error", 0);
    const blocked = w.state.stepStates.get(event.stepName);
    if (blocked !== undefined && blocked.pendingHooks.length > 0) return done(w);
    markTerminal(w, event.stepName, { status: "failed", error: event.reason });
    settleWave(w);
    return done(w);
  }

  // During the hook phases the step can already carry its original error
  // (a failed attempt runs after/on_error hooks before failing). Clanker
  // reports the step's own error — hook outcomes never overwrite it —
  // so a driver failure here keeps the first error.
  markTerminal(w, event.stepName, {
    status: "failed",
    error: stepState.error ?? event.reason,
  });
  settleWave(w);
  return done(w);
}

/**
 * Mark the run cancelled. In-flight attempts stay `running` in the snapshot —
 * the server cancels their turns — and no further actions are emitted beyond
 * the terminal `runCompleted`.
 */
export function cancelClankerRun(state: ClankerEngineState): ClankerEngineTransition {
  const w = work(state);
  if (w.state.status !== "running") return done(w);
  finishRun(w, "cancelled");
  return done(w);
}

export interface ClankerPersistedMeta {
  readonly runId: string;
  readonly workflowPath?: string | undefined;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/**
 * Snapshot the engine into the persisted run-state artifact shape. Steps that
 * never left `pending` are included (unlike Clanker's state.json, which only
 * records steps it touched) so consumers see the full plan; every field still
 * satisfies `ClankerPersistedRunState` in `runState.ts`.
 */
export function clankerRunToPersistedState(
  state: ClankerEngineState,
  meta: ClankerPersistedMeta,
): ClankerPersistedRunState {
  const steps: Record<string, ClankerStepState> = {};
  for (const wave of state.waves) {
    for (const name of wave) {
      const stepState = state.stepStates.get(name);
      if (stepState === undefined) continue;
      steps[name] = {
        status: stepState.status,
        retryCount: stepState.attempt,
        responses: [...stepState.responses],
        declaredOutputs: { ...stepState.declaredOutputs },
        outputs: { ...stepState.outputs },
        ...(stepState.error !== undefined ? { error: stepState.error } : {}),
      };
    }
  }
  return {
    runId: meta.runId,
    workflowName: state.workflow.name,
    ...(meta.workflowPath !== undefined ? { workflowPath: meta.workflowPath } : {}),
    startedAt: meta.startedAt,
    updatedAt: meta.updatedAt,
    status: state.status,
    steps,
  };
}
