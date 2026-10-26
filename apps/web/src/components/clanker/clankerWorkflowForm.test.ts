import { describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

import {
  clankerDefaultsAreSet,
  clankerDependsOnOptions,
  clankerDraftJsonIssues,
  clankerJsonRecordError,
  clankerWorkflowDraftToObject,
  emptyClankerHookDraft,
  emptyClankerModelDraft,
  emptyClankerPromptDraft,
  emptyClankerQaCheckDraft,
  emptyClankerSubWorkflowDraft,
  moveClankerStep,
  parseClankerWorkflowDraft,
  serializeClankerWorkflowDraft,
  writeClankerWorkflowDraft,
  type ClankerHookDraft,
  type ClankerStepDraft,
  type ClankerWorkflowDraft,
} from "./clankerWorkflowForm";

const FULL_WORKFLOW = `
name: release
version: "1"
description: Ship it
defaults:
  timeout: 600
  retry: 1
  concurrency: 2
  model: gpt-5
  provider: codex
  template_engine: handlebars
  output_format: markdown
  hooks:
    before:
      - cmd: echo start
        runtime: bash
  qa:
    on_fail: abort
    checks:
      - type: cmd
        cmd: npm test
        on_fail: rerun
secrets:
  - OPENAI_API_KEY
steps:
  - name: build
    description: Compile everything
    condition: always
    timeout: 300
    retry: 2
    concurrency: 1
    agent: builder
    skills:
      - typescript
    env:
      NODE_ENV: production
    inputs:
      ref: main
    outputs:
      artifact: dist.tgz
    tags:
      team: infra
    models:
      - id: gpt-5
        provider: codex
        harness: cli
    prompts:
      - text: Build the project
      - file: prompts/check.md
    template_engine: none
    output_format: json
    hooks:
      after:
        - fn: notify
          runtime: node
    qa:
      on_fail: continue
      checks:
        - type: ref
          target: shared/lint
        - type: inline
          name: sanity
          prompt: Does it build?
          on_fail: abort
  - name: test
    depends_on:
      - build
    prompts:
      - text: Run the tests
`;

function draftOf(content: string): ClankerWorkflowDraft {
  const parsed = parseClankerWorkflowDraft(content);
  if (!parsed.ok) throw new Error(`expected a parsable workflow, got: ${parsed.error}`);
  return parsed.draft;
}

describe("parseClankerWorkflowDraft", () => {
  it("maps every workflow and step field the form renders", () => {
    const draft = draftOf(FULL_WORKFLOW);

    expect(draft.name).toBe("release");
    expect(draft.version).toBe("1");
    expect(draft.description).toBe("Ship it");
    expect(draft.secrets.map((row) => row.value)).toEqual(["OPENAI_API_KEY"]);
    expect(clankerDefaultsAreSet(draft.defaults)).toBe(true);
    expect(draft.defaults.timeout).toBe("600");
    expect(draft.defaults.templateEngine).toBe("handlebars");
    expect(draft.defaults.outputFormat).toBe("markdown");
    expect(draft.defaults.hooks[0]?.phase).toBe("before");
    expect(draft.defaults.hooks[0]?.hooks[0]).toMatchObject({ kind: "cmd", cmd: "echo start" });
    expect(draft.defaults.qa.onFail).toBe("abort");
    expect(draft.defaults.qa.checks[0]).toMatchObject({ kind: "cmd", onFail: "rerun" });

    const build = draft.steps[0];
    expect(build).toMatchObject({
      name: "build",
      description: "Compile everything",
      condition: "always",
      timeout: "300",
      retry: "2",
      concurrency: "1",
      agent: "builder",
      templateEngine: "none",
      outputFormat: "json",
    });
    expect(build?.skills.map((row) => row.value)).toEqual(["typescript"]);
    expect(build?.env).toEqual([{ rowId: "steps/0/env/0", key: "NODE_ENV", value: "production" }]);
    expect(build?.inputs[0]?.key).toBe("ref");
    expect(build?.outputs[0]?.value).toBe("dist.tgz");
    expect(build?.tags[0]).toMatchObject({ key: "team", value: "infra" });
    expect(build?.models[0]).toMatchObject({ id: "gpt-5", provider: "codex", harness: "cli" });
    expect(build?.prompts.map((prompt) => [prompt.kind, prompt.text, prompt.file])).toEqual([
      ["text", "Build the project", ""],
      ["file", "", "prompts/check.md"],
    ]);
    expect(build?.hooks[0]?.hooks[0]).toMatchObject({ kind: "fn", fn: "notify", runtime: "node" });
    expect(build?.qa.enabled).toBe(true);
    expect(build?.qa.checks.map((check) => check.kind)).toEqual(["ref", "inline"]);
    expect(draft.steps[1]?.dependsOn).toEqual(["build"]);
  });

  it("round-trips a full workflow through the draft without changing the document", () => {
    const draft = draftOf(FULL_WORKFLOW);
    const serialized = serializeClankerWorkflowDraft(draft);

    expect(parseYaml(serialized)).toEqual(parseYaml(FULL_WORKFLOW));
    expect(draftOf(serialized)).toEqual(draft);
  });

  it("keeps fields the form does not render", () => {
    const draft = draftOf(`
name: keep
version: "1"
custom_root: 7
steps:
  - name: one
    run:
      cmd: make
    conditions:
      - when: always
    conditions_mode: all
    workflow:
      name: inline
      version: "1"
      steps:
        - name: inner
          prompts:
            - text: hi
    prompts:
      - text: hello
        context:
          ticket: T-1
    models:
      - id: gpt-5
        weight: 3
    hooks:
      before:
        - fn: notify
          args:
            channel: ops
    qa:
      checks:
        - type: fn
          fn: audit
          args:
            depth: 2
      escalate:
        - type: HIL
`);

    expect(draft.steps[0]?.workflowRef).toBe("");
    const object = clankerWorkflowDraftToObject(draft);
    expect(object["custom_root"]).toBe(7);
    const step = (object["steps"] as ReadonlyArray<Record<string, unknown>>)[0];
    expect(step?.["run"]).toEqual({ cmd: "make" });
    expect(step?.["conditions"]).toEqual([{ when: "always" }]);
    expect(step?.["conditions_mode"]).toBe("all");
    expect(step?.["workflow"]).toMatchObject({ name: "inline" });
    expect(step?.["prompts"]).toEqual([{ text: "hello", context: { ticket: "T-1" } }]);
    expect(step?.["models"]).toEqual([{ id: "gpt-5", weight: 3 }]);
    expect(step?.["hooks"]).toEqual({ before: [{ fn: "notify", args: { channel: "ops" } }] });
    expect(step?.["qa"]).toEqual({
      checks: [{ type: "fn", fn: "audit", args: { depth: 2 } }],
      escalate: [{ type: "HIL" }],
    });
  });

  it("flattens nested hook entry lists into sibling hooks", () => {
    const draft = draftOf(`
name: hooks
version: "1"
steps:
  - name: one
    prompts:
      - text: hi
    hooks:
      before:
        - - cmd: first
          - cmd: second
        - cmd: third
`);

    expect(draft.steps[0]?.hooks[0]?.hooks.map((hook) => hook.cmd)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("rejects documents the form cannot represent", () => {
    expect(parseClankerWorkflowDraft("name: [unclosed")).toMatchObject({ ok: false });
    expect(parseClankerWorkflowDraft("- just\n- a list")).toMatchObject({
      ok: false,
      error: "The workflow file must be a YAML object.",
    });
    expect(parseClankerWorkflowDraft("steps: nope")).toMatchObject({
      ok: false,
      error: "`steps` must be a list of steps.",
    });
    expect(parseClankerWorkflowDraft("steps:\n  - just a string")).toMatchObject({
      ok: false,
      error: "Every entry in `steps` must be an object.",
    });
    expect(parseClankerWorkflowDraft("steps:\n  - null")).toMatchObject({
      ok: false,
      error: "Every entry in `steps` must be an object.",
    });
  });

  it("keeps owned keys whose values have unexpected shapes", () => {
    const content = `
name: odd
version: "1"
secrets:
  oops: true
defaults:
  timeout: [600]
steps:
  - name: one
    env: [1]
    depends_on: build
    qa: nope
    hooks: [x]
    models: [null]
    output_format: bogus
    prompts:
      - text: hi
`;
    const draft = draftOf(content);

    // Malformed owned values land in `extra`, surfaced via PreservedKeysNote.
    expect(draft.extra["secrets"]).toEqual({ oops: true });
    expect(draft.defaults.extra["timeout"]).toEqual([600]);
    expect(draft.steps[0]?.extra["env"]).toEqual([1]);
    expect(draft.steps[0]?.extra["qa"]).toBe("nope");
    expect(clankerWorkflowDraftToObject(draft)).toEqual(parseYaml(content));
  });

  it("reads an empty document as an empty draft", () => {
    const parsed = parseClankerWorkflowDraft("");
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.draft.steps).toEqual([]);
  });
});

describe("serializeClankerWorkflowDraft", () => {
  it("drops empty rows and blank optional fields", () => {
    const draft = draftOf(`
name: tidy
version: "1"
steps:
  - name: one
    prompts:
      - text: hi
`);
    const withBlanks: ClankerWorkflowDraft = {
      ...draft,
      description: "",
      secrets: [{ rowId: "secrets/0", value: "   " }],
      steps: draft.steps.map((step) => ({
        ...step,
        env: [{ rowId: "steps/0/env/0", key: "", value: "orphan" }],
        timeout: "",
      })),
    };

    expect(parseYaml(serializeClankerWorkflowDraft(withBlanks))).toEqual({
      name: "tidy",
      version: "1",
      steps: [{ name: "one", prompts: [{ text: "hi" }] }],
    });
  });

  it("writes integer fields as numbers and keeps unparsable input visible", () => {
    const draft = draftOf(
      'name: n\nversion: "1"\nsteps:\n  - name: one\n    prompts:\n      - text: hi\n',
    );
    const edited: ClankerWorkflowDraft = {
      ...draft,
      steps: draft.steps.map((step) => ({ ...step, timeout: "30", retry: "soon" })),
    };
    const steps = parseYaml(serializeClankerWorkflowDraft(edited))["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;

    expect(steps[0]?.["timeout"]).toBe(30);
    expect(steps[0]?.["retry"]).toBe("soon");
  });

  it("merges same-named hook phases instead of dropping their hooks", () => {
    const draft = draftOf(
      'name: n\nversion: "1"\nsteps:\n  - name: one\n    prompts:\n      - text: hi\n',
    );
    const cmdHook = (rowId: string, cmd: string): ClankerHookDraft => ({
      ...emptyClankerHookDraft(rowId),
      cmd,
    });
    const edited: ClankerWorkflowDraft = {
      ...draft,
      steps: draft.steps.map((step) => ({
        ...step,
        hooks: [
          { rowId: "steps/0/hooks/0", phase: "before", hooks: [cmdHook("h/0", "one")] },
          { rowId: "steps/0/hooks/1", phase: "before", hooks: [cmdHook("h/1", "two")] },
        ],
      })),
    };

    const steps = parseYaml(serializeClankerWorkflowDraft(edited))["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(steps[0]?.["hooks"]).toEqual({ before: [{ cmd: "one" }, { cmd: "two" }] });
  });

  it("drops blank models, prompts, hooks, and checks instead of emitting empty objects", () => {
    const draft = draftOf(
      'name: n\nversion: "1"\nsteps:\n  - name: one\n    prompts:\n      - text: hi\n',
    );
    const edited: ClankerWorkflowDraft = {
      ...draft,
      steps: draft.steps.map((step) => ({
        ...step,
        models: [emptyClankerModelDraft("steps/0/models/0")],
        prompts: [...step.prompts, emptyClankerPromptDraft("steps/0/prompts/1")],
        hooks: [
          {
            rowId: "steps/0/hooks/0",
            phase: "before",
            hooks: [emptyClankerHookDraft("steps/0/hooks/0/0")],
          },
        ],
        qa: {
          ...step.qa,
          enabled: true,
          checks: [
            { ...emptyClankerQaCheckDraft("steps/0/qa/checks/0"), cmd: "npm test" },
            emptyClankerQaCheckDraft("steps/0/qa/checks/1"),
          ],
        },
      })),
    };

    const steps = parseYaml(serializeClankerWorkflowDraft(edited))["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(steps[0]).toEqual({
      name: "one",
      prompts: [{ text: "hi" }],
      qa: { checks: [{ type: "cmd", cmd: "npm test" }] },
    });
  });

  it("omits an enabled-but-empty qa block and hook phases with no hooks", () => {
    const draft = draftOf(
      'name: n\nversion: "1"\nsteps:\n  - name: one\n    prompts:\n      - text: hi\n',
    );
    const edited: ClankerWorkflowDraft = {
      ...draft,
      steps: draft.steps.map((step) => ({
        ...step,
        hooks: [{ rowId: "steps/0/hooks/0", phase: "before", hooks: [] }],
        qa: { ...step.qa, enabled: true },
      })),
    };

    const steps = parseYaml(serializeClankerWorkflowDraft(edited))["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(steps[0]?.["hooks"]).toBeUndefined();
    expect(steps[0]?.["qa"]).toBeUndefined();
  });

  it("writes multiline prompt text as a literal block", () => {
    const draft = draftOf(
      'name: n\nversion: "1"\nsteps:\n  - name: one\n    prompts:\n      - text: hi\n',
    );
    const edited: ClankerWorkflowDraft = {
      ...draft,
      steps: draft.steps.map((step) => ({
        ...step,
        prompts: step.prompts.map((prompt) => ({ ...prompt, text: "line one\nline two\n" })),
      })),
    };

    expect(draftOf(serializeClankerWorkflowDraft(edited)).steps[0]?.prompts[0]?.text).toBe(
      "line one\nline two\n",
    );
  });
});

const RECURSIVE_WORKFLOW = `
name: outer
version: "1"
steps:
  - name: fanout
    conditions:
      - when: always
      - any:
          - a
          - b
    conditions_mode: all
    run:
      fn: build
      args:
        target: web
      runtime: node
    workflow:
      name: inner
      version: "2"
      description: Nested
      defaults:
        model: gpt-5
      steps:
        - name: middle
          workflow:
            name: deepest
            version: "3"
            steps:
              - name: leaf
                prompts:
                  - text: hi
                    context:
                      ticket: T-1
    qa:
      escalate:
        - type: HIL
          prompt: Please review
          model:
            id: gpt-5
            provider: codex
        - type: AI
          ref: shared/triage
        - type: AI
          ref:
            name: fallback
            version: "1"
            steps:
              - name: retry
                prompts:
                  - text: again
        - type: AI
          ref:
            name: inline-step
            prompts:
              - text: one
`;

function editStep(
  draft: ClankerWorkflowDraft,
  index: number,
  edit: (step: ClankerStepDraft) => ClankerStepDraft,
): ClankerWorkflowDraft {
  return { ...draft, steps: draft.steps.map((step, at) => (at === index ? edit(step) : step)) };
}

describe("recursive sub-workflows", () => {
  it("reads an inline sub-workflow and the sub-workflow inside it", () => {
    const draft = draftOf(RECURSIVE_WORKFLOW);
    const inner = draft.steps[0]?.subWorkflow;
    const deepest = inner?.steps[0]?.subWorkflow;

    expect(draft.steps[0]?.workflowRef).toBe("");
    expect(inner).toMatchObject({ name: "inner", version: "2", description: "Nested" });
    expect(inner?.defaults.model).toBe("gpt-5");
    expect(deepest?.name).toBe("deepest");
    expect(deepest?.steps[0]?.prompts[0]?.context).toBe('{"ticket":"T-1"}');
  });

  it("round-trips the whole recursive document", () => {
    const draft = draftOf(RECURSIVE_WORKFLOW);
    const serialized = serializeClankerWorkflowDraft(draft);

    expect(parseYaml(serialized)).toEqual(parseYaml(RECURSIVE_WORKFLOW));
    expect(draftOf(serialized)).toEqual(draft);
  });

  it("writes an edit made two levels deep", () => {
    const draft = draftOf(RECURSIVE_WORKFLOW);
    const edited = editStep(draft, 0, (step) => {
      const inner = step.subWorkflow;
      if (inner === null) throw new Error("expected an inline sub-workflow");
      return {
        ...step,
        subWorkflow: editStep(inner, 0, (middle) => {
          const deepest = middle.subWorkflow;
          if (deepest === null) throw new Error("expected a nested sub-workflow");
          return {
            ...middle,
            subWorkflow: editStep(deepest, 0, (leaf) => ({ ...leaf, name: "renamed" })),
          };
        }),
      };
    });

    const object = clankerWorkflowDraftToObject(edited);
    const steps = object["steps"] as ReadonlyArray<Record<string, unknown>>;
    const inner = steps[0]?.["workflow"] as Record<string, unknown>;
    const innerSteps = inner["steps"] as ReadonlyArray<Record<string, unknown>>;
    const deepest = innerSteps[0]?.["workflow"] as Record<string, unknown>;
    const leafSteps = deepest["steps"] as ReadonlyArray<Record<string, unknown>>;
    expect(leafSteps[0]?.["name"]).toBe("renamed");
  });

  it("switches between a path and an inline sub-workflow", () => {
    const draft = draftOf(
      'name: n\nversion: "1"\nsteps:\n  - name: one\n    workflow: review.yaml\n',
    );
    expect(draft.steps[0]?.workflowRef).toBe("review.yaml");
    expect(draft.steps[0]?.subWorkflow).toBeNull();

    const inlined = editStep(draft, 0, (step) => ({
      ...step,
      subWorkflow: { ...emptyClankerSubWorkflowDraft(), name: "inline" },
    }));
    const steps = clankerWorkflowDraftToObject(inlined)["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;
    // The inline body wins; the path stays in the draft for the way back.
    expect(steps[0]?.["workflow"]).toEqual({ name: "inline", version: "1" });

    const backToPath = editStep(inlined, 0, (step) => ({ ...step, subWorkflow: null }));
    const pathSteps = clankerWorkflowDraftToObject(backToPath)["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(pathSteps[0]?.["workflow"]).toBe("review.yaml");
  });

  it("keeps a sub-workflow the form cannot represent in extra", () => {
    const content =
      'name: n\nversion: "1"\nsteps:\n  - name: one\n    workflow:\n      steps: nope\n';
    const draft = draftOf(content);

    expect(draft.steps[0]?.subWorkflow).toBeNull();
    expect(draft.steps[0]?.extra["workflow"]).toEqual({ steps: "nope" });
    expect(clankerWorkflowDraftToObject(draft)).toEqual(parseYaml(content));
  });
});

describe("step run, conditions and escalate handlers", () => {
  it("reads run, conditions and conditions_mode", () => {
    const step = draftOf(RECURSIVE_WORKFLOW).steps[0];

    expect(step?.run).toMatchObject({
      kind: "fn",
      fn: "build",
      args: '{"target":"web"}',
      runtime: "node",
    });
    expect(step?.conditions.map((row) => row.text)).toEqual([
      '{"when":"always"}',
      '{"any":["a","b"]}',
    ]);
    expect(step?.conditionsMode).toBe("all");
  });

  it("drops a removed run block and blank condition rows", () => {
    const draft = draftOf(RECURSIVE_WORKFLOW);
    const edited = editStep(draft, 0, (step) => ({
      ...step,
      run: null,
      conditions: [{ rowId: "c/0", text: "  " }],
      conditionsMode: "",
    }));
    const steps = clankerWorkflowDraftToObject(edited)["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;

    expect(steps[0]?.["run"]).toBeUndefined();
    expect(steps[0]?.["conditions"]).toBeUndefined();
    expect(steps[0]?.["conditions_mode"]).toBeUndefined();
  });

  it("reads every escalate ref shape", () => {
    const escalate = draftOf(RECURSIVE_WORKFLOW).steps[0]?.qa.escalate ?? [];

    expect(escalate.map((handler) => [handler.type, handler.refKind])).toEqual([
      ["HIL", "none"],
      ["AI", "path"],
      ["AI", "workflow"],
      ["AI", "step"],
    ]);
    expect(escalate[0]).toMatchObject({ prompt: "Please review" });
    expect(escalate[0]?.model).toMatchObject({ id: "gpt-5", provider: "codex" });
    expect(escalate[1]?.refPath).toBe("shared/triage");
    expect(escalate[2]?.refWorkflow?.steps[0]?.name).toBe("retry");
    expect(escalate[3]?.refStep?.prompts[0]?.text).toBe("one");
  });

  it("writes an escalate handler with no ref as just its type", () => {
    const draft = draftOf(RECURSIVE_WORKFLOW);
    const edited = editStep(draft, 0, (step) => ({
      ...step,
      qa: { ...step.qa, escalate: step.qa.escalate.slice(0, 1) },
    }));
    const steps = clankerWorkflowDraftToObject(edited)["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;

    expect(steps[0]?.["qa"]).toEqual({
      escalate: [
        { type: "HIL", prompt: "Please review", model: { id: "gpt-5", provider: "codex" } },
      ],
    });
  });

  it("keeps escalate handlers the form cannot represent in extra", () => {
    const content =
      'name: n\nversion: "1"\nsteps:\n  - name: one\n    qa:\n      escalate:\n        - type: ROBOT\n';
    const draft = draftOf(content);

    expect(draft.steps[0]?.qa.escalate).toEqual([]);
    expect(draft.steps[0]?.qa.extra["escalate"]).toEqual([{ type: "ROBOT" }]);
    expect(clankerWorkflowDraftToObject(draft)).toEqual(parseYaml(content));
  });
});

describe("JSON object fields", () => {
  const WITH_ARGS = `
name: n
version: "1"
steps:
  - name: one
    prompts:
      - text: hi
        context:
          ticket: T-1
    hooks:
      before:
        - fn: notify
          args:
            channel: ops
        - cmd: echo hi
          args:
            stray: true
    qa:
      checks:
        - type: fn
          fn: audit
          args:
            depth: 2
        - type: ref
          target: shared/lint
          runtime: bash
`;

  it("reads context and fn args as JSON text, and keeps args a kind cannot write", () => {
    const step = draftOf(WITH_ARGS).steps[0];

    expect(step?.prompts[0]?.context).toBe('{"ticket":"T-1"}');
    expect(step?.hooks[0]?.hooks[0]).toMatchObject({ kind: "fn", args: '{"channel":"ops"}' });
    // A `cmd` hook has no `args` in the schema, so it round-trips through extra.
    expect(step?.hooks[0]?.hooks[1]?.args).toBe("");
    expect(step?.hooks[0]?.hooks[1]?.extra).toEqual({ args: { stray: true } });
    expect(step?.qa.checks[0]?.args).toBe('{"depth":2}');
    expect(step?.qa.checks[1]?.extra).toEqual({ runtime: "bash" });
    expect(clankerWorkflowDraftToObject(draftOf(WITH_ARGS))).toEqual(parseYaml(WITH_ARGS));
  });

  it("drops a cleared context and keeps an edited one", () => {
    const draft = draftOf(WITH_ARGS);
    const cleared = editStep(draft, 0, (step) => ({
      ...step,
      prompts: step.prompts.map((prompt) => ({ ...prompt, context: "" })),
    }));
    const edited = editStep(draft, 0, (step) => ({
      ...step,
      prompts: step.prompts.map((prompt) => ({ ...prompt, context: '{"ticket": "T-2"}' })),
    }));

    const clearedSteps = clankerWorkflowDraftToObject(cleared)["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;
    const editedSteps = clankerWorkflowDraftToObject(edited)["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(clearedSteps[0]?.["prompts"]).toEqual([{ text: "hi" }]);
    expect(editedSteps[0]?.["prompts"]).toEqual([{ text: "hi", context: { ticket: "T-2" } }]);
  });

  it("reports invalid JSON per field without dropping what was typed", () => {
    const draft = draftOf(RECURSIVE_WORKFLOW);
    const edited = editStep(draft, 0, (step) => {
      const inner = step.subWorkflow;
      if (inner === null) throw new Error("expected an inline sub-workflow");
      return {
        ...step,
        conditions: [{ rowId: "c/0", text: "{oops" }],
        run: step.run === null ? null : { ...step.run, args: "[1]" },
        subWorkflow: editStep(inner, 0, (middle) => {
          const deepest = middle.subWorkflow;
          if (deepest === null) throw new Error("expected a nested sub-workflow");
          return {
            ...middle,
            subWorkflow: editStep(deepest, 0, (leaf) => ({
              ...leaf,
              prompts: leaf.prompts.map((prompt) => ({ ...prompt, context: "nope" })),
            })),
          };
        }),
      };
    });

    expect(clankerDraftJsonIssues(edited).map((issue) => issue.path)).toEqual([
      "steps[0].conditions[0]",
      "steps[0].run.args",
      "steps[0].workflow.steps[0].workflow.steps[0].prompts[0].context",
    ]);
    // Nothing is dropped: the raw text survives as a string value.
    const steps = clankerWorkflowDraftToObject(edited)["steps"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(steps[0]?.["conditions"]).toEqual(["{oops"]);
    expect(steps[0]?.["run"]).toMatchObject({ args: "[1]" });
    expect(clankerDraftJsonIssues(draft)).toEqual([]);
  });

  it("accepts only JSON objects", () => {
    expect(clankerJsonRecordError("")).toBeNull();
    expect(clankerJsonRecordError("   ")).toBeNull();
    expect(clankerJsonRecordError('{"a": 1}')).toBeNull();
    expect(clankerJsonRecordError("[1]")).toBe("Expected a JSON object.");
    expect(clankerJsonRecordError("1")).toBe("Expected a JSON object.");
    expect(clankerJsonRecordError("{oops")).not.toBeNull();
  });
});

describe("writeClankerWorkflowDraft", () => {
  const COMMENTED = `# The pipeline.
name: release
version: "1"
steps:
  # Builds it.
  - name: build
    prompts:
      - text: Build it
  # Tests it.
  - name: test
    prompts:
      - text: Test it
`;

  it("keeps comments on steps a form edit did not touch", () => {
    const draft = draftOf(COMMENTED);
    const edited = editStep(draft, 1, (step) => ({ ...step, description: "Runs the tests" }));

    const written = writeClankerWorkflowDraft(edited, COMMENTED);

    expect(written).toContain("# The pipeline.");
    expect(written).toContain("# Builds it.");
    expect(written).toContain("# Tests it.");
    expect(written).toContain("description: Runs the tests");
    expect(draftOf(written)).toEqual(edited);
  });

  it("keeps the comments of a step it edits", () => {
    const draft = draftOf(COMMENTED);
    const edited = editStep(draft, 0, (step) => ({ ...step, agent: "builder" }));

    const written = writeClankerWorkflowDraft(edited, COMMENTED);

    expect(written).toContain("# Builds it.");
    expect(written).toContain("agent: builder");
  });

  it("falls back to a fresh document when there is no base text", () => {
    const draft = draftOf(COMMENTED);

    expect(writeClankerWorkflowDraft(draft, "")).toBe(serializeClankerWorkflowDraft(draft));
  });
});

describe("clankerDependsOnOptions", () => {
  it("offers named siblings and never the step itself", () => {
    const draft = draftOf(`
name: deps
version: "1"
steps:
  - name: build
    prompts:
      - text: hi
  - name: test
    prompts:
      - text: hi
  - name: ""
    prompts:
      - text: hi
`);

    expect(clankerDependsOnOptions(draft, 1)).toEqual(["build"]);
    expect(clankerDependsOnOptions(draft, 2)).toEqual(["build", "test"]);
  });
});

describe("moveClankerStep", () => {
  it("swaps adjacent steps and ignores moves past the ends", () => {
    const draft = draftOf(`
name: order
version: "1"
steps:
  - name: a
    prompts:
      - text: hi
  - name: b
    prompts:
      - text: hi
`);

    expect(moveClankerStep(draft, 0, 1).steps.map((step) => step.name)).toEqual(["b", "a"]);
    expect(moveClankerStep(draft, 0, -1)).toBe(draft);
    expect(moveClankerStep(draft, 1, 1)).toBe(draft);
  });
});
