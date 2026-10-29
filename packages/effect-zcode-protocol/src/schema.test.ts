import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as ZCodeSchema from "./schema.ts";

const isSnapshot = Schema.is(ZCodeSchema.ConversationSnapshot);
const isAck = Schema.is(ZCodeSchema.CommandAck);
const isRow = Schema.is(ZCodeSchema.ConversationRow);
const isDelta = Schema.is(ZCodeSchema.ConversationDelta);
const isSubscribeParams = Schema.is(ZCodeSchema.V4ConversationSubscribeParams);
const isSendTextPayload = Schema.is(ZCodeSchema.CommandPayloadSchemas.sendText);
const isStorageState = Schema.is(ZCodeSchema.ZCodeStorageStartupState);
const isWorkspaceConfigSnapshot = Schema.is(ZCodeSchema.WorkspaceConfigSnapshot);
const decodeEnvelope = Schema.decodeUnknownSync(ZCodeSchema.CommandEnvelopeWire);
const encodeEnvelope = Schema.encodeSync(ZCodeSchema.CommandEnvelopeWire);
const decodeDelta = Schema.decodeSync(ZCodeSchema.ConversationDelta);

it("decodes the live-smoke subscribe params and frame-adjacent shapes", () => {
  assert.equal(
    isSubscribeParams({
      topic: "workspace-config//tmp",
      connectionId: "t3-test-1",
      clientMode: "desktop-continuous",
    }),
    true,
  );
});

it("decodes every conversation row kind minimally", () => {
  const base = { rowId: 1, turnId: "t1", createdAt: 0, createdAtSeq: 0 };
  const rows = [
    { ...base, kind: "turnHeader", origin: "userInput", state: "running", startedAt: 0 },
    { ...base, kind: "userInput", text: "hi", origin: "realUser" },
    { ...base, kind: "assistantText", text: "ok", state: "streaming" },
    { ...base, kind: "reasoning", text: "think", state: "complete" },
    {
      ...base,
      kind: "toolCall",
      toolCallId: "tc1",
      toolName: "Bash",
      status: "running",
      inputText: "",
    },
    {
      ...base,
      kind: "artifact",
      artifactVersionId: "v1",
      logicalArtifactKey: "k",
      displayName: "d",
      artifactType: "md",
      mimeType: "text/markdown",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      ref: "r",
      state: "current",
    },
    { ...base, kind: "subagent", subagentType: "explore", status: "running", summaryText: "" },
    {
      ...base,
      kind: "hookInvocation",
      hookInvocationId: "h1",
      hookEventName: "Stop",
      hookCount: 1,
      state: "completed",
      startedAt: 0,
      lane: "assistantWork",
      executions: [],
    },
    { ...base, kind: "timelineMarker", marker: { type: "goalSet", objective: "o" } },
  ] as const;
  for (const row of rows) assert.equal(isRow(row), true, JSON.stringify(row));
  assert.equal(isRow({ ...base, kind: "mystery" }), false);
});

it("decodes conversation deltas including state.updated patches", () => {
  assert.equal(isDelta({ op: "row.delta", rowId: 1, path: "text", append: "x" }), true);
  assert.equal(isDelta({ op: "row.removed", fromRowId: 3 }), true);
  assert.equal(
    isDelta({
      op: "state.updated",
      patch: {
        revision: 2,
        pendingInteractions: [
          {
            interactionId: "i1",
            kind: "permission",
            anchorRowId: null,
            createdAt: 0,
            payload: {
              kind: "permission",
              toolCallId: "tc",
              toolName: "Bash",
              summary: "run",
              detail: {},
              options: [{ optionId: "allow", label: "Allow", kind: "allowOnce" }],
            },
          },
        ],
      },
    }),
    true,
  );
});

it("decodes a minimal conversation snapshot", () => {
  assert.equal(
    isSnapshot({
      protocolVersion: 1,
      sessionId: "s1",
      logEpoch: "e1",
      seq: 4,
      revision: 2,
      control: {
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [],
        lastError: null,
        apiRetry: null,
      },
      availability: {
        fork: { allowed: true },
        compact: { allowed: true },
        switchModelConfig: { allowed: true },
        setFollowupMode: { allowed: true },
        queueEdit: { allowed: true },
        sendQueuedNow: { allowed: true },
        pauseGoal: { allowed: true },
        resumeGoal: { allowed: true },
      },
      inputRouting: { mode: "startNow" },
      config: { provider: "zhipu", model: "glm", thought: "none", followupMode: "queue" },
      usage: {
        contextWindow: null,
        cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      queue: { items: [], autoDrain: true },
      pendingInteractions: [],
      pendingCommands: [],
      backgroundWorks: [],
      goal: null,
      plan: null,
      rows: { window: [], totalCount: 0, firstRowId: null },
    }),
    true,
  );
});

it("round-trips command envelopes with typed payloads", () => {
  const envelope = decodeEnvelope({
    commandId: "cmd-1",
    clientId: "t3",
    sessionId: "s1",
    baseRevision: 3,
    baseLogEpoch: "e1",
    type: "sendText",
    payload: { text: "hello", requestedDelivery: "queue" },
    issuedAt: 123,
  });
  assert.equal(envelope.type, "sendText");
  const encoded = JSON.parse(JSON.stringify(encodeEnvelope(envelope))) as Record<string, unknown>;
  assert.equal((encoded.payload as Record<string, unknown>).text, "hello");
  // Payload narrows against the per-type schema, same as the server does.
  if (isSendTextPayload(envelope.payload)) {
    assert.equal(envelope.payload.requestedDelivery, "queue");
  } else {
    assert.fail("sendText payload did not decode");
  }

  const stop = decodeEnvelope({
    commandId: "cmd-2",
    clientId: "t3",
    sessionId: "s1",
    type: "stop",
    payload: { expectedForegroundExecutionId: "fe-1" },
    issuedAt: 1,
  });
  assert.equal(stop.type, "stop");

  const resolve = decodeEnvelope({
    commandId: "cmd-3",
    clientId: "t3",
    sessionId: "s1",
    type: "resolveInteraction",
    payload: { interactionId: "i1", answer: { optionId: "allow" } },
    issuedAt: 1,
  });
  assert.equal(resolve.type, "resolveInteraction");
  const typed = ZCodeSchema.makeCommandEnvelope({
    commandId: "cmd-4",
    clientId: "t3",
    sessionId: "s1",
    type: "sendText",
    payload: { text: "hi", requestedDelivery: "startNow" },
    issuedAt: 2,
  });
  assert.equal(typed.payload.requestedDelivery, "startNow");
});

it("rejects a command envelope whose type has no registered payload", () => {
  assert.throws(() =>
    decodeEnvelope({
      commandId: "c",
      clientId: "t3",
      sessionId: null,
      type: "notACommand",
      payload: {},
      issuedAt: 0,
    }),
  );
});

it("decodes command acks across statuses", () => {
  assert.equal(
    isAck({
      commandId: "c1",
      status: "accepted",
      revisionAtDecision: 4,
      result: { type: "inputAccepted", delivery: "startNow", inputId: "i1" },
    }),
    true,
  );
  assert.equal(
    isAck({ commandId: "c2", status: "stale", reasonCode: "proto.stale", revisionAtDecision: 5 }),
    true,
  );
  assert.equal(isAck({ commandId: "c3", status: "bogus", revisionAtDecision: 0 }), false);
});

it("decodes storage startup and workspace-config payloads", () => {
  assert.equal(
    isStorageState({
      schemaVersion: 1,
      attemptId: "a1",
      sequence: 2,
      databaseId: "d1",
      databaseKind: "session",
      phase: "ready",
      elapsedMs: 10,
    }),
    true,
  );
  assert.equal(
    isWorkspaceConfigSnapshot({
      protocolVersion: 1,
      workspaceId: "/tmp",
      logEpoch: "e",
      config: { configOptions: [], slashCommands: [] },
    }),
    true,
  );
});

it("rejects malformed storage startup frames the gate must ignore", () => {
  const base = {
    schemaVersion: 1,
    attemptId: "a1",
    databaseId: "d1",
    databaseKind: "session",
    elapsedMs: 1,
  } as const;
  assert.equal(isStorageState({ ...base, sequence: 0, phase: "ready" }), false);
  // failed without errorCode is malformed upstream — ignored, not a gate fault.
  assert.equal(isStorageState({ ...base, sequence: 1, phase: "failed" }), false);
  assert.equal(isStorageState({ ...base, sequence: 1, phase: "failed", errorCode: "nope" }), false);
  assert.equal(
    isStorageState({ ...base, sequence: 1, phase: "failed", errorCode: "corrupt" }),
    true,
  );
});

it("enforces upstream CAS fields in outbound command envelopes", () => {
  const base = { commandId: "c", clientId: "t3", sessionId: "s1", issuedAt: 0 };
  // retryTurn is row-targeting: it needs baseRevision AND baseLogEpoch.
  assert.throws(
    () =>
      ZCodeSchema.makeCommandEnvelope({
        ...base,
        type: "retryTurn",
        payload: { target: { rowId: 1, entityId: "e" } },
      }),
    ZCodeSchema.CommandEnvelopeValidationError,
  );
  assert.throws(
    () =>
      ZCodeSchema.makeCommandEnvelope({
        ...base,
        type: "retryTurn",
        baseRevision: 1,
        payload: { target: { rowId: 1, entityId: "e" } },
      }),
    ZCodeSchema.CommandEnvelopeValidationError,
  );
  const ok = ZCodeSchema.makeCommandEnvelope({
    ...base,
    type: "retryTurn",
    baseRevision: 1,
    baseLogEpoch: "e1",
    payload: { target: { rowId: 1, entityId: "e" } },
  });
  assert.equal(ok.type, "retryTurn");
  // pauseGoal needs baseRevision but not baseLogEpoch.
  assert.throws(
    () => ZCodeSchema.makeCommandEnvelope({ ...base, type: "pauseGoal", payload: {} }),
    ZCodeSchema.CommandEnvelopeValidationError,
  );
  // Payload shape itself is validated per command type.
  assert.throws(
    () =>
      ZCodeSchema.makeCommandEnvelope({
        ...base,
        type: "sendText",
        payload: { text: 1 } as unknown as ZCodeSchema.CommandPayloadFor<"sendText">,
      }),
    Schema.SchemaError,
  );
});

it("decodes the two upstream revokeWorkspaceHookTrust target shapes", () => {
  const isRevokePayload = Schema.is(ZCodeSchema.CommandPayloadSchemas.revokeWorkspaceHookTrust);
  const flowTarget = {
    sessionId: "s",
    taskId: "t",
    runId: "r",
    workspaceIdentity: "w",
    bundleDigest: "d",
    reviewFlowId: "f",
    generation: 1,
    interactionId: "i",
    reviewItemIds: ["x"],
  };
  const digestTarget = {
    sessionId: "s",
    workspaceIdentity: "w",
    bundleDigest: "d",
    hookDeclarationDigests: ["a".repeat(64)],
  };
  assert.equal(isRevokePayload(flowTarget), true);
  assert.equal(isRevokePayload(digestTarget), true);
  assert.equal(
    isRevokePayload({ sessionId: "s", workspaceIdentity: "w", bundleDigest: "d" }),
    false,
  );
  assert.equal(isRevokePayload({ ...digestTarget, hookDeclarationDigests: [] }), false);
});

it("decodes the amendWorkflowRunSettings command result fields", () => {
  assert.equal(
    isAck({
      commandId: "c1",
      status: "accepted",
      revisionAtDecision: 1,
      result: { type: "amendWorkflowRunSettings", runId: "r1", toolCallId: "tc1" },
    }),
    true,
  );
  assert.equal(
    isAck({
      commandId: "c1",
      status: "accepted",
      revisionAtDecision: 1,
      result: {
        type: "amendWorkflowRunSettings",
        runId: "r1",
        toolCallId: "tc1",
        supersededRunId: "r0",
      },
    }),
    true,
  );
  // runId/toolCallId are required upstream.
  assert.equal(
    isAck({
      commandId: "c1",
      status: "accepted",
      revisionAtDecision: 1,
      result: { type: "amendWorkflowRunSettings" },
    }),
    false,
  );
});

it("preserves opaque workflowRun.updated delta fields through decode", () => {
  const wire = {
    op: "workflowRun.updated" as const,
    runId: "r1",
    revision: 2,
    run: { status: "running" },
    cleared: ["endedAt"],
    removedActors: [{ siteId: "a", ordinal: 0 }],
    removedNodes: [],
    actors: [{ siteId: "a", ordinal: 0, extra: 1 }],
    nodes: [],
  };
  const delta = decodeDelta(wire);
  // workflowRunDeltas subscribers receive these fields verbatim.
  assert.deepEqual(delta, wire);
});

// Sanitized real `zcode app-server --stdio` captures (2026-10-29 probes):
// ids/timestamps normalized, no credentials or user content.
it("decodes real captured subagent-end state patches", () => {
  // Parent topic when the child session starts (transcript2.ndjson).
  assert.equal(
    isDelta({
      op: "state.updated",
      patch: {
        subagents: {
          revision: 1,
          childSessionIds: ["sess_subagent_agent_1"],
          running: [
            {
              childSessionId: "sess_subagent_agent_1",
              agentId: "agent_1",
              toolCallId: "call_1",
              subagentType: "general-purpose",
              title: "Wait 60s then reply PONG",
              status: "running",
              startedAt: 1793135941176,
            },
          ],
          endedTotal: 0,
        },
        revision: 9,
      },
    }),
    true,
  );
  // At child end: running shrinks to [], endedTotal increments; the
  // backgroundWorks entry flips running -> resultPending + endedAt.
  assert.equal(
    isDelta({
      op: "state.updated",
      patch: {
        backgroundWorks: [
          {
            workId: "agent_1",
            kind: "subagent",
            title: "Wait 60s then reply PONG",
            status: "resultPending",
            startedAt: 1793135941200,
            endedAt: 1793136008053,
            cancellable: false,
            anchorRowId: null,
            childSessionId: "sess_subagent_agent_1",
          },
        ],
        revision: 17,
      },
    }),
    true,
  );
  assert.equal(
    isDelta({
      op: "state.updated",
      patch: {
        subagents: {
          revision: 2,
          childSessionIds: ["sess_subagent_agent_1"],
          running: [],
          endedTotal: 1,
        },
        revision: 18,
      },
    }),
    true,
  );
});

it("decodes the real terminal subagent row.upserted", () => {
  // The wire DOES emit a terminal `subagent` row — running -> success via
  // row.upserted on the same rowId (transcript2.ndjson seq 20->28/139->143).
  assert.equal(
    isRow({
      rowId: 4,
      turnId: "t1",
      entityId: "agent_1",
      productTurnId: "t1",
      visibility: "visible",
      createdAt: 1793135941176,
      createdAtSeq: 21,
      kind: "subagent",
      parentToolCallId: "call_1",
      subagentType: "general-purpose",
      status: "running",
      summaryText: "Wait 60s then reply PONG",
      childSessionId: "sess_subagent_agent_1",
      backgrounded: true,
      workId: "agent_1",
      startedAt: 1793135941176,
    }),
    true,
  );
  assert.equal(
    isRow({
      rowId: 4,
      turnId: "t1",
      entityId: "agent_1",
      productTurnId: "t1",
      visibility: "visible",
      createdAt: 1793135941176,
      createdAtSeq: 21,
      kind: "subagent",
      parentToolCallId: "call_1",
      subagentType: "general-purpose",
      status: "success",
      summaryText: "Wait 60s then reply PONG",
      childSessionId: "sess_subagent_agent_1",
      backgrounded: true,
      workId: "agent_1",
      startedAt: 1793135941176,
      endedAt: 1793136008168,
    }),
    true,
  );
});

it("decodes a real AskUserQuestion pendingInteraction patch", () => {
  // Captured live (transcript5.ndjson): interactionId is `perm_*` even for
  // kind:"userInput"; anchorRowId is a number; resolution = array empties.
  assert.equal(
    isDelta({
      op: "state.updated",
      patch: {
        pendingInteractions: [
          {
            interactionId: "perm_1",
            kind: "userInput",
            anchorRowId: 3,
            createdAt: 1793261909274,
            payload: {
              kind: "userInput",
              prompt: "Tool AskUserQuestion requires user interaction",
              freeText: true,
              toolCallId: "call_1",
              toolName: "AskUserQuestion",
              traceId: "trace-1",
              input: {
                questions: [
                  {
                    question: "Do you prefer option A or option B?",
                    header: "Preference",
                    options: [
                      { label: "Option A", description: "Choose option A" },
                      { label: "Option B", description: "Choose option B" },
                    ],
                    multiSelect: false,
                  },
                ],
              },
              schema: { toolName: "AskUserQuestion" },
              questions: [
                {
                  question: "Do you prefer option A or option B?",
                  header: "Preference",
                  options: [
                    { value: "Option A", label: "Option A", description: "Choose option A" },
                    { value: "Option B", label: "Option B", description: "Choose option B" },
                  ],
                },
              ],
            },
          },
        ],
        revision: 8,
      },
    }),
    true,
  );
  assert.equal(
    isDelta({ op: "state.updated", patch: { pendingInteractions: [], revision: 9 } }),
    true,
  );
});

it("decodes the real goal lifecycle patches", () => {
  // sendGoalCommand accepted -> goal patches (transcript3.ndjson):
  // active -> verifying (goalVerifier activeWork) -> verified.
  const goal = (over: Record<string, unknown>) => ({
    targetId: "target_1",
    objective: "Reply DONE2.",
    summaryTitle: "Reply DONE2",
    timeUsedSeconds: 5,
    activeRunStartedAtMs: null,
    iteration: 1,
    verifications: [],
    iterations: [],
    ...over,
  });
  assert.equal(
    isDelta({
      op: "state.updated",
      patch: {
        goal: goal({ status: "active", activeRunStartedAtMs: 1793261697136 }),
        revision: 22,
      },
    }),
    true,
  );
  assert.equal(
    isDelta({
      op: "state.updated",
      patch: { goal: goal({ status: "verifying" }), revision: 29 },
    }),
    true,
  );
  assert.equal(
    isDelta({
      op: "state.updated",
      patch: {
        goal: goal({
          status: "verified",
          verifications: [
            { iteration: 1, outcome: "pass", at: 1793261703728, anchorRowId: 11, reason: "ok" },
          ],
        }),
        revision: 30,
      },
    }),
    true,
  );
});

it("decodes real command-ACK variants", () => {
  // noop: switchModelConfig with an unchanged config (transcript3.ndjson).
  assert.equal(
    isAck({
      commandId: "c1",
      status: "noop",
      revisionAtDecision: 2,
      reasonCode: "config.unchanged",
    }),
    true,
  );
  // stale: CAS command whose baseRevision fell behind (transcript3.ndjson).
  assert.equal(
    isAck({
      commandId: "c2",
      status: "stale",
      reasonCode: "proto.staleRevision",
      revisionAtDecision: 3,
    }),
    true,
  );
  // duplicate: same commandId resent — no reasonCode, result may replay.
  assert.equal(isAck({ commandId: "c3", status: "duplicate", revisionAtDecision: 3 }), true);
  // failed: sendText when the overlay model isn't in the registry.
  assert.equal(
    isAck({
      commandId: "c4",
      status: "failed",
      revisionAtDecision: 0,
      reasonCode: "modelUnavailable",
      message: "Provider Registry: model missing",
    }),
    true,
  );
});

it("decodes real resync acks and the rewind row.removed op", () => {
  const isAck2 = Schema.is(ZCodeSchema.V4ConversationResyncResult);
  // base:{logEpoch,seq} at current watermark -> resume + recovery deltas frame.
  assert.equal(isAck2({ ack: { subscriptionId: "s1", mode: "resume", logEpoch: "e1" } }), true);
  // base:null + forceSnapshot -> snapshot + recovery snapshot frame.
  assert.equal(isAck2({ ack: { subscriptionId: "s1", mode: "snapshot", logEpoch: "e1" } }), true);
  // Whole-branch rewind emits only {op, fromRowId}; rows continue at the
  // next id afterwards (transcript4.ndjson editUserQuery rewind).
  assert.equal(isDelta({ op: "row.removed", fromRowId: 1 }), true);
});
