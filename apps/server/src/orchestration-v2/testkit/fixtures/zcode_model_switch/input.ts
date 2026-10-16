import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_MODEL_SWITCH_PROMPT = "Respond with exactly: zcode model switch fixture";
/** The bridge's `providerId\modelId` encoding for the Turbo variant. */
export const ZCODE_MODEL_SWITCH_TARGET = "builtin:bigmodel-coding-plan\\GLM-5.3-Turbo";

/**
 * A non-default model selection goes through the bridge's `model` config
 * option (`session/set_config_option`), not session setup `models` state.
 */
export function zcodeModelSwitchInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: ZCODE_MODEL_SWITCH_PROMPT }],
  };
}
