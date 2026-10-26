import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { parse as parseYaml } from "yaml";

import { render } from "../../../test/render";
import { ClankerWorkflowForm } from "./ClankerWorkflowForm";
import {
  parseClankerWorkflowDraft,
  serializeClankerWorkflowDraft,
  type ClankerWorkflowDraft,
} from "./clankerWorkflowForm";

const WORKFLOW = `name: release
version: "1"
description: Ship it
defaults:
  model: gpt-5
  qa:
    on_fail: abort
secrets:
  - OPENAI_API_KEY
steps:
  - name: build
    description: Compile everything
    timeout: 300
    env:
      NODE_ENV: production
    models:
      - id: gpt-5
    prompts:
      - text: Build the project
      - file: prompts/check.md
    hooks:
      after:
        - cmd: echo done
    qa:
      checks:
        - type: ref
          target: shared/lint
    custom_key: kept
  - name: test
    depends_on:
      - build
    prompts:
      - text: Run the tests
`;

function draftOf(content: string): ClankerWorkflowDraft {
  const parsed = parseClankerWorkflowDraft(content);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.draft;
}

function Harness({ initial }: { readonly initial: ClankerWorkflowDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <ClankerWorkflowForm draft={draft} disabled={false} onChange={setDraft} />
      <pre data-testid="yaml">{serializeClankerWorkflowDraft(draft)}</pre>
    </>
  );
}

function yamlOf(container: HTMLElement): Record<string, unknown> {
  const text = container.querySelector('[data-testid="yaml"]')?.textContent ?? "";
  return parseYaml(text) as Record<string, unknown>;
}

describe("ClankerWorkflowForm", () => {
  it("renders every section of a fully populated workflow", async () => {
    await using screen = await render(<Harness initial={draftOf(WORKFLOW)} />);

    await expect.element(screen.getByLabelText("Workflow name")).toHaveValue("release");
    await expect.element(screen.getByLabelText("Step 1 name")).toHaveValue("build");
    await expect
      .element(screen.getByLabelText("Step 1 prompt 1 text"))
      .toHaveValue("Build the project");
    await expect
      .element(screen.getByLabelText("Step 1 prompt 2 file"))
      .toHaveValue("prompts/check.md");
    await expect.element(screen.getByLabelText("Step 1 model 1 id")).toHaveValue("gpt-5");
    await expect.element(screen.getByLabelText("Step 1 environment key 1")).toHaveValue("NODE_ENV");
    await expect.element(screen.getByLabelText("Step 1 hook 1 command")).toHaveValue("echo done");
    await expect.element(screen.getByLabelText("Step 1 check 1 target")).toHaveValue("shared/lint");
    await expect.element(screen.getByLabelText("Secret 1")).toHaveValue("OPENAI_API_KEY");
    await expect.element(screen.getByLabelText("Default model")).toHaveValue("gpt-5");
  });

  it("writes form edits back to YAML and keeps unrendered keys", async () => {
    await using screen = await render(<Harness initial={draftOf(WORKFLOW)} />);

    await userEvent.fill(screen.getByLabelText("Step 1 description"), "Compile it all");

    const document = yamlOf(screen.container);
    const steps = document["steps"] as ReadonlyArray<Record<string, unknown>>;
    expect(steps[0]?.["description"]).toBe("Compile it all");
    expect(steps[0]?.["custom_key"]).toBe("kept");
    expect(steps[0]?.["timeout"]).toBe(300);
    expect(steps[1]?.["depends_on"]).toEqual(["build"]);
  });

  it("adds and reorders steps", async () => {
    await using screen = await render(<Harness initial={draftOf(WORKFLOW)} />);

    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.fill(screen.getByLabelText("Step 3 name"), "deploy");
    await userEvent.fill(screen.getByLabelText("Step 3 prompt 1 text"), "Ship it");
    await userEvent.click(screen.getByRole("button", { name: "Move test down" }));

    const steps = yamlOf(screen.container)["steps"] as ReadonlyArray<Record<string, unknown>>;
    expect(steps.map((step) => step["name"])).toEqual(["build", "deploy", "test"]);
  });

  it("toggles a dependency on a sibling step", async () => {
    await using screen = await render(<Harness initial={draftOf(WORKFLOW)} />);

    await userEvent.click(screen.getByRole("button", { name: "test", exact: true }));

    const steps = yamlOf(screen.container)["steps"] as ReadonlyArray<Record<string, unknown>>;
    expect(steps[0]?.["depends_on"]).toEqual(["test"]);
  });
});
