import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_PROMPT_ERROR_PROMPT = "Respond with exactly: zcode prompt error fixture";
export const ZCODE_BACKEND_ERROR_PROMPT = "Respond with exactly: zcode prompt error fixture again";
export const ZCODE_PROMPT_ERROR_RECOVERED =
  "Respond with exactly: zcode prompt error fixture recovered";

/**
 * Hand-authored: `session/prompt` fails with the bridge's structured
 * turn-failure RequestError (`data.type === "zcode_turn_failed"`, produced by
 * turnFailureRequestError in zcode-acp-server's handlers/session.js) — first a
 * rate limit carrying retryAfterMs, then an unrecoverable backend loss. The
 * next prompt still reaches the model on the same session.
 */
export function zcodePromptErrorInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ZCODE_PROMPT_ERROR_PROMPT },
      { type: "message", text: ZCODE_BACKEND_ERROR_PROMPT },
      { type: "message", text: ZCODE_PROMPT_ERROR_RECOVERED },
    ],
  };
}
