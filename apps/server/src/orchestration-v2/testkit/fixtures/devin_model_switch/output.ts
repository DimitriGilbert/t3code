import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { DEVIN_MODEL_SWITCH_PROMPT, DEVIN_MODEL_SWITCH_TARGET } from "./input.ts";

/**
 * The model picker's selection reaches Devin as `session/set_config_option`
 * on the `model` option before the first prompt. The replay agent's strict
 * expect_outbound matching is what proves the switch was sent.
 */
export function assertDevinModelSwitchOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [DEVIN_MODEL_SWITCH_PROMPT]);
  assertAssistantTextIncludes(projection, "devin model switch fixture");

  const configSets = transcript.entries.flatMap((entry) => {
    if (entry.type !== "expect_outbound") return [];
    const frame = entry.frame;
    if (
      typeof frame !== "object" ||
      frame === null ||
      Reflect.get(frame, "method") !== "session/set_config_option"
    ) {
      return [];
    }
    const params = Reflect.get(frame, "params") as Record<string, unknown>;
    return [[params.configId, params.value] as const];
  });
  // The model selection is applied before the runtime-mode set (full-access
  // → "bypass"), both before the first prompt.
  assert.deepEqual(configSets, [
    ["model", DEVIN_MODEL_SWITCH_TARGET],
    ["mode", "bypass"],
  ]);
}
