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
 * Guarded mode: both commands escalate to the user. The approved one runs; the
 * declined one resolves the native response with the reject option and its tool
 * call fails without running.
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

  // Both decisions reach the bridge as the option id of the matching kind.
  const decisions = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    Reflect.get(entry.frame, "method") === "session/request_permission"
      ? [
          Reflect.get(
            Reflect.get(Reflect.get(entry.frame, "result") as object, "outcome") as object,
            "optionId",
          ),
        ]
      : [],
  );
  assert.deepEqual(decisions, ["allow_once", "reject_once"]);

  const approvals = projection.turnItems.filter((item) => item.type === "approval_request");
  assert.deepEqual(
    approvals.map((item) => [item.status, item.type === "approval_request" ? item.prompt : null]),
    [
      ["completed", ZCODE_PERMISSION_APPROVED_COMMAND],
      ["cancelled", ZCODE_PERMISSION_DECLINED_COMMAND],
    ],
  );
  // The bridge's option ids are opaque, so the item carries no curated option
  // list; decisions are asserted on the wire above instead.

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
