import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_ASK_USER_PROMPT =
  "Ask which output style this fixture should use — concise or verbose — then answer exactly: zcode ask user fixture complete";

/**
 * AskUserQuestion reaches T3 as a form-mode `elicitation/create` because the
 * bridge sees the advertised `elicitation.form` capability: one titled `oneOf`
 * dropdown field per question (`q_<i>`, with a `__skip__` sentinel) plus a
 * free-text `q_<i>_other` companion (interaction/adapter.js
 * buildAskUserElicitationForm).
 */
export function zcodeAskUserInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ZCODE_ASK_USER_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: { q_0: "concise" },
      },
    ],
  };
}
