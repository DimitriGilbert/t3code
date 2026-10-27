import type { OrchestratorFixtureInput } from "../shared.ts";

export const DEVIN_ASK_USER_PROMPT =
  "Use your ask-user / question tool to ask me whether this fixture should use a concise or verbose style, presenting them as selectable options. After I answer, reply exactly: devin ask user fixture complete";

/**
 * Devin's ask-user tool reaches T3 as a form-mode `elicitation/create`: one
 * `oneOf` field of `{const, title}` entries, where `const` stays the wire
 * value (verified live).
 */
export function devinAskUserInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: DEVIN_ASK_USER_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: { q0: "Concise" },
      },
    ],
  };
}
