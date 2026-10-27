import type { OrchestratorFixtureInput } from "../shared.ts";

export const ZCODE_MODEL_SWITCH_PROMPT = "Respond with exactly: zcode model switch fixture";
/** T3 model slug: `<providerId>/<modelId>` for the Turbo variant. */
export const ZCODE_MODEL_SWITCH_TARGET = "account:zai-individual-coding-plan/GLM-5.3-Turbo";

/**
 * A non-default model selection goes through `v4/command switchModelConfig`
 * when the session's live config still names the previous model.
 */
export function zcodeModelSwitchInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: ZCODE_MODEL_SWITCH_PROMPT }],
  };
}
