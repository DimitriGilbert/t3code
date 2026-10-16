import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypeSequence,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { DEVIN_BASIC_TURN_COMMAND, DEVIN_BASIC_TURN_PROMPT } from "./input.ts";

/**
 * One full-access turn: an exec tool call that Devin runs through T3's client
 * terminals (the only provider that routes shell work through `terminal/*`),
 * the model's thought chunks, then the assistant reply.
 */
export function assertDevinBasicTurnOutput(
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
    "reasoning",
    "assistant_message",
    "checkpoint",
  ]);
  assertUserMessagesInclude(projection, [DEVIN_BASIC_TURN_PROMPT]);
  assertAssistantTextIncludes(projection, "done");

  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.deepEqual(
    commands.map((item) => [
      item.type === "command_execution" ? item.input : null,
      item.status,
      item.type === "command_execution" ? item.output : null,
    ]),
    [[DEVIN_BASIC_TURN_COMMAND, "completed", "Exited with code 0"]],
  );

  // The command ran through a T3 client terminal — the wire proves Devin
  // drove create/wait/output/release itself (no T3-side executor).
  const terminalMethods = transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound") return [];
    const frame = entry.frame;
    if (typeof frame !== "object" || frame === null) return [];
    const method = Reflect.get(frame, "method");
    return typeof method === "string" && method.startsWith("terminal/") ? [method] : [];
  });
  assert.deepEqual(terminalMethods, [
    "terminal/create",
    "terminal/wait_for_exit",
    "terminal/output",
    "terminal/release",
  ]);
}
