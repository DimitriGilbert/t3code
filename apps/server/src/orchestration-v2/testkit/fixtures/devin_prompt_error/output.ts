import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { DEVIN_PROMPT_ERROR_PROMPT } from "./input.ts";

/**
 * Devin's structured request error (`-32016` +
 * `cognition.ai/errorKind: "session_not_found"`) projects a provider_error
 * failure carrying the error kind as its code and the retryable hint —
 * `devinPromptFailure`'s mapping.
 */
export function assertDevinPromptErrorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["failed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [DEVIN_PROMPT_ERROR_PROMPT]);

  const item = projection.turnItems.find((candidate) => candidate.type === "error");
  if (item?.type !== "error") throw new Error("expected an error turn item");
  assert.equal(item.failure.class, "provider_error");
  assert.equal(item.failure.code, "session_not_found");
  assert.equal(item.failure.message, "Session not found");
  assert.equal(item.failure.retryable, false);
}
