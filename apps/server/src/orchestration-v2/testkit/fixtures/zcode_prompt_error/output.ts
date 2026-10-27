import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { ZCODE_PROMPT_ERROR_PROMPT, ZCODE_PROMPT_ERROR_RECOVERED } from "./input.ts";

const ZCODE_BACKEND_ERROR_TEXT = "ZCode turn failed: backend session lost";

/**
 * A `failed` turnHeader projects a failed run whose `control.lastError` text
 * lands on the provider_error failure; the surviving session then takes the
 * follow-up turn without a fresh handshake.
 */
export function assertZcodePromptErrorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["failed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [ZCODE_PROMPT_ERROR_PROMPT, ZCODE_PROMPT_ERROR_RECOVERED]);

  const failedRun = projection.runs.find((candidate) => candidate.ordinal === 1);
  const failureItem = projection.turnItems.find(
    (candidate) => candidate.runId === failedRun?.id && candidate.type === "error",
  );
  if (failureItem?.type !== "error") throw new Error("expected an error item on run 1");
  assert.equal(failureItem.failure.message, ZCODE_BACKEND_ERROR_TEXT);
  assert.equal(failureItem.failure.class, "provider_error");

  // No fresh createSession: the follow-up reuses conversation s1 (one
  // createSession + one sendText per run only).
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
    return [(Reflect.get(frame, "params") as Record<string, unknown>).type];
  });
  assert.deepEqual(commands.filter((type) => type === "createSession").length, 1);
  assert.deepEqual(commands.filter((type) => type === "sendText").length, 2);

  const recoveredTexts = projection.turnItems.flatMap((item) =>
    item.runId === projection.runs[1]?.id && item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(recoveredTexts, ["zcode prompt error fixture recovered"]);
}
