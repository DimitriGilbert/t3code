import { describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

import {
  clankerDefaultsAreSet,
  clankerDependsOnOptions,
  clankerWorkflowDraftToObject,
  emptyClankerHookDraft,
  emptyClankerModelDraft,
  emptyClankerPromptDraft,
  emptyClankerQaCheckDraft,
  moveClankerStep,
  parseClankerWorkflowDraft,
  serializeClankerWorkflowDraft,
  type ClankerHookDraft,
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
