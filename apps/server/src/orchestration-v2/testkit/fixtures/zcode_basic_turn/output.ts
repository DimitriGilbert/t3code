import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypeSequence,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { ZCODE_BASIC_TURN_PROMPT } from "./input.ts";

/** One full-access turn: reasoning, a Bash tool call, then the reply. */
export function assertZcodeBasicTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypeSequence(projection, [
    "user_message",
    "reasoning",
    "command_execution",
    "assistant_message",
    "checkpoint",
  ]);
  assertUserMessagesInclude(projection, [ZCODE_BASIC_TURN_PROMPT]);

  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.deepEqual(
    commands.map((item) => [
      item.type === "command_execution" ? item.input : null,
      item.status,
      item.type === "command_execution" ? item.output : null,
    ]),
    [["echo zcode basic turn fixture", "completed", "zcode basic turn fixture"]],
  );

  const reasoningTexts = projection.turnItems.flatMap((item) =>
    item.type === "reasoning" ? [item.text] : [],
  );
  assert.deepEqual(reasoningTexts, [
    'The user wants me to run `echo zcode basic turn fixture` and then reply with exactly "done".',
  ]);

  const assistantTexts = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(assistantTexts, ["done"]);

  // The state.usage patch surfaces as the thread's live context gauge.
  assert.deepInclude(projection.providerThreads[0]?.contextUsage, {
    usedTokens: 24401,
    maxTokens: 200000,
  });
}
