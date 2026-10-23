import { describe, expect, it } from "vite-plus/test";

import { parseClankerWorkflow } from "./parse.ts";

const VALID_WORKFLOW = `
name: minimal
version: "1.0"
description: One step that greets.
defaults:
  timeout: 30
  retry: 1
  model: claude-sonnet-4-20250514
  provider: anthropic
  template_engine: handlebars
  output_format: text
secrets:
  - ANTHROPIC_API_KEY
steps:
  - name: greet
    depends_on: []
    env:
      GREETING: hello
    inputs:
      who: env.USER
    outputs:
      greeting: greeting.txt
    models:
      - id: claude-sonnet-4-20250514
        provider: anthropic
        harness: default
    prompts:
      - text: "Say hi to {{who}}"
        context:
          extra: value
      - file: prompts/greet.md
    hooks:
      before:
        - cmd: "echo start"
      after:
        - - cmd: "echo a"
          - cmd: "echo b"
    qa:
      on_fail: abort
      checks:
        - type: inline
          name: sanity
          prompt: "Was the greeting written?"
          on_fail: rerun
        - type: ref
          target: greet
          on_fail: abort
        - type: cmd
          cmd: "test -f greeting.txt"
    tags:
      stage: demo
`;

describe("parseClankerWorkflow", () => {
  it("decodes a fully-populated workflow", () => {
    const result = parseClankerWorkflow(VALID_WORKFLOW);
    expect(result.diagnostics).toEqual([]);
    const workflow = result.workflow;
    expect(workflow?.name).toBe("minimal");
    expect(workflow?.version).toBe("1.0");
    expect(workflow?.defaults?.model).toBe("claude-sonnet-4-20250514");
    const step = workflow?.steps[0];
    expect(step?.name).toBe("greet");
    expect(step?.models).toHaveLength(1);
    expect(step?.prompts).toHaveLength(2);
    expect(step?.qa?.checks).toHaveLength(3);
    expect(step?.hooks?.["before"]).toHaveLength(1);
    const after = step?.hooks?.["after"]?.[0];
    expect(Array.isArray(after)).toBe(true);
  });

  it("accepts JSON content", () => {
    const json = JSON.stringify({
      name: "json-wf",
      version: "1",
      steps: [{ name: "only", prompts: [{ text: "hi" }] }],
    });
    const result = parseClankerWorkflow(json);
    expect(result.workflow?.name).toBe("json-wf");
    expect(result.diagnostics).toEqual([]);
  });

  it("reports a syntax error for malformed content", () => {
    const result = parseClankerWorkflow("{ not valid: [");
    expect(result.workflow).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("reports an error when the document is not an object", () => {
    const result = parseClankerWorkflow("- just\n- a\n- list\n");
    expect(result.workflow).toBeUndefined();
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  it("reports schema violations with paths", () => {
    const result = parseClankerWorkflow(`
name: broken
version: "1.0"
steps:
  - name: a
    prompts:
      - text: hi
    timeout: -5
  - prompts:
      - text: no name
`);
    expect(result.workflow).toBeUndefined();
    const paths = result.diagnostics.map((d) => d.path);
    expect(paths).toContain("steps[0].timeout");
    expect(paths).toContain("steps[1].name");
  });

  it("reports missing required top-level fields", () => {
    const result = parseClankerWorkflow(`name: no-version\nsteps: []\n`);
    expect(result.workflow).toBeUndefined();
    expect(result.diagnostics.some((d) => d.path === "version")).toBe(true);
  });

  it("reports unknown top-level and step keys as errors", () => {
    const result = parseClankerWorkflow(`
name: extra-keys
version: "1.0"
bogus_top: true
steps:
  - name: a
    bogus_step: 1
    prompts:
      - text: hi
`);
    expect(result.workflow).toBeUndefined();
    const paths = result.diagnostics.map((d) => d.path);
    expect(paths).toContain("bogus_top");
    expect(paths).toContain("steps[0].bogus_step");
  });

  it("flags step.workflow as unsupported", () => {
    const result = parseClankerWorkflow(`
name: sub
version: "1.0"
steps:
  - name: a
    workflow: "./other.yml"
`);
    const diag = result.diagnostics.find((d) => d.path === "steps[0].workflow");
    expect(diag?.severity).toBe("unsupported");
    // Still decodes — the runner decides what to skip.
    expect(result.workflow?.steps[0]?.workflow).toBe("./other.yml");
  });

  it("decodes inline sub-workflow objects and flags them unsupported", () => {
    const result = parseClankerWorkflow(`
name: sub
version: "1.0"
steps:
  - name: a
    workflow:
      name: inner
      version: "2"
      steps:
        - name: inner-step
          prompts:
            - text: hi
`);
    expect(result.diagnostics.some((d) => d.severity === "unsupported")).toBe(true);
    const nested = result.workflow?.steps[0]?.workflow;
    expect(typeof nested).toBe("object");
  });

  it("flags step.agent as unsupported without requiring prompts", () => {
    const result = parseClankerWorkflow(`
name: agents
version: "1.0"
steps:
  - name: a
    agent: ./agents/analyst.md
`);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "unsupported", path: "steps[0].agent" }),
    ]);
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(false);
  });

  it("errors when a step has no prompts, agent, or workflow", () => {
    const result = parseClankerWorkflow(`
name: empty
version: "1.0"
steps:
  - name: a
    outputs:
      x: out.txt
`);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && d.message.includes("prompts is required"),
      ),
    ).toBe(true);
  });

  it("errors on workflow + prompts together", () => {
    const result = parseClankerWorkflow(`
name: both
version: "1.0"
steps:
  - name: a
    workflow: "./other.yml"
    prompts:
      - text: hi
`);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "error" && d.message.includes("mutually exclusive"),
      ),
    ).toBe(true);
  });

  it("flags conditions and conditions_mode as unsupported", () => {
    const result = parseClankerWorkflow(`
name: dialect
version: "1.0"
steps:
  - name: a
    prompts:
      - text: hi
    conditions:
      - fn: is_ready
    conditions_mode: all
`);
    const flagged = result.diagnostics.map((d) => `${d.severity}:${d.path}`);
    expect(flagged).toContain("unsupported:steps[0].conditions");
    expect(flagged).toContain("unsupported:steps[0].conditions_mode");
  });

  it("flags run as unsupported but satisfies the prompts requirement", () => {
    const result = parseClankerWorkflow(`
name: run-step
version: "1.0"
steps:
  - name: a
    run:
      cmd: "echo hi"
`);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "unsupported", path: "steps[0].run" }),
    ]);
  });

  it("rejects a string run value", () => {
    const result = parseClankerWorkflow(`
name: bad-run
version: "1.0"
steps:
  - name: a
    run: "echo hi"
`);
    expect(result.workflow).toBeUndefined();
    expect(
      result.diagnostics.some((d) => d.severity === "error" && d.path?.startsWith("steps[0].run")),
    ).toBe(true);
  });

  it("errors on run + prompts together", () => {
    const result = parseClankerWorkflow(`
name: both
version: "1.0"
steps:
  - name: a
    run:
      cmd: "echo hi"
    prompts:
      - text: hi
`);
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "error" &&
          d.path === "steps[0]" &&
          d.message === "run and prompts are mutually exclusive",
      ),
    ).toBe(true);
  });

  it("errors on workflow + run together", () => {
    const result = parseClankerWorkflow(`
name: both
version: "1.0"
steps:
  - name: a
    workflow: "./other.yml"
    run:
      cmd: "echo hi"
`);
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "error" &&
          d.path === "steps[0]" &&
          d.message === "workflow is mutually exclusive with prompts and run",
      ),
    ).toBe(true);
  });

  it("warns that skills are ignored", () => {
    const result = parseClankerWorkflow(`
name: skills
version: "1.0"
steps:
  - name: a
    skills: [tdd]
    prompts:
      - text: hi
`);
    const diag = result.diagnostics.find((d) => d.path === "steps[0].skills");
    expect(diag?.severity).toBe("warning");
  });

  it("flags fn hooks at step and defaults level", () => {
    const result = parseClankerWorkflow(`
name: hooks
version: "1.0"
defaults:
  hooks:
    before:
      - fn: setup_workspace
steps:
  - name: a
    prompts:
      - text: hi
    hooks:
      after:
        - - fn: cleanup
            args: { x: 1 }
`);
    const paths = result.diagnostics.map((d) => `${d.severity}:${d.path}`);
    expect(paths).toContain("unsupported:defaults.hooks.before[0]");
    expect(paths).toContain("unsupported:steps[0].hooks.after[0][0]");
  });

  it("flags jinja2 template engine", () => {
    const result = parseClankerWorkflow(`
name: jinja
version: "1.0"
defaults:
  template_engine: jinja2
steps:
  - name: a
    prompts:
      - text: hi
`);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "unsupported" && d.path === "defaults.template_engine",
      ),
    ).toBe(true);
  });

  it("flags escalate handlers and fn checks", () => {
    const result = parseClankerWorkflow(`
name: qa
version: "1.0"
steps:
  - name: a
    prompts:
      - text: hi
    qa:
      checks:
        - type: fn
          fn: custom_check
      escalate:
        - type: AI
          prompt: fix it
        - type: HIL
`);
    const severities = result.diagnostics.map((d) => `${d.severity}:${d.path}`);
    expect(severities).toContain("unsupported:steps[0].qa.escalate");
    expect(severities).toContain("unsupported:steps[0].qa.checks[0]");
  });
});
