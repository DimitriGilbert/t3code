import { describe, expect, it } from "vite-plus/test";

import { acpElicitationFormQuestions } from "./adapter.ts";

describe("acpElicitationFormQuestions", () => {
  it("maps flat enum fields to same-valued options", () => {
    const questions = acpElicitationFormQuestions({
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            title: "Which color?",
            enum: ["red", "blue"],
          },
        },
      },
    });
    expect(questions).toEqual([
      {
        id: "choice",
        header: "Which color?",
        question: "Pick one",
        options: [
          { label: "red", description: "red" },
          { label: "blue", description: "blue" },
        ],
      },
    ]);
  });

  it("maps oneOf/anyOf const+title variants with the sentinel value preserved", () => {
    // ZCode's AskUserQuestion form: titled options where the wire value is the
    // `const` (e.g. the `__skip__` sentinel behind a readable title).
    const questions = acpElicitationFormQuestions({
      message: "Please answer the question.",
      requestedSchema: {
        type: "object",
        properties: {
          q_0: {
            type: "string",
            title: "Which approach?",
            oneOf: [
              { const: "fast", title: "Fast path" },
              { const: "__skip__", title: "Skip this question" },
            ],
          },
          q_0_other: {
            type: "string",
            title: "or type a custom value",
          },
        },
      },
    });
    expect(questions).toHaveLength(2);
    expect(questions[0]?.options).toEqual([
      { label: "Fast path", description: "Fast path", value: "fast" },
      { label: "Skip this question", description: "Skip this question", value: "__skip__" },
    ]);
    // Free-text companion fields keep no options.
    expect(questions[1]?.options).toEqual([]);
  });

  it("reads array item choices as multi-select", () => {
    const questions = acpElicitationFormQuestions({
      message: "Pick any",
      requestedSchema: {
        type: "object",
        properties: {
          q_0: {
            type: "array",
            title: "Which files?",
            items: { anyOf: [{ const: "a.ts", title: "a.ts" }, { const: "b.ts" }] },
          },
        },
      },
    });
    expect(questions[0]?.multiSelect).toBe(true);
    expect(questions[0]?.options).toEqual([
      { label: "a.ts", description: "a.ts" },
      { label: "b.ts", description: "b.ts" },
    ]);
  });

  it("keeps the boolean fallback and empty-property edge cases", () => {
    const questions = acpElicitationFormQuestions({
      message: "Confirm?",
      requestedSchema: {
        type: "object",
        properties: { ok: { type: "boolean", title: "Proceed?" } },
      },
    });
    expect(questions[0]?.options).toEqual([
      { label: "true", description: "Yes" },
      { label: "false", description: "No" },
    ]);
    expect(
      acpElicitationFormQuestions({ message: "m", requestedSchema: { type: "object" } }),
    ).toEqual([]);
    expect(acpElicitationFormQuestions({ message: "m", requestedSchema: "junk" })).toEqual([]);
  });
});
