import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { ClankerWorkflow } from "./format.ts";
import { ClankerPersistedRunState } from "./runState.ts";
import {
  cancelClankerRun,
  clankerCmdHookSettled,
  clankerPromptSettled,
  clankerQaCheckSettled,
  clankerRunToPersistedState,
  clankerStepFailed,
  startClankerRun,
  type ClankerEngineAction,
  type ClankerEngineTransition,
} from "./runner.ts";

const decodePersistedRunState = Schema.decodeSync(ClankerPersistedRunState);

const workflow = (steps: ClankerWorkflow["steps"], defaults?: ClankerWorkflow["defaults"]) =>
  ({
    name: "test-workflow",
    version: "1.0.0",
    ...(defaults !== undefined ? { defaults } : {}),
    steps,
  }) satisfies ClankerWorkflow;

const promptStep = (name: string, extra: Partial<ClankerWorkflow["steps"][number]> = {}) => ({
  name,
  prompts: [{ text: `prompt for ${name}` }],
  ...extra,
});

const dispatches = (actions: ReadonlyArray<ClankerEngineAction>) =>
  actions.filter((action) => action.type === "dispatchPrompt" || action.type === "runCmd");

const actionsOfType = <T extends ClankerEngineAction["type"]>(
  actions: ReadonlyArray<ClankerEngineAction>,
  type: T,
) =>
  actions.filter(
    (action): action is Extract<ClankerEngineAction, { type: T }> => action.type === type,
  );

/** Settle every currently-pending prompt pair; only newly emitted actions are collected. */
const settleAllPrompts = (
  transition: ClankerEngineTransition,
  response = "ok",
): ClankerEngineTransition => {
  let state = transition.state;
  const actions: ClankerEngineAction[] = [];
  const diagnostics: Array<ClankerEngineTransition["diagnostics"][number]> = [];
  for (const [stepName, stepState] of state.stepStates) {
    if (stepState.status !== "running" || stepState.phase !== "prompt") continue;
    for (const pair of stepState.pendingPairs) {
      const next = clankerPromptSettled(state, {
        stepName,
        attempt: stepState.attempt,
        promptIndex: pair.promptIndex,
        modelIndex: pair.modelIndex,
        response,
      });
      state = next.state;
      actions.push(...next.actions);
      diagnostics.push(...next.diagnostics);
    }
  }
  return { state, actions, diagnostics };
};

/** Drive a run forward, succeeding every pending prompt, hook, and QA check. */
const runToCompletion = (
  transition: ClankerEngineTransition,
  response = "ok",
): ClankerEngineTransition => {
  let state = transition.state;
  const actions: ClankerEngineAction[] = [];
  const diagnostics: Array<ClankerEngineTransition["diagnostics"][number]> = [];
  const apply = (next: ClankerEngineTransition) => {
    state = next.state;
    actions.push(...next.actions);
    diagnostics.push(...next.diagnostics);
  };
  for (let guard = 0; guard < 200 && state.status === "running"; guard++) {
    let progressed = false;
    for (const [stepName, stepState] of state.stepStates) {
      if (stepState.status !== "running") continue;
      if (stepState.phase === "prompt" && stepState.pendingPairs.length > 0) {
        const pair = stepState.pendingPairs[0];
        if (pair === undefined) continue;
        apply(
          clankerPromptSettled(state, {
            stepName,
            attempt: stepState.attempt,
            promptIndex: pair.promptIndex,
            modelIndex: pair.modelIndex,
            response,
          }),
        );
        progressed = true;
        break;
      }
      if (stepState.phase === "qa" && stepState.pendingQaCheck !== undefined) {
        apply(
          clankerQaCheckSettled(state, {
            stepName,
            attempt: stepState.attempt,
            checkIndex: stepState.pendingQaCheck,
            exitCode: 0,
          }),
        );
        progressed = true;
        break;
      }
      if (
        (stepState.phase === "hook-before" ||
          stepState.phase === "hook-after" ||
          stepState.phase === "hook-on-error") &&
        stepState.pendingHooks.length > 0
      ) {
        const hookIndex = stepState.pendingHooks[0];
        const phase =
          stepState.phase === "hook-before"
            ? "before"
            : stepState.phase === "hook-after"
              ? "after"
              : "on_error";
        if (hookIndex === undefined) continue;
        apply(
          clankerCmdHookSettled(state, {
            stepName,
            attempt: stepState.attempt,
            phase,
            hookIndex,
            exitCode: 0,
          }),
        );
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return { state, actions, diagnostics };
};

describe("startClankerRun", () => {
  it("dispatches wave 0 steps and advances waves in order", () => {
    const wf = workflow([
      promptStep("a"),
      promptStep("b", { depends_on: ["a"] }),
      promptStep("c", { depends_on: ["b"] }),
    ]);

    const started = startClankerRun(wf);
    expect(started.state.waves).toEqual([["a"], ["b"], ["c"]]);
    expect(dispatches(started.actions)).toMatchObject([
      { type: "dispatchPrompt", stepName: "a", attempt: 0 },
    ]);

    const aSettled = settleAllPrompts(started);
    expect(actionsOfType(aSettled.actions, "stepPassed")).toHaveLength(1);
    expect(dispatches(aSettled.actions)).toMatchObject([{ type: "dispatchPrompt", stepName: "b" }]);

    const bSettled = settleAllPrompts(aSettled);
    expect(dispatches(bSettled.actions)).toMatchObject([{ type: "dispatchPrompt", stepName: "c" }]);

    const cSettled = settleAllPrompts(bSettled);
    expect(cSettled.state.status).toBe("completed");
    const completed = actionsOfType(cSettled.actions, "runCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.result.success).toBe(true);
  });

  it("dispatches every step of a wave in parallel", () => {
    const started = startClankerRun(workflow([promptStep("a"), promptStep("b")]));
    expect(dispatches(started.actions)).toMatchObject([{ stepName: "a" }, { stepName: "b" }]);
  });

  it("batches wave steps by defaults.concurrency", () => {
    const started = startClankerRun(
      workflow([promptStep("a"), promptStep("b"), promptStep("c")], { concurrency: 2 }),
    );
    expect(dispatches(started.actions)).toHaveLength(2);

    const aSettled = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      response: "ok",
    });
    // Clanker batches: the third step waits for the whole first batch.
    expect(dispatches(aSettled.actions).filter((a) => a.stepName === "c")).toHaveLength(0);

    const bSettled = clankerPromptSettled(aSettled.state, {
      stepName: "b",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      response: "ok",
    });
    expect(dispatches(bSettled.actions).filter((a) => a.stepName === "c")).toHaveLength(1);
  });

  it("fails the run immediately when the DAG has errors", () => {
    const wf = workflow([
      promptStep("a", { depends_on: ["b"] }),
      promptStep("b", { depends_on: ["a"] }),
    ]);
    const started = startClankerRun(wf);
    expect(started.state.status).toBe("failed");
    expect(actionsOfType(started.actions, "runCompleted")).toHaveLength(1);
    expect(started.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("conditions", () => {
  it("skips a step when its condition evaluates falsy and keeps dependents running", () => {
    const wf = workflow([
      promptStep("a", { condition: "env.MISSING_VAR" }),
      promptStep("b", { depends_on: ["a"] }),
    ]);
    const started = startClankerRun(wf, { env: {} });
    expect(actionsOfType(started.actions, "stepSkipped")).toMatchObject([{ stepName: "a" }]);
    expect(dispatches(started.actions)).toMatchObject([{ type: "dispatchPrompt", stepName: "b" }]);
    expect(started.state.stepStates.get("a")?.status).toBe("skipped");
  });

  it("runs the step when its condition evaluates truthy", () => {
    const wf = workflow([promptStep("a", { condition: "env.FLAG == 'yes'" })]);
    const started = startClankerRun(wf, { env: { FLAG: "yes" } });
    expect(dispatches(started.actions)).toHaveLength(1);
  });

  it("fails the step on an unevaluable condition", () => {
    const wf = workflow([promptStep("a", { condition: "a == b" })]);
    const started = startClankerRun(wf);
    expect(started.state.stepStates.get("a")?.status).toBe("failed");
    expect(started.state.status).toBe("failed");
    expect(actionsOfType(started.actions, "stepFailed")[0]?.error).toContain(
      "Cannot evaluate condition",
    );
  });
});

describe("prompt x model queue", () => {
  it("dispatches the full prompt x model matrix and records responses", () => {
    const wf = workflow([
      promptStep("a", {
        models: [{ id: "m1" }, { id: "m2" }],
        prompts: [{ text: "p0" }, { text: "p1" }],
      }),
    ]);
    const started = startClankerRun(wf);
    const promptActions = actionsOfType(started.actions, "dispatchPrompt");
    expect(promptActions).toHaveLength(4);
    expect(promptActions.map((a) => [a.promptIndex, a.modelIndex, a.model.id])).toEqual([
      [0, 0, "m1"],
      [0, 1, "m2"],
      [1, 0, "m1"],
      [1, 1, "m2"],
    ]);

    const settled = settleAllPrompts(started);
    expect(settled.state.stepStates.get("a")?.status).toBe("passed");
    expect(settled.state.stepStates.get("a")?.responses).toHaveLength(4);
    expect(settled.state.status).toBe("completed");
  });

  it("batches pairs by step.concurrency", () => {
    const wf = workflow([
      promptStep("a", {
        concurrency: 1,
        prompts: [{ text: "p0" }, { text: "p1" }],
      }),
    ]);
    const started = startClankerRun(wf);
    expect(actionsOfType(started.actions, "dispatchPrompt")).toHaveLength(1);

    const first = settleAllPrompts(started);
    expect(actionsOfType(first.actions, "dispatchPrompt")).toMatchObject([{ promptIndex: 1 }]);
    const second = settleAllPrompts(first);
    expect(second.state.status).toBe("completed");
  });

  it("renders handlebars prompts against env, inputs, and step outputs", () => {
    const wf = workflow([
      promptStep("a", { outputs: { artifact: "out.txt" } }),
      promptStep("b", {
        depends_on: ["a"],
        template_engine: "handlebars",
        inputs: { who: "env.WHO" },
        prompts: [{ text: "hello {{who}} got {{steps.a.outputs.artifact}}" }],
      }),
    ]);
    const started = startClankerRun(wf, { env: { WHO: "world" } });
    // Verified outputs arrive on the settle event (the server checks the
    // declared paths), matching Clanker's verifyOutputs.
    const aSettled = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      response: "done",
      outputs: { artifact: "out.txt" },
    });
    const bPrompt = actionsOfType(aSettled.actions, "dispatchPrompt")[0];
    expect(bPrompt?.stepName).toBe("b");
    expect(bPrompt?.renderedPrompt).toBe("hello world got out.txt");
  });

  it("fails fast when an input reference is missing", () => {
    const wf = workflow([promptStep("a", { inputs: { who: "env.NOPE" } })]);
    const started = startClankerRun(wf, { env: {} });
    expect(started.state.stepStates.get("a")?.status).toBe("failed");
    expect(started.state.status).toBe("failed");
  });
});

describe("retries", () => {
  it("re-dispatches the attempt while retryCount < step.retry", () => {
    const wf = workflow([promptStep("a", { retry: 1 })]);
    const started = startClankerRun(wf);
    const dispatch = actionsOfType(started.actions, "dispatchPrompt")[0];
    if (dispatch === undefined) throw new Error("expected a dispatch");

    const failed = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      error: "turn blew up",
    });
    expect(actionsOfType(failed.actions, "dispatchPrompt")).toMatchObject([{ attempt: 1 }]);
    expect(failed.state.stepStates.get("a")?.attempt).toBe(1);

    const settled = settleAllPrompts(failed);
    expect(settled.state.stepStates.get("a")?.status).toBe("passed");
    expect(settled.state.status).toBe("completed");
    const persisted = clankerRunToPersistedState(settled.state, {
      runId: "r1",
      startedAt: "t",
      updatedAt: "t",
    });
    expect(persisted.steps["a"]?.retryCount).toBe(1);
  });

  it("fails the step when retries are exhausted", () => {
    const wf = workflow([promptStep("a", { retry: 0 })]);
    const started = startClankerRun(wf);
    const failed = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      error: "nope",
    });
    expect(failed.state.stepStates.get("a")?.status).toBe("failed");
    expect(failed.state.status).toBe("failed");
  });

  it("resets responses and outputs on retry — only the final attempt persists", () => {
    const wf = workflow([
      promptStep("a", {
        retry: 1,
        outputs: { artifact: "out.txt" },
        qa: { checks: [{ type: "cmd", cmd: "check" }] },
      }),
    ]);
    const started = startClankerRun(wf);
    const prompted = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      response: "first",
      outputs: { artifact: "out.txt" },
    });
    expect(prompted.state.stepStates.get("a")?.responses).toHaveLength(1);
    expect(prompted.state.stepStates.get("a")?.outputs).toEqual({ artifact: "out.txt" });

    // QA fails -> retry. Clanker overwrites `lastAttempt` wholesale each
    // retry, so the new attempt starts empty.
    const retried = clankerQaCheckSettled(prompted.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 0,
      exitCode: 1,
    });
    expect(dispatches(retried.actions)).toMatchObject([
      { type: "dispatchPrompt", stepName: "a", attempt: 1 },
    ]);
    expect(retried.state.stepStates.get("a")?.responses).toHaveLength(0);
    expect(retried.state.stepStates.get("a")?.outputs).toEqual({});

    const settled = clankerPromptSettled(retried.state, {
      stepName: "a",
      attempt: 1,
      promptIndex: 0,
      modelIndex: 0,
      response: "second",
      outputs: { artifact: "out.txt" },
    });
    const checked = clankerQaCheckSettled(settled.state, {
      stepName: "a",
      attempt: 1,
      checkIndex: 0,
      exitCode: 0,
    });
    expect(checked.state.stepStates.get("a")?.status).toBe("passed");
    expect(checked.state.stepStates.get("a")?.responses).toEqual([
      { prompt_index: 0, model_id: "default", response: "second" },
    ]);
  });
});

describe("QA checks", () => {
  const qaStep = (extra: Partial<ClankerWorkflow["steps"][number]>) => promptStep("a", extra);

  const runToFirstCheck = (step: ClankerWorkflow["steps"][number]) => {
    const started = startClankerRun(workflow([step]));
    const settled = settleAllPrompts(started);
    return { started, settled };
  };

  it("dispatches cmd checks after prompts and fails the step on nonzero exit", () => {
    const { settled } = runToFirstCheck(
      qaStep({ qa: { checks: [{ type: "cmd", cmd: "test -f out" }] } }),
    );
    expect(dispatches(settled.actions)).toMatchObject([
      { type: "runCmd", kind: "qa", cmd: "test -f out", checkIndex: 0 },
    ]);
    const failed = clankerQaCheckSettled(settled.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 0,
      exitCode: 1,
    });
    expect(failed.state.stepStates.get("a")?.status).toBe("failed");
    expect(failed.state.status).toBe("failed");
  });

  it("runs QA even when the prompts failed", () => {
    const wf = workflow([qaStep({ qa: { checks: [{ type: "cmd", cmd: "check" }] } })]);
    const started = startClankerRun(wf);
    const failed = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      error: "turn died",
    });
    expect(dispatches(failed.actions)).toMatchObject([{ type: "runCmd", kind: "qa" }]);
  });

  it("coerces failures to success with step-level qa.on_fail continue", () => {
    const { settled } = runToFirstCheck(
      qaStep({ qa: { on_fail: "continue", checks: [{ type: "cmd", cmd: "check" }] } }),
    );
    const after = clankerQaCheckSettled(settled.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 0,
      exitCode: 1,
    });
    expect(after.state.stepStates.get("a")?.status).toBe("passed");
    expect(after.state.status).toBe("completed");
    expect(after.state.stepStates.get("a")?.error).toContain("exited with code 1");
  });

  it("tolerates a single failed check with check-level on_fail continue", () => {
    const { settled } = runToFirstCheck(
      qaStep({
        qa: {
          checks: [
            { type: "cmd", cmd: "soft", on_fail: "continue" },
            { type: "cmd", cmd: "hard" },
          ],
        },
      }),
    );
    const tolerated = clankerQaCheckSettled(settled.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 0,
      exitCode: 1,
    });
    // The second check still runs after the tolerated failure.
    expect(dispatches(tolerated.actions)).toMatchObject([
      { type: "runCmd", kind: "qa", checkIndex: 1 },
    ]);
    const done = clankerQaCheckSettled(tolerated.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 1,
      exitCode: 0,
    });
    expect(done.state.stepStates.get("a")?.status).toBe("passed");
  });

  it("reruns the attempt on check-level on_fail rerun, within the retry budget", () => {
    const { settled } = runToFirstCheck(
      qaStep({
        retry: 1,
        qa: { checks: [{ type: "cmd", cmd: "check", on_fail: "rerun" }] },
      }),
    );
    const reran = clankerQaCheckSettled(settled.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 0,
      exitCode: 1,
    });
    expect(dispatches(reran.actions)).toMatchObject([
      { type: "dispatchPrompt", stepName: "a", attempt: 1 },
    ]);
  });

  it("fails without retrying on check-level on_fail abort, even with budget left", () => {
    const { settled } = runToFirstCheck(
      qaStep({
        retry: 3,
        qa: { checks: [{ type: "cmd", cmd: "check", on_fail: "abort" }] },
      }),
    );
    const aborted = clankerQaCheckSettled(settled.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 0,
      exitCode: 1,
    });
    expect(aborted.state.stepStates.get("a")?.status).toBe("failed");
    expect(aborted.state.status).toBe("failed");
    expect(dispatches(aborted.actions)).toHaveLength(0);
  });

  it("fails the step on check-level on_fail escalate (v1-unsupported)", () => {
    const { settled } = runToFirstCheck(
      qaStep({
        qa: { checks: [{ type: "cmd", cmd: "check", on_fail: "escalate" }] },
      }),
    );
    const escalated = clankerQaCheckSettled(settled.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 0,
      exitCode: 1,
    });
    expect(escalated.state.stepStates.get("a")?.status).toBe("failed");
    expect(actionsOfType(escalated.actions, "stepFailed")[0]?.error).toContain(
      "Escalation handlers are not supported",
    );
  });

  it("fails retries that would escalate via qa.escalate handlers", () => {
    const wf = workflow([
      qaStep({
        retry: 2,
        qa: { escalate: [{ type: "AI", prompt: "try harder" }] },
      }),
    ]);
    const started = startClankerRun(wf);
    const failed = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      error: "bad turn",
    });
    expect(failed.state.stepStates.get("a")?.status).toBe("failed");
    expect(actionsOfType(failed.actions, "stepFailed")[0]?.error).toContain(
      "Escalation handlers are not supported",
    );
  });

  it("runs QA checks sequentially and passes the step when all pass", () => {
    const { settled } = runToFirstCheck(
      qaStep({
        qa: {
          checks: [
            { type: "cmd", cmd: "one" },
            { type: "cmd", cmd: "two" },
          ],
        },
      }),
    );
    expect(dispatches(settled.actions)).toMatchObject([{ checkIndex: 0 }]);
    const second = clankerQaCheckSettled(settled.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 0,
      exitCode: 0,
    });
    expect(dispatches(second.actions)).toMatchObject([{ checkIndex: 1 }]);
    const done = clankerQaCheckSettled(second.state, {
      stepName: "a",
      attempt: 0,
      checkIndex: 1,
      exitCode: 0,
    });
    expect(done.state.stepStates.get("a")?.status).toBe("passed");
  });
});

describe("hooks", () => {
  it("runs before hooks ahead of prompts", () => {
    const wf = workflow([promptStep("a", { hooks: { before: [{ cmd: "setup" }] } })]);
    const started = startClankerRun(wf);
    expect(dispatches(started.actions)).toMatchObject([
      { type: "runCmd", kind: "hook", phase: "before", hookIndex: 0, cmd: "setup" },
    ]);
    const hooked = clankerCmdHookSettled(started.state, {
      stepName: "a",
      attempt: 0,
      phase: "before",
      hookIndex: 0,
      exitCode: 0,
    });
    expect(dispatches(hooked.actions)).toMatchObject([{ type: "dispatchPrompt" }]);
  });

  it("runs on_error hooks then fails when a before hook fails", () => {
    const wf = workflow([
      promptStep("a", {
        hooks: { before: [{ cmd: "setup" }], on_error: [{ cmd: "cleanup" }] },
      }),
    ]);
    const started = startClankerRun(wf);
    const hookFailed = clankerCmdHookSettled(started.state, {
      stepName: "a",
      attempt: 0,
      phase: "before",
      hookIndex: 0,
      exitCode: 2,
    });
    expect(dispatches(hookFailed.actions)).toMatchObject([
      { type: "runCmd", kind: "hook", phase: "on_error", cmd: "cleanup" },
    ]);
    const settled = clankerCmdHookSettled(hookFailed.state, {
      stepName: "a",
      attempt: 0,
      phase: "on_error",
      hookIndex: 0,
      exitCode: 0,
    });
    expect(settled.state.stepStates.get("a")?.status).toBe("failed");
    expect(settled.state.status).toBe("failed");
    // No prompt dispatch and no after hooks ever ran.
    expect(dispatches(settled.actions)).toHaveLength(0);
    expect(settled.state.stepStates.get("a")?.responses).toHaveLength(0);
  });

  it("runs after hooks on both pass and fail", () => {
    const wf = workflow([promptStep("a", { hooks: { after: [{ cmd: "teardown" }] } })]);
    const started = startClankerRun(wf);
    const passed = settleAllPrompts(started);
    expect(dispatches(passed.actions)).toMatchObject([
      { type: "runCmd", kind: "hook", phase: "after", cmd: "teardown" },
    ]);
    const hooked = clankerCmdHookSettled(passed.state, {
      stepName: "a",
      attempt: 0,
      phase: "after",
      hookIndex: 0,
      exitCode: 0,
    });
    expect(hooked.state.stepStates.get("a")?.status).toBe("passed");
    expect(hooked.state.status).toBe("completed");
  });

  it("runs parallel hook groups together", () => {
    const wf = workflow([promptStep("a", { hooks: { before: [[{ cmd: "x" }, { cmd: "y" }]] } })]);
    const started = startClankerRun(wf);
    expect(dispatches(started.actions)).toHaveLength(2);
    const one = clankerCmdHookSettled(started.state, {
      stepName: "a",
      attempt: 0,
      phase: "before",
      hookIndex: 0,
      exitCode: 0,
    });
    // Group not drained — no prompts yet.
    expect(dispatches(one.actions)).toHaveLength(0);
    const two = clankerCmdHookSettled(one.state, {
      stepName: "a",
      attempt: 0,
      phase: "before",
      hookIndex: 1,
      exitCode: 0,
    });
    expect(dispatches(two.actions)).toMatchObject([{ type: "dispatchPrompt" }]);
  });

  it("runs every on_error group even after hooks fail (best-effort)", () => {
    const wf = workflow([
      promptStep("a", {
        hooks: {
          before: [{ cmd: "setup" }],
          on_error: [[{ cmd: "cleanup1" }, { cmd: "cleanup2" }], { cmd: "cleanup3" }],
        },
      }),
    ]);
    const started = startClankerRun(wf);
    const hookFailed = clankerCmdHookSettled(started.state, {
      stepName: "a",
      attempt: 0,
      phase: "before",
      hookIndex: 0,
      exitCode: 2,
    });
    expect(dispatches(hookFailed.actions)).toMatchObject([
      { phase: "on_error", cmd: "cleanup1", hookIndex: 0 },
      { phase: "on_error", cmd: "cleanup2", hookIndex: 1 },
    ]);
    // One hook in the parallel group fails — the group still drains, and
    // the next group still dispatches (hooks.ts `bestEffort`).
    const one = clankerCmdHookSettled(hookFailed.state, {
      stepName: "a",
      attempt: 0,
      phase: "on_error",
      hookIndex: 0,
      exitCode: 1,
    });
    expect(dispatches(one.actions)).toHaveLength(0);
    const two = clankerCmdHookSettled(one.state, {
      stepName: "a",
      attempt: 0,
      phase: "on_error",
      hookIndex: 1,
      exitCode: 0,
    });
    expect(dispatches(two.actions)).toMatchObject([
      { phase: "on_error", cmd: "cleanup3", hookIndex: 2 },
    ]);
    const three = clankerCmdHookSettled(two.state, {
      stepName: "a",
      attempt: 0,
      phase: "on_error",
      hookIndex: 2,
      exitCode: 1,
    });
    expect(three.state.stepStates.get("a")?.status).toBe("failed");
    // The original before-hook error is reported — on_error hook failures
    // never overwrite it.
    expect(actionsOfType(three.actions, "stepFailed")[0]?.error).toContain("code 2");
  });

  it("fails the step fast on fn hooks without dispatching the group's cmds", () => {
    const wf = workflow([
      promptStep("a", { hooks: { before: [[{ cmd: "setup" }, { fn: "prepare" }]] } }),
    ]);
    const started = startClankerRun(wf);
    expect(dispatches(started.actions)).toHaveLength(0);
    expect(started.state.stepStates.get("a")?.status).toBe("failed");
    expect(started.state.status).toBe("failed");
    expect(actionsOfType(started.actions, "stepFailed")[0]?.error).toContain(
      'fn hooks are not supported by the T3 Code runner (hook "prepare")',
    );
  });

  it("fails the step fast when an after hook is an fn hook", () => {
    const wf = workflow([promptStep("a", { hooks: { after: [{ fn: "teardown" }] } })]);
    const passed = settleAllPrompts(startClankerRun(wf));
    expect(passed.state.stepStates.get("a")?.status).toBe("failed");
    expect(actionsOfType(passed.actions, "stepFailed")[0]?.error).toContain("fn hooks");
  });

  it("keeps the original error when an on_error hook is an fn hook", () => {
    const wf = workflow([
      promptStep("a", {
        hooks: { before: [{ cmd: "setup" }], on_error: [{ fn: "cleanup" }] },
      }),
    ]);
    const started = startClankerRun(wf);
    const hookFailed = clankerCmdHookSettled(started.state, {
      stepName: "a",
      attempt: 0,
      phase: "before",
      hookIndex: 0,
      exitCode: 2,
    });
    expect(hookFailed.state.stepStates.get("a")?.status).toBe("failed");
    expect(hookFailed.state.stepStates.get("a")?.error).toContain("code 2");
    expect(hookFailed.diagnostics.some((d) => d.severity === "unsupported")).toBe(true);
  });
});

describe("run failure semantics", () => {
  it("fails the run when a step fails and never reaches dependent waves", () => {
    const wf = workflow([
      promptStep("a", { retry: 0 }),
      promptStep("b", { depends_on: ["a"] }),
      promptStep("c"),
    ]);
    const started = startClankerRun(wf);
    // Wave 0 = [a, c]. Fail a, let c pass — the run still fails after the wave.
    const aFailed = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      error: "bad",
    });
    const cSettled = settleAllPrompts(aFailed);
    expect(cSettled.state.stepStates.get("c")?.status).toBe("passed");
    expect(cSettled.state.status).toBe("failed");
    // b was never dispatched and stays pending — Clanker halts the run rather
    // than skipping dependents.
    expect(cSettled.state.stepStates.get("b")?.status).toBe("pending");
    const completed = actionsOfType(cSettled.actions, "runCompleted");
    expect(completed[0]?.result.success).toBe(false);
  });
});

describe("stepFailed event", () => {
  it("fails the step immediately without retrying", () => {
    const wf = workflow([promptStep("a", { retry: 3 })]);
    const started = startClankerRun(wf);
    const failed = clankerStepFailed(started.state, {
      stepName: "a",
      attempt: 0,
      reason: "turn cancelled upstream",
    });
    expect(failed.state.stepStates.get("a")?.status).toBe("failed");
    expect(failed.state.status).toBe("failed");
    expect(dispatches(failed.actions)).toHaveLength(0);
  });

  it("keeps the original error when the driver fails during on_error hooks", () => {
    const wf = workflow([
      promptStep("a", {
        hooks: { before: [{ cmd: "setup" }], on_error: [{ cmd: "cleanup" }] },
      }),
    ]);
    const started = startClankerRun(wf);
    const hookFailed = clankerCmdHookSettled(started.state, {
      stepName: "a",
      attempt: 0,
      phase: "before",
      hookIndex: 0,
      exitCode: 2,
    });
    // The on_error cmd is in flight; the driver reports a hard failure.
    expect(hookFailed.state.stepStates.get("a")?.phase).toBe("hook-on-error");
    const failed = clankerStepFailed(hookFailed.state, {
      stepName: "a",
      attempt: 0,
      reason: "spawn blew up",
    });
    expect(failed.state.stepStates.get("a")?.status).toBe("failed");
    expect(failed.state.stepStates.get("a")?.error).toContain("code 2");
    expect(actionsOfType(failed.actions, "stepFailed")[0]?.error).toContain("code 2");
  });
});

describe("cancelClankerRun", () => {
  it("marks the run cancelled, keeps in-flight steps running, and ignores late events", () => {
    const started = startClankerRun(workflow([promptStep("a")]));
    const cancelled = cancelClankerRun(started.state);
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.state.stepStates.get("a")?.status).toBe("running");
    expect(actionsOfType(cancelled.actions, "runCompleted")[0]?.result.cancelled).toBe(true);

    const late = clankerPromptSettled(cancelled.state, {
      stepName: "a",
      attempt: 0,
      promptIndex: 0,
      modelIndex: 0,
      response: "too late",
    });
    expect(late.actions).toHaveLength(0);
    expect(late.state.status).toBe("cancelled");
  });
});

describe("resume", () => {
  it("restores prior steps before startFromStep and seeds their outputs", () => {
    const wf = workflow([
      promptStep("a", { outputs: { artifact: "out.txt" } }),
      promptStep("b", {
        depends_on: ["a"],
        template_engine: "handlebars",
        prompts: [{ text: "use {{steps.a.outputs.artifact}}" }],
      }),
    ]);
    const started = startClankerRun(wf, {
      startFromStep: "b",
      restoredSteps: [
        {
          name: "a",
          status: "passed",
          outputs: { artifact: "out.txt" },
          declaredOutputs: { artifact: "out.txt" },
          responses: [{ prompt_index: 0, model_id: "m", response: "prior" }],
        },
      ],
    });
    expect(started.state.stepStates.get("a")?.status).toBe("passed");
    expect(actionsOfType(started.actions, "stepPassed")).toMatchObject([{ stepName: "a" }]);
    const bPrompt = actionsOfType(started.actions, "dispatchPrompt")[0];
    expect(bPrompt?.stepName).toBe("b");
    expect(bPrompt?.renderedPrompt).toBe("use out.txt");
  });

  it("still runs un-restored steps ahead of the resume gate", () => {
    const wf = workflow([promptStep("a"), promptStep("b", { depends_on: ["a"] })]);
    const started = startClankerRun(wf, { startFromStep: "b" });
    // `a` has no restored state, so it runs like the CLI's resumeFrom.
    expect(dispatches(started.actions)).toMatchObject([{ stepName: "a" }]);
  });
});

describe("clankerRunToPersistedState", () => {
  it("produces state that round-trips through the persisted schema", () => {
    const wf = workflow([
      promptStep("a", { outputs: { artifact: "out.txt" } }),
      promptStep("b", { depends_on: ["a"] }),
    ]);
    const finished = runToCompletion(startClankerRun(wf));
    expect(finished.state.status).toBe("completed");

    const persisted = clankerRunToPersistedState(finished.state, {
      runId: "run-1",
      workflowPath: ".clanker/workflows/test.yaml",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const decoded = decodePersistedRunState(persisted);
    expect(decoded.status).toBe("completed");
    expect(decoded.steps["a"]?.status).toBe("passed");
    expect(decoded.steps["a"]?.responses[0]?.response).toBe("ok");
    expect(decoded.steps["b"]?.status).toBe("passed");
  });

  it("keeps pending steps out of Clanker-style results but includes them in persisted steps", () => {
    const wf = workflow([promptStep("a"), promptStep("b", { depends_on: ["a"] })]);
    const started = startClankerRun(wf);
    const failed = clankerStepFailed(started.state, {
      stepName: "a",
      attempt: 0,
      reason: "boom",
    });
    const persisted = clankerRunToPersistedState(failed.state, {
      runId: "r",
      startedAt: "t",
      updatedAt: "t",
    });
    expect(persisted.steps["a"]?.status).toBe("failed");
    expect(persisted.steps["b"]?.status).toBe("pending");
    const decoded = decodePersistedRunState(persisted);
    expect(decoded.status).toBe("failed");
  });
});

describe("engine guards", () => {
  it("ignores stale-attempt and out-of-phase events", () => {
    const wf = workflow([promptStep("a", { retry: 1 })]);
    const started = startClankerRun(wf);
    const stale = clankerPromptSettled(started.state, {
      stepName: "a",
      attempt: 5,
      promptIndex: 0,
      modelIndex: 0,
      response: "stale",
    });
    expect(stale.actions).toHaveLength(0);
    expect(stale.state).toBe(started.state);
  });
});
