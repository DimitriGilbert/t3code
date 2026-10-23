import { describe, expect, it } from "vite-plus/test";

import {
  evalClankerCondition,
  renderClankerTemplate,
  resolveClankerRef,
  type ClankerRefContext,
} from "./refs.ts";

const ctx: ClankerRefContext = {
  env: { CI: "true", USER: "dev" },
  stepOutputs: {
    build: { artifact: "dist/app.tar" },
  },
  values: { who: "world", nested: { deep: 42 } },
};

describe("resolveClankerRef", () => {
  it("resolves env vars", () => {
    expect(resolveClankerRef("env.USER", ctx)).toBe("dev");
  });

  it("resolves step outputs", () => {
    expect(resolveClankerRef("steps.build.outputs.artifact", ctx)).toBe("dist/app.tar");
  });

  it("returns bare literals unchanged", () => {
    expect(resolveClankerRef("just-a-string", ctx)).toBe("just-a-string");
  });

  it("returns undefined for missing refs", () => {
    expect(resolveClankerRef("env.MISSING", ctx)).toBeUndefined();
    expect(resolveClankerRef("steps.build.outputs.nope", ctx)).toBeUndefined();
    expect(resolveClankerRef("steps.ghost.outputs.x", ctx)).toBeUndefined();
    expect(resolveClankerRef("steps.build.responses", ctx)).toBeUndefined();
  });

  it("rejects prototype-polluting keys", () => {
    expect(resolveClankerRef("env.__proto__", ctx)).toBeUndefined();
    expect(resolveClankerRef("steps.x.outputs.__proto__", ctx)).toBeUndefined();
  });
});

describe("renderClankerTemplate", () => {
  it("interpolates top-level values", () => {
    const { text, diagnostics } = renderClankerTemplate("Hello {{who}}!", ctx);
    expect(text).toBe("Hello world!");
    expect(diagnostics).toEqual([]);
  });

  it("interpolates env and step output refs", () => {
    const { text } = renderClankerTemplate(
      "{{env.USER}} shipped {{steps.build.outputs.artifact}}",
      ctx,
    );
    expect(text).toBe("dev shipped dist/app.tar");
  });

  it("interpolates dotted value paths and numbers", () => {
    const { text } = renderClankerTemplate("depth {{nested.deep}}", ctx);
    expect(text).toBe("depth 42");
  });

  it("renders missing refs as empty strings", () => {
    const { text } = renderClankerTemplate("[{{missing}}]", ctx);
    expect(text).toBe("[]");
  });

  it("tolerates whitespace inside braces", () => {
    const { text } = renderClankerTemplate("{{  who  }}", ctx);
    expect(text).toBe("world");
  });

  it("flags block helpers and else as unsupported", () => {
    const { text, diagnostics } = renderClankerTemplate("{{#if x}}y{{else}}n{{/if}}", ctx);
    expect(diagnostics.filter((d) => d.severity === "unsupported").length).toBe(3);
    expect(text).toBe("yn");
  });

  it("flags unbalanced braces", () => {
    const { diagnostics } = renderClankerTemplate("oops {{unclosed", ctx);
    expect(diagnostics.some((d) => d.severity === "unsupported")).toBe(true);
  });
});

describe("evalClankerCondition", () => {
  it("evaluates bare ref truthiness", () => {
    expect(evalClankerCondition("env.CI", ctx)).toBe(true);
    expect(evalClankerCondition("env.MISSING", ctx)).toBe(false);
    expect(evalClankerCondition("who", ctx)).toBe(true);
  });

  it("negates refs", () => {
    expect(evalClankerCondition("!env.MISSING", ctx)).toBe(true);
    expect(evalClankerCondition("!env.CI", ctx)).toBe(false);
  });

  it("compares refs to single-quoted literals", () => {
    expect(evalClankerCondition("env.CI == 'true'", ctx)).toBe(true);
    expect(evalClankerCondition("env.CI == 'false'", ctx)).toBe(false);
    expect(evalClankerCondition("env.CI != 'false'", ctx)).toBe(true);
  });

  it("compares refs to double-quoted literals", () => {
    expect(evalClankerCondition('env.CI == "true"', ctx)).toBe(true);
    expect(evalClankerCondition('env.USER != "root"', ctx)).toBe(true);
  });

  it("compares step output refs", () => {
    expect(evalClankerCondition("steps.build.outputs.artifact == 'dist/app.tar'", ctx)).toBe(true);
  });

  it("returns undefined for unevaluable syntax", () => {
    expect(evalClankerCondition("env.CI === 'true'", ctx)).toBeUndefined();
    expect(evalClankerCondition("a && b", ctx)).toBeUndefined();
    expect(evalClankerCondition("fn.check(args)", ctx)).toBeUndefined();
    expect(evalClankerCondition("", ctx)).toBeUndefined();
  });
});
