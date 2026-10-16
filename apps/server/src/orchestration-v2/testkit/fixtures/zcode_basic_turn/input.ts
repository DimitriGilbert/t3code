import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_BASIC_TURN_PROMPT =
  "Run `echo zcode basic turn fixture` in the terminal, then respond with exactly: done";

/**
 * Recorded live via `scripts/record-zcode-acp-replay-fixture.ts` against a real
 * `zcode-acp-server` + headless `~/.zcode` backend: reasoning chunks
 * (`agent_thought_chunk`), a terminal tool call, then the assistant reply.
 */
export function zcodeBasicTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: ZCODE_BASIC_TURN_PROMPT }],
  };
}
