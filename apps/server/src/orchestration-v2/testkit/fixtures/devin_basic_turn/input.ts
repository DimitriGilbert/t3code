import type { OrchestratorFixtureInput } from "../shared.ts";

export const DEVIN_BASIC_TURN_COMMAND = "echo devin basic turn fixture";
export const DEVIN_BASIC_TURN_PROMPT = `Run \`${DEVIN_BASIC_TURN_COMMAND}\` in the terminal, then respond with exactly: done`;

/**
 * Recorded live via `scripts/record-devin-acp-replay-fixture.ts` against a
 * real `devin acp`: thought chunks, an exec tool call that runs through T3's
 * client terminals (`terminal/create` → `wait_for_exit` → `output` →
 * `release`), then the assistant reply and end_turn.
 */
export function devinBasicTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: DEVIN_BASIC_TURN_PROMPT }],
  };
}
