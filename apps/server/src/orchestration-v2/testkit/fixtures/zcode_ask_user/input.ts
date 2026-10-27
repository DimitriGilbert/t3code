import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_ASK_USER_PROMPT =
  "Ask which output style this fixture should use — concise or verbose — then answer exactly: zcode ask user fixture complete";

/**
 * AskUserQuestion arrives as a `pendingInteractions` `userInput` entry whose
 * `questions` carry the option list; the answer goes back through
 * `resolveInteraction` with the upstream `answers` content map keyed on the
 * question text.
 */
export function zcodeAskUserInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ZCODE_ASK_USER_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: { style: "concise" },
      },
    ],
  };
}
