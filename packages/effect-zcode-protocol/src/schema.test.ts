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
