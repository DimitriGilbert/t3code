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

/** The pendingInteractions userInput projects a user-input card. */
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

  // Question ids are the deduped zcode headers; options come from the payload.
  const requestItem = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.isDefined(requestItem);
  assert.equal(requestItem?.questions[0]?.id, "style");
  assert.deepEqual(
    requestItem?.questions[0]?.options.map((option) => option.label),
    ["concise", "verbose"],
  );

  // The answer reaches the app-server as a resolveInteraction content map.
  const resolutions = transcript.entries.flatMap((entry) => {
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
    return params.type === "resolveInteraction" ? [params.payload] : [];
  });
  assert.deepEqual(resolutions, [
    {
      interactionId: "int-1",
      answer: {
        action: "accept",
        content: {
          answer_0: "concise",
          answer: "concise",
          answers: { "Which output style should this fixture use?": "concise" },
        },
      },
    },
  ]);
}
