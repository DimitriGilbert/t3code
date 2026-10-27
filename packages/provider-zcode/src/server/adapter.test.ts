import { assert, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import type * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

import { ZcodeSettings } from "../settings.ts";

const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);
import { buildZcodeAppServerSpawnInput } from "./zcodeAppServer.ts";
import {
  zcodeExecutionStateForRuntimePolicy,
  zcodePermissionAnswer,
  zcodePermissionOptionForDecision,
  zcodeReportedModelSelection,
  zcodeRequestKindForTool,
  zcodeSessionModeForRuntimeMode,
  zcodeTimelineMarkerText,
  zcodeToolCallItemStatus,
  zcodeToolItemKind,
  zcodeTurnItemStatusForText,
} from "./zcodeRows.ts";

it("defaults the spawn command to `zcode app-server --stdio`", () => {
  const settings = decodeZcodeSettings({});
  const spawn = buildZcodeAppServerSpawnInput(settings, "/tmp/project", {});
  expect(spawn.command).toBe("zcode");
  expect(spawn.args).toEqual(["app-server", "--stdio"]);
  expect(spawn.cwd).toBe("/tmp/project");
});

it("honors a configured binaryPath", () => {
  const spawn = buildZcodeAppServerSpawnInput(
    { binaryPath: "/opt/zcode/bin/zcode" },
    "/tmp/project",
    {},
  );
  expect(spawn.command).toBe("/opt/zcode/bin/zcode");
});

it("maps runtime modes onto ZCode submission modes", () => {
  expect(zcodeSessionModeForRuntimeMode("approval-required")).toBe("build");
  expect(zcodeSessionModeForRuntimeMode("auto-accept-edits")).toBe("edit");
  expect(zcodeSessionModeForRuntimeMode("auto")).toBe("guarded");
  expect(zcodeSessionModeForRuntimeMode("full-access")).toBe("yolo");
});

it("maps runtime policy onto per-input execution state", () => {
  expect(
    zcodeExecutionStateForRuntimePolicy({
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  ).toEqual({ mode: "yolo", planEnabled: false });
  expect(
    zcodeExecutionStateForRuntimePolicy({
      runtimeMode: "approval-required",
      interactionMode: "plan",
    }),
  ).toEqual({ mode: "build", planEnabled: true });
});

it("reports the session model selection for nativeMetadata", () => {
  const config = {
    provider: PROVIDER_ID,
    model: MODEL_ID,
    thought: "high",
    thoughtLevels: ["low", "high"],
    followupMode: "queue" as const,
    mode: "build",
    modelSelection: {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      options: { reasoningLevel: "high" },
    },
  };
  expect(zcodeReportedModelSelection({ config, instanceId: "zcode-test" as never })).toEqual({
    instanceId: "zcode-test",
    model: `${PROVIDER_ID}/${MODEL_ID}`,
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  const { modelSelection: _drop, ...flatConfig } = config;
  expect(
    zcodeReportedModelSelection({
      config: flatConfig,
      instanceId: "zcode-test" as never,
    }),
  ).toEqual({
    instanceId: "zcode-test",
    model: `${PROVIDER_ID}/${MODEL_ID}`,
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  expect(
    zcodeReportedModelSelection({ config: null, instanceId: "zcode-test" as never }),
  ).toBeUndefined();
});

it("maps text row states onto turn item statuses", () => {
  expect(zcodeTurnItemStatusForText("streaming")).toBe("running");
  expect(zcodeTurnItemStatusForText("complete")).toBe("completed");
  expect(zcodeTurnItemStatusForText("interrupted")).toBe("interrupted");
  expect(zcodeTurnItemStatusForText("failed")).toBe("failed");
});

it("maps tool-call rows onto T3 item kinds", () => {
  expect(zcodeToolItemKind("Bash")).toBe("command_execution");
  expect(zcodeToolItemKind("Edit")).toBe("file_change");
  expect(zcodeToolItemKind("Write")).toBe("file_change");
  expect(zcodeToolItemKind("WebSearch")).toBe("dynamic_tool");
});

it("maps tool-call statuses onto turn item statuses", () => {
  expect(zcodeToolCallItemStatus("running")).toBe("running");
  expect(zcodeToolCallItemStatus("pendingApproval")).toBe("waiting");
  expect(zcodeToolCallItemStatus("success")).toBe("completed");
  expect(zcodeToolCallItemStatus("error")).toBe("failed");
  expect(zcodeToolCallItemStatus("cancelled")).toBe("cancelled");
});

it("maps gated tool names onto request kinds", () => {
  expect(zcodeRequestKindForTool("Bash")).toBe("command");
  expect(zcodeRequestKindForTool("Edit")).toBe("file-change");
  expect(zcodeRequestKindForTool("Read")).toBe("file-read");
  expect(zcodeRequestKindForTool("Task")).toBe("permission");
});

it("maps T3 approval decisions onto permission options", () => {
  const options = [
    { optionId: "o1", label: "Allow once", kind: "allowOnce" as const },
    { optionId: "o2", label: "Always", kind: "allowAlways" as const },
    { optionId: "o3", label: "Deny", kind: "deny" as const },
  ];
  expect(zcodePermissionOptionForDecision({ options, decision: "accept" })?.optionId).toBe("o1");
  expect(zcodePermissionOptionForDecision({ options, decision: "acceptAlways" })?.optionId).toBe(
    "o2",
  );
  expect(zcodePermissionOptionForDecision({ options, decision: "decline" })?.optionId).toBe("o3");
});

it("builds resolveInteraction answers for permission decisions", () => {
  const payload = {
    kind: "permission" as const,
    toolName: "Bash",
    toolCallId: "t1",
    summary: "run ls",
    detail: {},
    options: [
      { optionId: "o1", label: "Allow", kind: "allowOnce" as const },
      { optionId: "o2", label: "Deny", kind: "deny" as const },
    ],
  } satisfies ZCodeSchema.PermissionRequestPayload;
  expect(zcodePermissionAnswer({ payload, decision: "accept" })).toEqual({ optionId: "o1" });
  expect(zcodePermissionAnswer({ payload, decision: "cancel" })).toEqual({ action: "cancel" });
});

it("renders timeline markers into user-facing text", () => {
  const compact = {
    type: "compact" as const,
    origin: "auto" as const,
    status: "success" as const,
    tokensBefore: 1000,
    tokensAfter: 500,
  };
  expect(zcodeTimelineMarkerText(compact)).toBe("Conversation history compacted.");
});

// ── replayed app-server lifecycle (P2 seam) ──

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ZCodeClient from "@t3tools/effect-zcode-protocol/client";
import * as ZCodeReplay from "@t3tools/effect-zcode-protocol/replay";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { makeZcodeAdapterV2 } from "./adapter.ts";
import type { ZcodeAppServerSpawnInput } from "./zcodeAppServer.ts";
import { ZcodeAppServerSpawnOpenError } from "./zcodeAppServer.ts";
import { buildZcodeAccountOverlay } from "./zcodeCredentials.ts";

const PROVIDER_ID = "account:zai-individual-coding-plan";
const MODEL_ID = "GLM-5.3";

const WORKSPACE = { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" };

const snapshotFrame = {
  protocolVersion: 1,
  sessionId: "s1",
  logEpoch: "e1",
  seq: 1,
  revision: 1,
  control: {
    phase: "running",
    sessionEnded: false,
    canStop: false,
    stopState: "idle",
    stopTargetKind: "unknown",
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
  config: {
    mode: "build",
    provider: PROVIDER_ID,
    model: MODEL_ID,
    thought: "low",
    followupMode: "queue",
    thoughtLevels: ["low", "high", "max"],
    modelSelection: {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      options: { reasoningLevel: "low" },
    },
  },
  usage: {
    contextWindow: null,
    cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
  queue: { items: [], autoDrain: false },
  pendingInteractions: [],
  pendingCommands: [],
  backgroundWorks: [],
  goal: null,
  plan: null,
  rows: { window: [], totalCount: 0, firstRowId: null },
};

const wireFrame = (ordinal: number, payload: unknown, deliveryKind = "online") => ({
  method: "v4/conversation/frame",
  params: {
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `lf-${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic: "conversation/s1",
    subscriptionId: "sub1",
    frame: {
      topic: "conversation/s1",
      subscriptionId: "sub1",
      fromSeq: ordinal - 1,
      toSeq: ordinal,
      sentAt: 1735689600000,
      payload,
    },
  },
});

it.layer(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))(
  "zcode app-server lifecycle",
  (it) => {
    it.effect("drives overlay, responders, model selection, and turn completion", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const zcodeHome = yield* fileSystem.makeTempDirectory();
        yield* fileSystem.makeDirectory(`${zcodeHome}/v2/runtime/provider/bundled`, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          `${zcodeHome}/v2/runtime/provider/bundled/zcode-builtin.json`,
          JSON.stringify({
            schemaVersion: 1,
            revision: 7,
            config: {
              providerConfigRules: {
                providerRules: [
                  {
                    providerId: PROVIDER_ID,
                    providerName: "ZAI",
                    config: {
                      access: {
                        type: "zhipu-account",
                        accountType: "zai",
                        mode: "individual-coding-plan",
                      },
                      builtinModelIds: [MODEL_ID],
                    },
                  },
                ],
              },
            },
          }),
        );
        yield* fileSystem.writeFileString(
          `${zcodeHome}/v2/credentials.json`,
          JSON.stringify({
            "oauth:active_provider": "zai",
            [`account-provider:coding-plan:${PROVIDER_ID}:account:u1:api-key`]: "test-api-key",
          }),
        );
        yield* fileSystem.writeFileString(`${zcodeHome}/v2/provider_config.json`, "{}");
        yield* fileSystem.writeFileString(
          `${zcodeHome}/v2/setting.json`,
          JSON.stringify({
            providerFamilyConnectionSelections: {
              zai: { kind: "individual-coding-plan" },
            },
          }),
        );
        const environment: NodeJS.ProcessEnv = { ZCODE_HOME: zcodeHome };

        const overlay = yield* buildZcodeAccountOverlay({
          environment,
          revision: "t3-ps1",
        });
        if (overlay === undefined) return yield* Effect.die("overlay unresolved");

        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "t3 lifecycle",
          entries: [
            {
              type: "emit_inbound",
              frame: {
                method: "startup/storageState",
                params: {
                  schemaVersion: 1,
                  attemptId: "a1",
                  sequence: 1,
                  databaseId: "db",
                  databaseKind: "session",
                  phase: "ready",
                  elapsedMs: 1,
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 1,
                method: "provider/updateAccountConfig",
                params: overlay,
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 1,
                result: { receivedRevision: "t3-ps1", providerCount: 1, status: "received" },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 2,
                method: "provider/refreshRegistry",
                params: { reason: "t3-session-open" },
              },
            },
            { type: "emit_inbound", frame: { id: 2, result: { refreshed: true } } },
            {
              type: "expect_outbound",
              frame: {
                id: 3,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps1",
                  sessionId: null,
                  issuedAt: "<ignored>",
                  type: "createSession",
                  payload: {
                    workspaceId: "/tmp/ws",
                    config: {
                      mode: "build",
                      planEnabled: false,
                      provider: PROVIDER_ID,
                      model: MODEL_ID,
                      thought: "low",
                      modelSelection: {
                        providerId: PROVIDER_ID,
                        modelId: MODEL_ID,
                        options: { reasoningLevel: "low" },
                      },
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 3,
                result: {
                  commandId: "c3",
                  status: "accepted",
                  revisionAtDecision: 1,
                  result: { type: "createSession", sessionId: "s1" },
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "v4/conversation/subscribe",
                params: {
                  topic: "conversation/s1",
                  connectionId: "t3-ps1",
                  clientMode: "desktop-continuous",
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 4,
                result: { ack: { subscriptionId: "sub1", mode: "snapshot", logEpoch: "e1" } },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(1, { kind: "snapshot", snapshot: snapshotFrame }, "initial"),
            },
            {
              type: "expect_outbound",
              frame: {
                id: 5,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps1",
                  sessionId: "s1",
                  issuedAt: "<ignored>",
                  type: "sendText",
                  payload: {
                    text: "ping",
                    requestedDelivery: "startNow",
                    heldQueueDisposition: "keepQueueAndSend",
                    mode: "build",
                    planEnabled: false,
                    modelSelection: {
                      providerId: PROVIDER_ID,
                      modelId: MODEL_ID,
                      options: { reasoningLevel: "low" },
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 5,
                result: {
                  commandId: "c5",
                  status: "accepted",
                  revisionAtDecision: 2,
                  result: {
                    type: "inputAccepted",
                    delivery: "startNow",
                    inputId: "in1",
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: "srv-p1",
                method: "session/requestRuntimePreferences",
                params: { sessionId: "s1", scope: "runtime-materialization" },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: "srv-p1",
                result: {
                  nativeSearchEnhancementsEnabled: false,
                  memoryEnabled: false,
                  askUserQuestionAutoResolutionEnabled: true,
                  modelContextBudgetStrategy: "preflight-v1",
                },
              },
            },
            // user-execution scope, asked while sending text
            {
              type: "emit_inbound",
              frame: {
                id: "srv-p2",
                method: "session/requestRuntimePreferences",
                params: { sessionId: "s1", scope: "user-execution" },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: "srv-p2",
                result: {
                  nativeSearchEnhancementsEnabled: false,
                  memoryEnabled: false,
                  askUserQuestionAutoResolutionEnabled: true,
                  modelContextBudgetStrategy: "preflight-v1",
                },
              },
            },
            // per-request auth material from the credential store
            {
              type: "emit_inbound",
              frame: {
                id: "srv-h1",
                method: "interaction/requestProviderRuntimeHeaders",
                params: {
                  requestId: "rh1",
                  sessionId: "s1",
                  workspace: WORKSPACE,
                  modelSelection: { providerId: PROVIDER_ID, modelId: MODEL_ID },
                  providerId: PROVIDER_ID,
                  reason: "model-request",
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: "srv-h1",
                result: {
                  headersApplied: true,
                  requestAuth: { apiKey: "test-api-key" },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(2, {
                kind: "deltas",
                deltas: [
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 1,
                      createdAt: 1735689600000,
                      createdAtSeq: 1,
                      turnId: "turn-1",
                      kind: "userInput",
                      text: "ping",
                      origin: "realUser",
                    },
                  },
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 2,
                      createdAt: 1735689600000,
                      createdAtSeq: 2,
                      turnId: "turn-1",
                      kind: "turnHeader",
                      origin: "userInput",
                      state: "running",
                      startedAt: 1735689600000,
                      sourceCommandId: "<sendText-commandId>",
                    },
                  },
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 3,
                      createdAt: 1735689600000,
                      createdAtSeq: 3,
                      turnId: "turn-1",
                      kind: "assistantText",
                      text: "PONG",
                      state: "complete",
                    },
                  },
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 4,
                      createdAt: 1735689600000,
                      createdAtSeq: 4,
                      turnId: "turn-1",
                      kind: "turnHeader",
                      origin: "userInput",
                      state: "completedSuccess",
                      startedAt: 1735689600000,
                      endedAt: 1735689601000,
                      sourceCommandId: "<sendText-commandId>",
                    },
                  },
                ],
              }),
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;

        // The adapter generates the sendText commandId; capture it when the
        // frame goes out and echo it back inside the turnHeader rows.
        const sentCommandId = yield* Ref.make<string | undefined>(undefined);
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript, {
          onOutbound: (actual) => {
            const frame = actual as {
              method?: string;
              params?: { type?: string; commandId?: string };
            };
            return frame.method === "v4/command" && frame.params?.type === "sendText"
              ? Ref.set(sentCommandId, frame.params.commandId)
              : Effect.void;
          },
          beforeEmitInbound: (entry) =>
            Ref.get(sentCommandId).pipe(
              Effect.andThen((commandId) =>
                Effect.sync(() => {
                  const params = (
                    entry.frame as {
                      params?: {
                        frame?: { payload?: { deltas?: Array<{ row?: Record<string, unknown> }> } };
                      };
                    }
                  ).params?.frame?.payload;
                  for (const delta of params?.deltas ?? []) {
                    if (delta.row?.sourceCommandId === "<sendText-commandId>") {
                      delta.row.sourceCommandId = commandId;
                    }
                  }
                }),
              ),
            ),
        });
        const openClient = (_input: ZcodeAppServerSpawnInput) =>
          Layer.build(ZCodeReplay.layerReplayWithDriver(driver)).pipe(
            Effect.map((ctx) => Context.get(ctx, ZCodeClient.ZCodeAppServerClient)),
            Effect.mapError(
              (cause) => new ZcodeAppServerSpawnOpenError({ command: "replay", cause }),
            ),
          );

        const adapter = yield* makeZcodeAdapterV2({
          instanceId: "zcode-test" as never,
          settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
          environment,
          openClient,
        });
        const runtime = yield* adapter
          .openSession({
            threadId: "thread-1" as never,
            providerSessionId: "ps1" as never,
            modelSelection: { model: `${PROVIDER_ID}/${MODEL_ID}` } as never,
            runtimePolicy: {
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: "/tmp/ws",
              reasoningEffort: "low",
            } as never,
          })
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
        const providerThread = yield* runtime.ensureThread({
          threadId: "thread-1" as never,
          modelSelection: { model: `${PROVIDER_ID}/${MODEL_ID}` } as never,
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/tmp/ws",
            reasoningEffort: "low",
          } as never,
        });
        const seenEventTypes = yield* Ref.make<Array<string>>([]);
        yield* Stream.runForEach(runtime.events, (event) =>
          Ref.update(seenEventTypes, (acc) => [...acc, event.type]),
        ).pipe(Effect.forkScoped);
        yield* runtime.startTurn({
          appThread: {} as never,
          threadId: "thread-1" as never,
          runId: "run-1" as never,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: "attempt-1" as never,
          rootNodeId: "node-1" as never,
          providerThread,
          message: {
            messageId: "msg-1" as never,
            text: "ping",
            attachments: [],
            createdBy: null,
            creationSource: "web",
          } as never,
          modelSelection: { model: `${PROVIDER_ID}/${MODEL_ID}` } as never,
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/tmp/ws",
            reasoningEffort: "low",
          } as never,
        });
        // readThreadSnapshot awaits the conversation's first-snapshot
        // barrier, so the emitted frames are fully drained by here.
        yield* runtime.readThreadSnapshot({ providerThread });
        for (let i = 0; i < 100; i += 1) yield* Effect.yieldNow;
        const st = yield* Ref.get(driver.state);
        const seen = yield* Ref.get(seenEventTypes);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(
          st.cursor,
          transcript.entries.length,
          `cursor=${st.cursor} events=${JSON.stringify(seen)}`,
        );
        assert.isTrue(seen.includes("turn.terminal"), JSON.stringify(seen));
      }),
    );

    it.effect("switches session config, guides a steer, and retracts a queue fallback", () =>
      Effect.gen(function* () {
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const providerTurnId = allocator.derive.providerTurn({
          driver: "zcode" as never,
          nativeTurnId: "turn-1",
        });
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "p3 modes and steer",
          entries: [
            {
              type: "emit_inbound",
              frame: {
                method: "startup/storageState",
                params: {
                  schemaVersion: 1,
                  attemptId: "a1",
                  sequence: 1,
                  databaseId: "db",
                  databaseKind: "session",
                  phase: "ready",
                  elapsedMs: 1,
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 1,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps2",
                  sessionId: null,
                  issuedAt: "<ignored>",
                  type: "createSession",
                  payload: {
                    workspaceId: "/tmp/ws",
                    config: {
                      mode: "build",
                      planEnabled: false,
                      provider: PROVIDER_ID,
                      model: MODEL_ID,
                      thought: "low",
                      modelSelection: {
                        providerId: PROVIDER_ID,
                        modelId: MODEL_ID,
                        options: { reasoningLevel: "low" },
                      },
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 1,
                result: {
                  commandId: "c1",
                  status: "accepted",
                  revisionAtDecision: 0,
                  result: { type: "createSession", sessionId: "s1" },
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 2,
                method: "v4/conversation/subscribe",
                params: {
                  topic: "conversation/s1",
                  connectionId: "t3-ps2",
                  clientMode: "desktop-continuous",
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 2,
                result: { ack: { subscriptionId: "sub1", mode: "snapshot", logEpoch: "e1" } },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(1, { kind: "snapshot", snapshot: snapshotFrame }, "initial"),
            },
            // runtimePolicy full-access while config.mode is still build →
            // the session-resident switch command precedes the input.
            {
              type: "expect_outbound",
              frame: {
                id: 3,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps2",
                  sessionId: "s1",
                  baseRevision: 1,
                  issuedAt: "<ignored>",
                  type: "switchCollaborationMode",
                  payload: { mode: "yolo" },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 3,
                result: { commandId: "c3", status: "accepted", revisionAtDecision: 2 },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps2",
                  sessionId: "s1",
                  issuedAt: "<ignored>",
                  type: "sendText",
                  payload: {
                    text: "first",
                    requestedDelivery: "startNow",
                    heldQueueDisposition: "keepQueueAndSend",
                    mode: "yolo",
                    planEnabled: false,
                    modelSelection: {
                      providerId: PROVIDER_ID,
                      modelId: MODEL_ID,
                      options: { reasoningLevel: "low" },
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 4,
                result: {
                  commandId: "c4",
                  status: "accepted",
                  revisionAtDecision: 3,
                  result: { type: "inputAccepted", delivery: "startNow", inputId: "in1" },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(2, {
                kind: "deltas",
                deltas: [
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 1,
                      createdAt: 1735689600000,
                      createdAtSeq: 1,
                      turnId: "turn-1",
                      kind: "turnHeader",
                      origin: "userInput",
                      state: "running",
                      startedAt: 1735689600000,
                      sourceCommandId: "<sendText-commandId>",
                    },
                  },
                ],
              }),
            },
            // The steer goes out as a guide; the ambiguous queue ACK is
            // resolved by the queue patch admitting it to the deferred FIFO.
            {
              type: "expect_outbound",
              frame: {
                id: 5,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps2",
                  sessionId: "s1",
                  issuedAt: "<ignored>",
                  type: "sendText",
                  payload: { text: "steer me", requestedDelivery: "guide" },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 5,
                result: {
                  commandId: "c5",
                  status: "accepted",
                  revisionAtDecision: 4,
                  result: { type: "inputAccepted", delivery: "queue", inputId: "in2" },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(3, {
                kind: "deltas",
                deltas: [
                  {
                    op: "state.updated",
                    patch: {
                      queue: {
                        autoDrain: true,
                        items: [
                          {
                            sourceCommandId: "<steer-commandId>",
                            queueItemId: "q-steer",
                            clientId: "t3-ps2",
                            kind: "sendText",
                            text: "steer me",
                            delivery: { requested: "guide", admitted: "queue" },
                            order: { admissionSeq: 2, queuePosition: 0 },
                            steer: { state: "notRequested" },
                            dispatch: { state: "queued" },
                          },
                        ],
                      },
                    },
                  },
                ],
              }),
            },
            {
              type: "expect_outbound",
              frame: {
                id: 6,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps2",
                  sessionId: "s1",
                  baseRevision: 1,
                  issuedAt: "<ignored>",
                  type: "deleteQueueItem",
                  payload: { queueItemId: "q-steer" },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 6,
                result: { commandId: "c6", status: "accepted", revisionAtDecision: 5 },
              },
            },
            // A provider-side model switch surfaces through
            // nativeMetadata.modelSelection on provider_thread.updated.
            {
              type: "emit_inbound",
              frame: wireFrame(4, {
                kind: "deltas",
                deltas: [
                  {
                    op: "state.updated",
                    patch: {
                      revision: 6,
                      config: {
                        ...snapshotFrame.config,
                        model: "GLM-5.4",
                        thought: "high",
                        modelSelection: {
                          providerId: PROVIDER_ID,
                          modelId: "GLM-5.4",
                          options: { reasoningLevel: "high" },
                        },
                      },
                    },
                  },
                ],
              }),
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;

        const sentCommandIds = yield* Ref.make<Array<string | undefined>>([]);
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript, {
          onOutbound: (actual) => {
            const frame = actual as {
              method?: string;
              params?: { type?: string; commandId?: string };
            };
            return frame.method === "v4/command"
              ? Ref.update(sentCommandIds, (ids) => [...ids, frame.params?.commandId])
              : Effect.void;
          },
          beforeEmitInbound: (entry) =>
            Ref.get(sentCommandIds).pipe(
              Effect.andThen((ids) =>
                Effect.sync(() => {
                  const [sendTextId, steerId] = [ids[2], ids[3]];
                  const params = (
                    entry.frame as {
                      params?: {
                        frame?: {
                          payload?: {
                            deltas?: Array<{
                              row?: Record<string, unknown>;
                              patch?: {
                                queue?: { items?: Array<Record<string, unknown>> };
                              };
                            }>;
                          };
                        };
                      };
                    }
                  ).params?.frame?.payload;
                  for (const delta of params?.deltas ?? []) {
                    if (delta.row?.sourceCommandId === "<sendText-commandId>") {
                      delta.row.sourceCommandId = sendTextId;
                    }
                    for (const item of delta.patch?.queue?.items ?? []) {
                      if (item.sourceCommandId === "<steer-commandId>") {
                        item.sourceCommandId = steerId;
                      }
                    }
                  }
                }),
              ),
            ),
        });
        const openClient = (_input: ZcodeAppServerSpawnInput) =>
          Layer.build(ZCodeReplay.layerReplayWithDriver(driver)).pipe(
            Effect.map((ctx) => Context.get(ctx, ZCodeClient.ZCodeAppServerClient)),
            Effect.mapError(
              (cause) => new ZcodeAppServerSpawnOpenError({ command: "replay", cause }),
            ),
          );

        const adapter = yield* makeZcodeAdapterV2({
          instanceId: "zcode-test" as never,
          settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
          environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
          openClient,
        });
        const runtime = yield* adapter
          .openSession({
            threadId: "thread-1" as never,
            providerSessionId: "ps2" as never,
            modelSelection: { model: `${PROVIDER_ID}/${MODEL_ID}` } as never,
            runtimePolicy: {
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: "/tmp/ws",
              reasoningEffort: "low",
            } as never,
          })
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
        const providerThread = yield* runtime.ensureThread({
          threadId: "thread-1" as never,
          modelSelection: { model: `${PROVIDER_ID}/${MODEL_ID}` } as never,
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/tmp/ws",
            reasoningEffort: "low",
          } as never,
        });
        const events = yield* Queue.unbounded<
          ProviderAdapter.ProviderAdapterV2Event & {
            providerThread?: OrchestrationV2ProviderThread;
            providerTurn?: { id: string };
          }
        >();
        yield* Stream.runForEach(runtime.events, (event) => Queue.offer(events, event)).pipe(
          Effect.forkScoped,
        );
        const awaitEvent = Effect.fnUntraced(function* (
          predicate: (event: {
            readonly type: string;
            providerThread?: OrchestrationV2ProviderThread;
            providerTurn?: { id: string };
          }) => boolean,
        ) {
          for (;;) {
            const event = yield* Queue.take(events);
            if (predicate(event)) return event;
          }
        });
        // Drain the snapshot so session config is known before the turn.
        yield* runtime.readThreadSnapshot({ providerThread });
        yield* runtime.startTurn({
          appThread: {} as never,
          threadId: "thread-1" as never,
          runId: "run-1" as never,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: "attempt-1" as never,
          rootNodeId: "node-1" as never,
          providerThread,
          message: {
            messageId: "msg-1" as never,
            text: "first",
            attachments: [],
            createdBy: null,
            creationSource: "web",
          } as never,
          modelSelection: { model: `${PROVIDER_ID}/${MODEL_ID}` } as never,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/tmp/ws",
            reasoningEffort: "low",
          } as never,
        });
        // The adopted running turn is the steer precondition.
        yield* awaitEvent(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn?.id === providerTurnId,
        );
        yield* runtime.steerTurn({
          threadId: "thread-1" as never,
          runId: "run-1" as never,
          providerThread,
          providerTurnId,
          message: {
            messageId: "msg-2" as never,
            text: "steer me",
            attachments: [],
            createdBy: null,
            creationSource: "web",
          } as never,
        });
        // The config patch's provider_thread.updated is the last milestone.
        const reported = yield* awaitEvent(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread?.nativeMetadata?.modelSelection?.model ===
              `${PROVIDER_ID}/GLM-5.4`,
        );
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length);
        assert.equal(
          reported.providerThread?.nativeMetadata?.modelSelection?.options?.[0]?.value,
          "high",
        );
      }),
    );
  },
);
