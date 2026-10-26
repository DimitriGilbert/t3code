import { describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

import { writeClankerWorkflowYaml } from "./clankerWorkflowYaml";

const COMMENTED = `# Release pipeline.
name: release
version: "1"
steps:
  # Compiles everything.
  - name: build
    timeout: 300 # five minutes
    prompts:
      - text: Build it
  # Then checks it.
  - name: test
    prompts:
      - text: Test it
`;

function objectOf(content: string): Record<string, unknown> {
  return parseYaml(content) as Record<string, unknown>;
}

describe("writeClankerWorkflowYaml", () => {
  it("keeps comments on nodes the edit did not touch", () => {
    const object = objectOf(COMMENTED);
    const steps = object["steps"] as Array<Record<string, unknown>>;
    steps[1] = { ...steps[1], description: "Runs the tests" };

    const written = writeClankerWorkflowYaml(object, COMMENTED);

    expect(written).toContain("# Release pipeline.");
    expect(written).toContain("# Compiles everything.");
    expect(written).toContain("# Then checks it.");
    expect(written).toContain("timeout: 300 # five minutes");
    expect(parseYaml(written)).toEqual(object);
  });

  it("keeps a comment on a scalar it rewrites", () => {
    const object = objectOf(COMMENTED);
    const steps = object["steps"] as Array<Record<string, unknown>>;
    steps[0] = { ...steps[0], timeout: 900 };

    const written = writeClankerWorkflowYaml(object, COMMENTED);

    expect(written).toContain("timeout: 900 # five minutes");
  });

  it("carries a step's comment with it when the step moves", () => {
    const object = objectOf(COMMENTED);
    const steps = object["steps"] as Array<Record<string, unknown>>;
    object["steps"] = [steps[1], steps[0]];

    const written = writeClankerWorkflowYaml(object, COMMENTED);

    expect(written).toBe(`# Release pipeline.
name: release
version: "1"
steps:
  # Then checks it.
  - name: test
    prompts:
      - text: Test it
  # Compiles everything.
  - name: build
    timeout: 300 # five minutes
    prompts:
      - text: Build it
`);
  });

  it("appends keys the document did not have and drops removed ones with their comments", () => {
    const object = objectOf(COMMENTED);
    const steps = object["steps"] as Array<Record<string, unknown>>;
    const { timeout: _timeout, ...withoutTimeout } = steps[0] ?? {};
    steps[0] = withoutTimeout;
    object["description"] = "Ship it";

    const written = writeClankerWorkflowYaml(object, COMMENTED);

    expect(written).toContain("description: Ship it");
    expect(written).not.toContain("five minutes");
    expect(written).toContain("# Compiles everything.");
    expect(parseYaml(written)).toEqual(object);
  });

  it("re-stringifies instead of mutating when the document uses aliases", () => {
    const aliased = `name: release
version: "1"
x-shared: &shared
  text: Build it
steps:
  # Lost on rewrite.
  - name: build
    prompts:
      - *shared
`;
    const object = objectOf(aliased);
    object["name"] = "renamed";

    const written = writeClankerWorkflowYaml(object, aliased);

    expect(written).not.toContain("# Lost on rewrite.");
    expect(parseYaml(written)).toEqual(object);
  });

  it("stringifies from scratch for a document that is not a map or is empty", () => {
    expect(writeClankerWorkflowYaml({ name: "fresh" }, "")).toBe("name: fresh\n");
    expect(writeClankerWorkflowYaml({ name: "fresh" }, "- a list\n")).toBe("name: fresh\n");
    expect(writeClankerWorkflowYaml({ name: "fresh" }, "name: [unclosed")).toBe("name: fresh\n");
  });

  it("rewrites values whose kind changed and keeps long lines unfolded", () => {
    const base = 'name: n\nversion: "1"\nsteps:\n  - name: one\n    workflow: other.yaml\n';
    const object = objectOf(base);
    const steps = object["steps"] as Array<Record<string, unknown>>;
    steps[0] = {
      name: "one",
      workflow: { name: "inline", version: "1", steps: [{ name: "inner" }] },
      prompts: [{ text: `a ${"long ".repeat(40)}prompt` }],
    };

    const written = writeClankerWorkflowYaml(object, base);

    expect(parseYaml(written)).toEqual(object);
    expect(written.split("\n").some((line) => line.includes("long long"))).toBe(true);
  });
});
