import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_BASIC_TURN_PROMPT =
  "Run `echo zcode basic turn fixture` in the terminal, then respond with exactly: done";

/**
 * Hand-shaped from the P0 live transcript
 * (`.plans/zcode-integration/transcripts/05-real-turn.ndjson`): storage gate,
 * createSession, subscribe, sendText, then row deltas — reasoning, a Bash
 * tool call, the assistant reply, and the terminal turnHeader.
 */
export function zcodeBasicTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: ZCODE_BASIC_TURN_PROMPT }],
  };
}
