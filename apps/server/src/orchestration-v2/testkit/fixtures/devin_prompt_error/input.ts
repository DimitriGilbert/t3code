import type { OrchestratorFixtureInput } from "../shared.ts";

export const DEVIN_PROMPT_ERROR_PROMPT = "Respond with exactly: devin prompt error fixture";

/**
 * Hand-edited from a real recording: `session/prompt` fails the way Devin
 * answers a prompt for a session it no longer knows — `code: -32016` with
 * `data:{"cognition.ai/errorKind":"session_not_found","cognition.ai/retryable":false}`
 * (captured live in the p4 probes). Every other frame is real wire data.
 */
export function devinPromptErrorInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: DEVIN_PROMPT_ERROR_PROMPT }],
  };
}
