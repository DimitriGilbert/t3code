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
import { ZCODE_MODEL_SWITCH_PROMPT, ZCODE_MODEL_SWITCH_TARGET } from "./input.ts";

/**
 * The model picker's selection reaches the bridge as `session/set_config_option`
 * on the `model` option before the mode set and the first prompt. The replay
 * agent's strict expect_outbound matching is what proves the switch was sent.
 */
export function assertZcodeModelSwitchOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [ZCODE_MODEL_SWITCH_PROMPT]);
  assertAssistantTextIncludes(projection, "zcode model switch fixture");

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
  assert.deepEqual(configSets, [
    ["model", ZCODE_MODEL_SWITCH_TARGET],
    ["mode", "yolo"],
  ]);
}
