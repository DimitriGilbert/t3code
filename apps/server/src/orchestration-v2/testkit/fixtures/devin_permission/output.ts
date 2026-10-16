import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";
import { DEVIN_PERMISSION_APPROVED_COMMAND, DEVIN_PERMISSION_DECLINED_COMMAND } from "./input.ts";

/**
 * Devin's `smart` session mode escalates gated exec calls through
 * `session/request_permission`; `devinPermissionDisposition` escalates every
 * one of those asks to the user under T3's `auto` runtime mode. The approved
 * `rm` then runs through a client terminal; the declined one never does.
 */
export function assertDevinPermissionOutput(
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

  // Each decision reaches Devin as the option id of the matching kind.
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

  // The approved command ran through a T3 client terminal; the declined
  // command produced no terminal traffic at all.
  const terminals = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    Reflect.get(entry.frame, "method") === "terminal/create"
      ? [Reflect.get(Reflect.get(entry.frame, "params") as object, "command")]
      : [],
  );
  assert.deepEqual(terminals, [DEVIN_PERMISSION_APPROVED_COMMAND]);

  // Rejection resolves the exec tool call as failed with Devin's
  // `cognition.ai/rejected` marker — it never reaches a shell.
  const shells = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.isTrue(
    shells.some(
      (item) =>
        item.type === "command_execution" &&
        item.input.includes(DEVIN_PERMISSION_APPROVED_COMMAND) &&
        item.status === "completed",
    ),
  );
  assert.isFalse(
    shells.some(
      (item) =>
        item.type === "command_execution" &&
        item.input.includes(DEVIN_PERMISSION_DECLINED_COMMAND) &&
        item.status === "completed",
    ),
  );
}
