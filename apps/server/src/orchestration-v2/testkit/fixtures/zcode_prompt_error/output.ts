import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  ZCODE_BACKEND_ERROR_PROMPT,
  ZCODE_PROMPT_ERROR_PROMPT,
  ZCODE_PROMPT_ERROR_RECOVERED,
} from "./input.ts";

export const ZCODE_RATE_LIMIT_TEXT =
  "ZCode turn failed: model request failed: HTTP 429 quota exceeded";
export const ZCODE_BACKEND_ERROR_TEXT = "ZCode turn failed: backend session lost";

/**
 * Both bridge failures project the backend's own code; the 429 maps to a
 * usage-limit run with a Retry-After deadline, the backend loss stays a plain
 * provider error, and neither poisons the session for the follow-up.
 */
export function assertZcodePromptErrorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["failed", "failed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    ZCODE_PROMPT_ERROR_PROMPT,
    ZCODE_BACKEND_ERROR_PROMPT,
    ZCODE_PROMPT_ERROR_RECOVERED,
  ]);

  const runFailure = (ordinal: number) => {
    const run = projection.runs.find((candidate) => candidate.ordinal === ordinal);
    const item = projection.turnItems.find(
      (candidate) => candidate.runId === run?.id && candidate.type === "error",
    );
    if (item?.type !== "error") throw new Error(`expected an error item on run ${ordinal}`);
    return item.failure;
  };

  const rateLimited = runFailure(1);
  assert.equal(rateLimited.message, ZCODE_RATE_LIMIT_TEXT);
  assert.equal(rateLimited.class, "usage_limit");
  assert.equal(rateLimited.code, "rate_limit");
  // retryAfterMs resolved against wall-clock now into an ISO deadline.
  assert.isString(rateLimited.resetAt);
  assert.isTrue(Number.isFinite(Date.parse(rateLimited.resetAt!)));

  const backendLost = runFailure(2);
  assert.equal(backendLost.message, ZCODE_BACKEND_ERROR_TEXT);
  assert.equal(backendLost.class, "provider_error");
  assert.equal(backendLost.code, "backend_lost");
  assert.isUndefined(backendLost.resetAt);

  const recoveredTexts = projection.turnItems.flatMap((item) =>
    item.runId === projection.runs[2]?.id && item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(recoveredTexts, ["zcode prompt error fixture recovered"]);
}
