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
import { ZCODE_ASK_USER_PROMPT } from "./input.ts";

/** The bridge's AskUserQuestion form elicitation projects a user-input card. */
export function assertZcodeAskUserOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRuntimeRequestKinds(projection, ["user_input"]);
  assertAllRuntimeRequestsResolved(projection);
  assertTurnItemTypes(projection, ["user_message", "user_input_request", "assistant_message"]);
  assertUserMessagesInclude(projection, [ZCODE_ASK_USER_PROMPT]);
  assertAssistantTextIncludes(projection, "zcode ask user fixture complete");

  // Question ids are the bridge's form field keys; the titled `oneOf` choice
  // list includes its skip sentinel without breaking option extraction.
  const requestItem = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.isDefined(requestItem);
  assert.equal(requestItem?.questions[0]?.id, "q_0");
  assert.deepEqual(
    requestItem?.questions[0]?.options.map((option) => option.label),
    ["concise", "verbose", "Skip this question"],
  );

  // The selected dropdown value reaches the bridge as the field's answer.
  const elicitationResponse = transcript.entries.find(
    (entry) =>
      entry.type === "expect_outbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      Reflect.get(entry.frame, "method") === "elicitation/create",
  );
  assert.isDefined(elicitationResponse);
}
