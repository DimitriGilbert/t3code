import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_BASIC_TURN_PROMPT = "Respond with exactly: zcode basic turn fixture";

/**
 * Hand-authored: the bridge's ACP surface is stable JSON-RPC, and no live
 * `zcode-acp-server`/`zcode` pair exists in CI. Shapes mirror
 * zcode-acp-server@0.72.0 (`dist/server.js` initialize, `dist/config/options.js`
 * buildConfigOptions/buildModes, `dist/handlers/dispatch.js` update kinds).
 */
export function zcodeBasicTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: ZCODE_BASIC_TURN_PROMPT }],
  };
}
