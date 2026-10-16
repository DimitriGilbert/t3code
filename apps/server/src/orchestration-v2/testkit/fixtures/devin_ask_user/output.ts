import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { DEVIN_ASK_USER_PROMPT } from "./input.ts";

/** Devin's ask-user form elicitation (`oneOf` titles) projects a user-input card. */
export function assertDevinAskUserOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRuntimeRequestKinds(projection, ["user_input"]);
  assertAllRuntimeRequestsResolved(projection);
  assertTurnItemTypes(projection, ["user_message", "user_input_request", "assistant_message"]);
  assertUserMessagesInclude(projection, [DEVIN_ASK_USER_PROMPT]);
  assertAssistantTextIncludes(projection, "devin ask user fixture complete");

  // The oneOf {const, title} entries project the title as the option label
  // and keep const as the wire value (the user's pick answers "Concise", not
  // the rendered "Minimal, compact fixture output.").
  const requestItem = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.isDefined(requestItem);
  assert.lengthOf(requestItem?.questions ?? [], 1);
  assert.equal(requestItem?.questions[0]?.id, "q0");
  assert.deepEqual(requestItem?.questions[0]?.options.map((option) => option.label).toSorted(), [
    "Detailed, expansive fixture output.",
    "Minimal, compact fixture output.",
  ]);
  assert.deepEqual(requestItem?.questions[0]?.options.map((option) => option.value).toSorted(), [
    "Concise",
    "Verbose",
  ]);

  // The accepted answer reaches Devin as the field's const value.
  const elicitationResponse = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    Reflect.get(entry.frame, "method") === "elicitation/create"
      ? [Reflect.get(entry.frame, "result")]
      : [],
  );
  assert.deepEqual(elicitationResponse, [{ action: "accept", content: { q0: "Concise" } }]);
}
