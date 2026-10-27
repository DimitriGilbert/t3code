import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";
import { ZCODE_PERMISSION_APPROVED_COMMAND, ZCODE_PERMISSION_DECLINED_COMMAND } from "./input.ts";

/**
 * Both commands surface as `pendingInteractions` permissions resolved through
 * `v4/command resolveInteraction`: the approved one runs; the declined one
 * resolves with the deny option and its tool call fails without running.
 */
export function assertZcodePermissionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);

  const requests = projection.runtimeRequests.toSorted((left, right) =>
    left.createdAt < right.createdAt ? -1 : 1,
  );
  assert.deepEqual(
    requests.map((request) => [request.kind, request.status, request.decision]),
    [
      ["command", "resolved", "accept"],
      ["command", "resolved", "decline"],
    ],
  );

  // Both decisions reach the app-server as the matching option's id.
  const decisions = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    Reflect.get(entry.frame, "method") === "v4/command" &&
    Reflect.get(Reflect.get(entry.frame, "params") as object, "type") === "resolveInteraction"
      ? [
          Reflect.get(
            Reflect.get(Reflect.get(entry.frame, "params") as object, "payload") as object,
            "answer",
          ),
        ]
      : [],
  );
  assert.deepEqual(decisions, [{ optionId: "allow_once" }, { optionId: "reject_once" }]);

  const approvals = projection.turnItems.filter((item) => item.type === "approval_request");
  assert.deepEqual(
    approvals.map((item) => [item.status, item.type === "approval_request" ? item.prompt : null]),
    [
      ["completed", ZCODE_PERMISSION_APPROVED_COMMAND],
      ["completed", ZCODE_PERMISSION_DECLINED_COMMAND],
    ],
  );

  const shells = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.isTrue(
    shells.some(
      (item) =>
        item.type === "command_execution" &&
        item.input.includes(ZCODE_PERMISSION_APPROVED_COMMAND) &&
        item.status === "completed",
    ),
  );
  assert.isFalse(
    shells.some(
      (item) =>
        item.type === "command_execution" &&
        item.input.includes(ZCODE_PERMISSION_DECLINED_COMMAND) &&
        item.status === "completed",
    ),
  );
}
