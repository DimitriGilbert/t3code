import { describe, expect, it } from "vite-plus/test";

import { applyClankerStepDefaults, applyClankerWorkflowDefaults } from "./defaults.ts";
import type { ClankerDefaults, ClankerStep } from "./format.ts";

const step = (overrides: Partial<ClankerStep>): ClankerStep => ({
  name: "s",
  ...overrides,
});

describe("applyClankerStepDefaults", () => {
  it("returns the step unchanged without defaults", () => {
    const s = step({ timeout: 5 });
    expect(applyClankerStepDefaults(s, undefined)).toBe(s);
  });

  it("fills unset scalar fields from defaults and keeps step values that win", () => {
    const defaults: ClankerDefaults = {
      timeout: 30,
      retry: 2,
      concurrency: 4,
      template_engine: "handlebars",
      output_format: "json",
    };
    const s = step({ timeout: 10, retry: 0 });
    const merged = applyClankerStepDefaults(s, defaults);
    expect(merged.timeout).toBe(10);
    expect(merged.retry).toBe(0);
    expect(merged.concurrency).toBe(4);
    expect(merged.template_engine).toBe("handlebars");
    expect(merged.output_format).toBe("json");
  });

  it("turns defaults.model/provider into a single model when the step has none", () => {
    const merged = applyClankerStepDefaults(step({}), {
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
    expect(merged.models).toEqual([{ id: "claude-sonnet-4-20250514", provider: "anthropic" }]);
  });

  it("omits provider on the synthesized model when defaults.provider is unset", () => {
    const merged = applyClankerStepDefaults(step({}), { model: "gpt-5" });
    expect(merged.models).toEqual([{ id: "gpt-5" }]);
  });

  it("uses the default model id when only defaults.provider is set", () => {
    const merged = applyClankerStepDefaults(step({}), { provider: "anthropic" });
    expect(merged.models).toEqual([{ id: "default", provider: "anthropic" }]);
  });

  it("does not inject defaults.provider into explicitly-declared step models", () => {
    const merged = applyClankerStepDefaults(
      step({ models: [{ id: "gpt-5" }, { id: "o3", provider: "openai" }] }),
      { model: "claude-sonnet-4-20250514", provider: "anthropic" },
    );
    expect(merged.models).toEqual([{ id: "gpt-5" }, { id: "o3", provider: "openai" }]);
  });

  it("merges hooks per phase with step entries first, then defaults entries", () => {
    const merged = applyClankerStepDefaults(step({ hooks: { before: [{ cmd: "step-before" }] } }), {
      hooks: {
        before: [{ cmd: "defaults-before" }],
        after: [[{ cmd: "defaults-after-a" }, { cmd: "defaults-after-b" }]],
      },
    });
    expect(merged.hooks?.["before"]).toEqual([{ cmd: "step-before" }, { cmd: "defaults-before" }]);
    // Phases only in defaults survive.
    expect(merged.hooks?.["after"]).toEqual([
      [{ cmd: "defaults-after-a" }, { cmd: "defaults-after-b" }],
    ]);
  });

  it("keeps step-only hook phases", () => {
    const merged = applyClankerStepDefaults(
      step({ hooks: { on_error: [{ cmd: "step-cleanup" }] } }),
      { hooks: { before: [{ cmd: "defaults-before" }] } },
    );
    expect(merged.hooks?.["on_error"]).toEqual([{ cmd: "step-cleanup" }]);
    expect(merged.hooks?.["before"]).toEqual([{ cmd: "defaults-before" }]);
  });

  it("leaves hooks unset when neither side declares them", () => {
    const merged = applyClankerStepDefaults(step({}), { timeout: 5 });
    expect(merged.hooks).toBeUndefined();
  });

  it("concatenates qa checks with step checks first", () => {
    const merged = applyClankerStepDefaults(
      step({ qa: { checks: [{ type: "cmd", cmd: "step-check" }] } }),
      { qa: { checks: [{ type: "cmd", cmd: "defaults-check" }] } },
    );
    expect(merged.qa?.checks).toEqual([
      { type: "cmd", cmd: "step-check" },
      { type: "cmd", cmd: "defaults-check" },
    ]);
  });

  it("falls back per field for qa.on_fail and qa.escalate", () => {
    const merged = applyClankerStepDefaults(step({ qa: { on_fail: "continue" } }), {
      qa: {
        on_fail: "abort",
        escalate: [{ type: "AI", prompt: "try harder" }],
      },
    });
    expect(merged.qa?.on_fail).toBe("continue");
    expect(merged.qa?.escalate).toEqual([{ type: "AI", prompt: "try harder" }]);
  });

  it("lets the step's qa.escalate win over the defaults'", () => {
    const merged = applyClankerStepDefaults(step({ qa: { escalate: [{ type: "HIL" }] } }), {
      qa: { escalate: [{ type: "AI", prompt: "defaults" }], on_fail: "abort" },
    });
    expect(merged.qa?.escalate).toEqual([{ type: "HIL" }]);
    expect(merged.qa?.on_fail).toBe("abort");
  });

  it("adopts defaults.qa wholesale when the step has none", () => {
    const defaultsQa: NonNullable<ClankerDefaults["qa"]> = {
      on_fail: "abort",
      checks: [{ type: "ref", target: "s" }],
    };
    const merged = applyClankerStepDefaults(step({}), { qa: defaultsQa });
    expect(merged.qa).toEqual(defaultsQa);
  });
});

describe("applyClankerWorkflowDefaults", () => {
  it("applies defaults to every step", () => {
    const merged = applyClankerWorkflowDefaults({
      name: "wf",
      version: "1",
      defaults: { timeout: 30 },
      steps: [step({}), step({ name: "other", timeout: 1 })],
    });
    expect(merged.steps[0]?.timeout).toBe(30);
    expect(merged.steps[1]?.timeout).toBe(1);
  });
});
