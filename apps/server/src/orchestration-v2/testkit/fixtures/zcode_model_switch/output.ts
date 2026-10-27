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
import { ZCODE_MODEL_SWITCH_PROMPT } from "./input.ts";

/**
 * The session snapshot still reports GLM-5.3 while the run selected
 * GLM-5.3-Turbo, so the adapter converges config via `switchModelConfig`
 * before `sendText`, which also pins the per-input modelSelection.
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

  const commands = transcript.entries.flatMap((entry) => {
    if (entry.type !== "expect_outbound") return [];
    const frame = entry.frame;
    if (
      typeof frame !== "object" ||
      frame === null ||
      Reflect.get(frame, "method") !== "v4/command"
    ) {
      return [];
    }
    const params = Reflect.get(frame, "params") as Record<string, unknown>;
    return [[params.type, params.payload] as const];
  });
  const switchCommand = commands.find(([type]) => type === "switchModelConfig");
  assert.deepEqual(switchCommand?.[1], {
    provider: "account:zai-individual-coding-plan",
    model: "GLM-5.3-Turbo",
    thought: "max",
  });
  const sendText = commands.find(([type]) => type === "sendText");
  assert.isDefined(sendText);
  assert.deepEqual((sendText?.[1] as Record<string, unknown> | undefined)?.modelSelection, {
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3-Turbo",
    options: { reasoningLevel: "max" },
  });
}
