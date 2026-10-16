import type { OrchestratorFixtureInput } from "../shared.ts";

export const DEVIN_MODEL_SWITCH_PROMPT = "Respond with exactly: devin model switch fixture";
/** A real slug from `devin acp`'s `model` config option (`swe-2-high` is its session default). */
export const DEVIN_MODEL_SWITCH_TARGET = "swe-1-7-lightning-medium";

/**
 * A non-default model selection goes through Devin's `model` config option
 * (`session/set_config_option`), not session setup state.
 */
export function devinModelSwitchInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: DEVIN_MODEL_SWITCH_PROMPT }],
  };
}
