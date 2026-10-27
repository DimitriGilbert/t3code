import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_PROMPT_ERROR_PROMPT = "Respond with exactly: zcode prompt error fixture";
export const ZCODE_PROMPT_ERROR_RECOVERED =
  "Respond with exactly: zcode prompt error fixture recovered";

/**
 * Hand-authored: an accepted input whose turn ends with a `failed` turnHeader
 * and `control.lastError`. The session stays loaded (completedInterrupted
 * phase), so the next prompt reaches the model on the same session.
 */
export function zcodePromptErrorInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ZCODE_PROMPT_ERROR_PROMPT },
      { type: "message", text: ZCODE_PROMPT_ERROR_RECOVERED },
    ],
  };
}
