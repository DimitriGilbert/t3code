import { assert, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import type * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";
import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";

import { ZcodeSettings } from "../settings.ts";

const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);
import { buildZcodeAppServerSpawnInput } from "./zcodeAppServer.ts";
import {
  zcodeExecutionStateForRuntimePolicy,
  zcodePermissionAnswer,
  zcodePermissionOptionForDecision,
  zcodeReportedModelSelection,
  zcodeRequestKindForTool,
  zcodeResolveModelSelection,
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

it("resolves model slugs into wire model selections", () => {
  const config = {
    provider: "account:zai-individual-coding-plan",
    model: "GLM-5.3",
    thought: "max",
    followupMode: "queue" as const,
  };
  expect(
    zcodeResolveModelSelection({
      model: "account:zai-individual-coding-plan/GLM-5.3-Flash",
      config,
    }),
  ).toEqual({
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    reasoningLevel: "max",
  });
  // A bare model id pairs with the session's current provider.
  expect(zcodeResolveModelSelection({ model: "GLM-5.3-Flash", config })).toEqual({
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    reasoningLevel: "max",
  });
  // `default` (and empty) keep the session's current selection.
  for (const model of ["default", ""]) {
    expect(zcodeResolveModelSelection({ model, config })).toEqual({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3",
      reasoningLevel: "max",
    });
  }
});

it("migrates cached ACP-era model slugs to current provider ids", () => {
  const config = {
    provider: "account:zai-individual-coding-plan",
    model: "GLM-5.3",
    thought: "max",
    followupMode: "queue" as const,
  };
  // The ACP bridge advertised `providerId\modelId` values with `builtin:` ids;
  // a cached picker slug must not leak into the registry model id.
  expect(zcodeResolveModelSelection({ model: "builtin:zai-coding-plan\\GLM-5.3", config })).toEqual(
    {
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3",
      reasoningLevel: "max",
    },
  );
  expect(
    zcodeResolveModelSelection({ model: "builtin:bigmodel-coding-plan\\GLM-5.3", config }),
  ).toEqual({
    providerId: "account:bigmodel-individual-coding-plan",
    modelId: "GLM-5.3",
    reasoningLevel: "max",
  });
  // `/`-joined legacy picker values can carry a `model$level` suffix.
  expect(
    zcodeResolveModelSelection({ model: "builtin:zai-coding-plan/GLM-5.3$high", config }),
  ).toEqual({
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3",
    reasoningLevel: "high",
  });
  // The runtime policy's effort still wins over an embedded level.
  expect(
    zcodeResolveModelSelection({
      model: "builtin:zai-coding-plan/GLM-5.3$high",
      reasoningEffort: "low",
      config,
    }),
  ).toEqual({
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3",
    reasoningLevel: "low",
  });
  // `custom:` values URI-decode their components and special-case `builtin:`.
  expect(
    zcodeResolveModelSelection({ model: "custom:builtin:zai-coding-plan:GLM-5.3", config }),
  ).toEqual({
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3",
    reasoningLevel: "max",
  });
  expect(
    zcodeResolveModelSelection({
      model: "custom:account%3Azai-individual-coding-plan:GLM-5.3-Flash",
      config,
    }),
  ).toEqual({
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    reasoningLevel: "max",
  });
  // `glm`/`zcode` are old execution-backend names, and unknown `builtin:` ids
  // have no current provider — both defer to the session's selection.
  expect(zcodeResolveModelSelection({ model: "glm\\GLM-5.3", config })).toBeUndefined();
  expect(zcodeResolveModelSelection({ model: "builtin:unknown\\GLM-5.3", config })).toBeUndefined();
  // Official GLM ids canonicalize case on legacy providers.
  expect(
    zcodeResolveModelSelection({ model: "builtin:zai-coding-plan\\glm-5.3-flash", config }),
  ).toEqual({
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3-Flash",
    reasoningLevel: "max",
  });
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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

const wireFrame = (
  ordinal: number,
  payload: unknown,
  deliveryKind = "online",
  topic = "conversation/s1",
  subscriptionId = "sub1",
) => ({
  method: "v4/conversation/frame",
  params: {
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `lf-${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic,
    subscriptionId,
    frame: {
      topic,
      subscriptionId,
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

    it.effect("sends the registry model pair for a cached ACP-era slug", () =>
      Effect.gen(function* () {
        // A stale picker slug cached by the old ACP bridge (`provider\model`
        // with a `builtin:` id) must resolve to the pair the pushed registry
        // actually published — previously it leaked through verbatim and the
        // registry rejected sendText as modelUnavailable.
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "legacy model slug migration",
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
                  clientId: "t3-ps3",
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
                  connectionId: "t3-ps3",
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
            {
              type: "expect_outbound",
              frame: {
                id: 3,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps3",
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
                id: 3,
                result: {
                  commandId: "c3",
                  status: "accepted",
                  revisionAtDecision: 2,
                  result: { type: "inputAccepted", delivery: "startNow", inputId: "in1" },
                },
              },
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;

        const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
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
            providerSessionId: "ps3" as never,
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
        yield* Stream.runDrain(runtime.events).pipe(Effect.forkScoped);
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
          // The stale slug the ACP bridge advertised (literal backslash).
          modelSelection: { model: "builtin:zai-coding-plan\\GLM-5.3" } as never,
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/tmp/ws",
            reasoningEffort: "low",
          } as never,
        });
        yield* runtime.readThreadSnapshot({ providerThread });
        for (let i = 0; i < 100; i += 1) yield* Effect.yieldNow;
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length, `cursor=${st.cursor}`);
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

    it.effect(
      "projects permission and userInput interactions, resolves them, and releases reverse-request legs",
      () =>
        Effect.gen(function* () {
          const permissionPayload = {
            kind: "permission" as const,
            toolCallId: "tc-1",
            toolName: "Bash",
            summary: "Run ls -la",
            detail: { command: "ls -la" },
            freeText: true,
            options: [
              {
                optionId: "allowOnce",
                label: "Allow once",
                kind: "allowOnce" as const,
                response: { decision: "allow", reason: "Approved once" },
              },
              {
                optionId: "allow_project",
                label: "Always allow in this project",
                kind: "allowAlways" as const,
                response: { decision: "allow", reason: "Approved for this project" },
              },
              {
                optionId: "deny",
                label: "Deny",
                kind: "deny" as const,
                response: { decision: "deny" },
              },
            ],
          };
          const permissionInteraction = (id: string, anchorRowId: number | null) => ({
            interactionId: id,
            kind: "permission" as const,
            anchorRowId,
            createdAt: 1735689600500,
            payload: permissionPayload,
          });
          const userInputPayload = {
            kind: "userInput" as const,
            prompt: "Tell me your choices",
            freeText: true,
            toolCallId: "tc-2",
            toolName: "AskUserQuestion",
            questions: [
              {
                question: "Pick a color",
                header: "color",
                options: [
                  { value: "red", label: "Red" },
                  { value: "blue", label: "Blue" },
                ],
              },
              {
                question: "Pick sizes",
                header: "sizes",
                multiSelect: true,
                options: [
                  { value: "s", label: "S" },
                  { value: "m", label: "M" },
                ],
              },
            ],
          };
          const interactionsPatch = (pending: ReadonlyArray<unknown>) => ({
            op: "state.updated" as const,
            patch: { pendingInteractions: pending },
          });
          const transcript = {
            provider: "zcode",
            protocol: "zcode.app-server-v4",
            version: "1",
            scenario: "p4 interactions",
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
                    clientId: "t3-ps3",
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
                    connectionId: "t3-ps3",
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
              {
                type: "expect_outbound",
                frame: {
                  id: 3,
                  method: "v4/command",
                  params: {
                    commandId: "<ignored>",
                    clientId: "t3-ps3",
                    sessionId: "s1",
                    issuedAt: "<ignored>",
                    type: "sendText",
                    payload: {
                      text: "go",
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
                  id: 3,
                  result: {
                    commandId: "c3",
                    status: "accepted",
                    revisionAtDecision: 1,
                    result: { type: "inputAccepted", delivery: "startNow", inputId: "in1" },
                  },
                },
              },
              // Turn adopts; a gated tool call raises a permission plus a
              // second unanchored permission, both pending.
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
                    {
                      op: "row.upserted",
                      row: {
                        rowId: 2,
                        createdAt: 1735689600100,
                        createdAtSeq: 2,
                        turnId: "turn-1",
                        kind: "toolCall",
                        toolName: "Bash",
                        toolCallId: "tc-1",
                        status: "pendingApproval",
                        approvalInteractionId: "int-1",
                        inputText: "ls -la",
                      },
                    },
                    interactionsPatch([
                      permissionInteraction("int-1", 2),
                      permissionInteraction("int-2", null),
                    ]),
                  ],
                }),
              },
              // The legacy reverse request for the same interaction must be
              // held, never error-responded, and answered after the v4 command.
              {
                type: "emit_inbound",
                frame: {
                  id: "srv-perm-1",
                  method: "interaction/requestPermission",
                  params: {
                    requestId: "int-1",
                    sessionId: "s1",
                    toolCallId: "tc-1",
                    toolName: "Bash",
                    reason: "Run ls -la",
                    riskLevel: "low",
                    input: {},
                    options: [],
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 4,
                  method: "v4/command",
                  params: {
                    commandId: "<ignored>",
                    clientId: "t3-ps3",
                    sessionId: "s1",
                    issuedAt: "<ignored>",
                    type: "resolveInteraction",
                    payload: {
                      interactionId: "int-1",
                      answer: { optionId: "allowOnce" },
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  id: 4,
                  result: { commandId: "c4", status: "accepted", revisionAtDecision: 2 },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: "srv-perm-1",
                  result: { decision: "allow", reason: "Approved once" },
                },
              },
              // int-1 drops out (already settled); int-2 is answered nowhere —
              // the next patch evicts it like an upstream resolution.
              {
                type: "emit_inbound",
                frame: wireFrame(3, {
                  kind: "deltas",
                  deltas: [interactionsPatch([permissionInteraction("int-2", null)])],
                }),
              },
              // A multi-question AskUserQuestion replaces it.
              {
                type: "emit_inbound",
                frame: wireFrame(4, {
                  kind: "deltas",
                  deltas: [
                    interactionsPatch([
                      {
                        interactionId: "int-u1",
                        kind: "userInput",
                        anchorRowId: null,
                        createdAt: 1735689600600,
                        payload: userInputPayload,
                      },
                    ]),
                  ],
                }),
              },
              {
                type: "emit_inbound",
                frame: {
                  id: "srv-ui-1",
                  method: "interaction/requestUserInput",
                  params: {
                    requestId: "int-u1",
                    sessionId: "s1",
                    prompt: "Tell me your choices",
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 5,
                  method: "v4/command",
                  params: {
                    commandId: "<ignored>",
                    clientId: "t3-ps3",
                    sessionId: "s1",
                    issuedAt: "<ignored>",
                    type: "resolveInteraction",
                    payload: {
                      interactionId: "int-u1",
                      answer: {
                        action: "accept",
                        content: {
                          answers: { "Pick a color": "blue", "Pick sizes": "s, m" },
                          answer_0: "blue",
                          answer_1: ["s", "m"],
                        },
                      },
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  id: 5,
                  result: { commandId: "c5", status: "accepted", revisionAtDecision: 3 },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: "srv-ui-1",
                  result: {
                    action: "accept",
                    content: {
                      answers: { "Pick a color": "blue", "Pick sizes": "s, m" },
                      answer_0: "blue",
                      answer_1: ["s", "m"],
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: wireFrame(5, {
                  kind: "deltas",
                  deltas: [interactionsPatch([])],
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
                    const params = (
                      entry.frame as {
                        params?: {
                          frame?: {
                            payload?: {
                              deltas?: Array<{ row?: Record<string, unknown> }>;
                            };
                          };
                        };
                      }
                    ).params?.frame?.payload;
                    for (const delta of params?.deltas ?? []) {
                      if (delta.row?.sourceCommandId === "<sendText-commandId>") {
                        delta.row.sourceCommandId = ids[1];
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
              providerSessionId: "ps3" as never,
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
          const requestEvents = yield* Queue.unbounded<{
            readonly id: OrchestrationV2RuntimeRequest["id"];
            readonly status: string;
            readonly nativeId: string | null | undefined;
          }>();
          yield* Stream.runForEach(runtime.events, (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest !== undefined
              ? Queue.offer(requestEvents, {
                  id: event.runtimeRequest.id,
                  status: event.runtimeRequest.status,
                  nativeId: event.runtimeRequest.nativeRequestRef?.nativeId,
                })
              : Effect.void,
          ).pipe(Effect.forkScoped);
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
              text: "go",
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
          const awaitPendingRequest = Effect.fnUntraced(function* (nativeId: string) {
            for (;;) {
              const event = yield* Queue.take(requestEvents);
              if (event.nativeId === nativeId && event.status === "pending") return event.id;
            }
          });
          const permissionRequestId = yield* awaitPendingRequest("int-1");
          yield* runtime.respondToRuntimeRequest({
            requestId: permissionRequestId,
            decision: "accept",
          });
          const userInputRequestId = yield* awaitPendingRequest("int-u1");
          yield* runtime.respondToRuntimeRequest({
            requestId: userInputRequestId,
            answers: { color: "blue", sizes: ["s", "m"] },
          });
          // The final clearing patch emits a resolved event for int-u1; the
          // driver asserts every transcript entry was consumed in order.
          for (;;) {
            const event = yield* Queue.take(requestEvents);
            if (event.nativeId === "int-u1" && event.status === "resolved") break;
          }
          const st = yield* Ref.get(driver.state);
          assert.isNull(st.failure, JSON.stringify(st.failure));
          assert.equal(st.cursor, transcript.entries.length, "transcript not fully consumed");
        }),
    );

    it.effect("projects workspace hook reviews outside any turn and trusts trustable items", () =>
      Effect.gen(function* () {
        const hookReviewPayload = {
          kind: "workspaceHookReview" as const,
          reviewFlowId: "flow-1",
          generation: 1,
          interactionId: "int-hook-1",
          sessionId: "s1",
          taskId: "task-1",
          runId: "run-hook-1",
          workspaceIdentity: "/tmp/ws",
          workspaceLabel: "/tmp/ws",
          bundleDigest: "ab".repeat(32),
          createdAt: 1735689600000,
          deadlineAt: 1735690200000,
          sourceFiles: [
            { path: "/tmp/ws/.zcode/hooks.json", displayPath: ".zcode/hooks.json", editable: true },
          ],
          summary: { eventCount: 2, hookCount: 2, pendingCount: 1 },
          items: [
            {
              reviewItemId: "item-1",
              event: "SessionStart" as const,
              type: "command" as const,
              displayName: "bootstrap",
              displayCommand: "./scripts/bootstrap.sh",
              sourcePath: "/tmp/ws/.zcode/hooks.json",
              resolvedTimeoutMs: 5000,
              resolvedMaxOutputBytes: 4096,
              executionMode: "foreground" as const,
              configuredEnabled: true,
              editable: true,
              trustState: "pending_trust" as const,
            },
            {
              reviewItemId: "item-2",
              event: "PreToolUse" as const,
              type: "command" as const,
              displayName: "guard",
              displayCommand: "./scripts/guard.sh",
              sourcePath: "/tmp/ws/.zcode/hooks.json",
              resolvedTimeoutMs: 5000,
              resolvedMaxOutputBytes: 4096,
              executionMode: "foreground" as const,
              configuredEnabled: true,
              editable: true,
              trustState: "trusted_persistent" as const,
            },
          ],
          warningCode: "workspace_hooks_execute_code" as const,
        };
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "p4 hook review",
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
                  clientId: "t3-ps4",
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
                  connectionId: "t3-ps4",
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
              frame: wireFrame(
                1,
                {
                  kind: "snapshot",
                  snapshot: {
                    ...snapshotFrame,
                    pendingInteractions: [
                      {
                        interactionId: "int-hook-1",
                        kind: "workspaceHookReview",
                        anchorRowId: null,
                        createdAt: 1735689600000,
                        payload: hookReviewPayload,
                      },
                    ],
                  },
                },
                "initial",
              ),
            },
            {
              type: "expect_outbound",
              frame: {
                id: 3,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps4",
                  sessionId: "s1",
                  issuedAt: "<ignored>",
                  type: "respondWorkspaceHookReview",
                  payload: {
                    sessionId: "s1",
                    taskId: "task-1",
                    runId: "run-hook-1",
                    workspaceIdentity: "/tmp/ws",
                    bundleDigest: "ab".repeat(32),
                    reviewFlowId: "flow-1",
                    generation: 1,
                    interactionId: "int-hook-1",
                    decision: {
                      action: "trust_selected",
                      reviewItemIds: ["item-1"],
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 3,
                result: { commandId: "c3", status: "accepted", revisionAtDecision: 1 },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(2, {
                kind: "deltas",
                deltas: [{ op: "state.updated", patch: { pendingInteractions: [] } }],
              }),
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;

        const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
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
            providerSessionId: "ps4" as never,
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
        const requestEvents = yield* Queue.unbounded<{
          readonly status: string;
          readonly nativeId: string | null | undefined;
        }>();
        yield* Stream.runForEach(runtime.events, (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest !== undefined
            ? Queue.offer(requestEvents, {
                status: event.runtimeRequest.status,
                nativeId: event.runtimeRequest.nativeRequestRef?.nativeId,
              })
            : Effect.void,
        ).pipe(Effect.forkScoped);
        // readThreadSnapshot drains the initial snapshot, surfacing the review.
        const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
        const request = snapshot.runtimeRequests.find(
          (entry) => entry.nativeRequestRef?.nativeId === "int-hook-1",
        );
        if (request === undefined) {
          return yield* Effect.die("hook review request not projected");
        }
        yield* runtime.respondToRuntimeRequest({
          requestId: request.id,
          decision: "accept",
        });
        for (;;) {
          const event = yield* Queue.take(requestEvents);
          if (event.nativeId === "int-hook-1" && event.status === "resolved") break;
        }
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length);
      }),
    );

    const rollbackRows = [
      {
        rowId: 1,
        createdAt: 1735689600000,
        createdAtSeq: 1,
        turnId: "turn-1",
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: 1735689600000,
        endedAt: 1735689601000,
      },
      {
        rowId: 2,
        createdAt: 1735689600100,
        createdAtSeq: 2,
        turnId: "turn-1",
        kind: "userInput",
        text: "first",
        origin: "realUser",
        entityId: "ent-u2",
      },
      {
        rowId: 3,
        createdAt: 1735689600200,
        createdAtSeq: 3,
        turnId: "turn-1",
        kind: "assistantText",
        text: "one",
        state: "complete",
        entityId: "ent-a3",
        actions: { canFork: true },
      },
      {
        rowId: 4,
        createdAt: 1735689601000,
        createdAtSeq: 4,
        turnId: "turn-2",
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: 1735689601000,
        endedAt: 1735689602000,
      },
      {
        rowId: 5,
        createdAt: 1735689601100,
        createdAtSeq: 5,
        turnId: "turn-2",
        kind: "userInput",
        text: "second",
        origin: "realUser",
        entityId: "ent-u5",
      },
      {
        rowId: 6,
        createdAt: 1735689601200,
        createdAtSeq: 6,
        turnId: "turn-2",
        kind: "assistantText",
        text: "two",
        state: "complete",
        entityId: "ent-a6",
        actions: { canFork: true },
      },
    ];
    const rollbackSnapshot = {
      ...snapshotFrame,
      revision: 7,
      control: { ...snapshotFrame.control, phase: "completedSuccess", sessionEnded: true },
      rows: { window: rollbackRows, totalCount: rollbackRows.length, firstRowId: null },
    };
    const seededSessionEntries = (clientTag: string) => [
      {
        type: "emit_inbound" as const,
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
        type: "expect_outbound" as const,
        frame: {
          id: 1,
          method: "v4/command",
          params: {
            commandId: "<ignored>",
            clientId: clientTag,
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
        type: "emit_inbound" as const,
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
        type: "expect_outbound" as const,
        frame: {
          id: 2,
          method: "v4/conversation/subscribe",
          params: {
            topic: "conversation/s1",
            connectionId: clientTag,
            clientMode: "desktop-continuous",
          },
        },
      },
      {
        type: "emit_inbound" as const,
        frame: {
          id: 2,
          result: { ack: { subscriptionId: "sub1", mode: "snapshot", logEpoch: "e1" } },
        },
      },
      {
        type: "emit_inbound" as const,
        frame: wireFrame(1, { kind: "snapshot", snapshot: rollbackSnapshot }, "initial"),
      },
    ];
    const makeReplayOpenClient =
      (driver: ZCodeReplay.ZCodeAppServerReplayDriver) => (_input: ZcodeAppServerSpawnInput) =>
        Layer.build(ZCodeReplay.layerReplayWithDriver(driver)).pipe(
          Effect.map((ctx) => Context.get(ctx, ZCodeClient.ZCodeAppServerClient)),
          Effect.mapError(
            (cause) => new ZcodeAppServerSpawnOpenError({ command: "replay", cause }),
          ),
        );
    const sessionOpenInput = {
      threadId: "thread-1" as never,
      modelSelection: { model: `${PROVIDER_ID}/${MODEL_ID}` } as never,
      runtimePolicy: {
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/tmp/ws",
        reasoningEffort: "low",
      } as never,
    };

    it.effect(
      "rolls back to a provider turn by forking the session and re-pointing the thread",
      () =>
        Effect.gen(function* () {
          const transcript = {
            provider: "zcode",
            protocol: "zcode.app-server-v4",
            version: "1",
            scenario: "p5 rollback provider_turn",
            entries: [
              ...seededSessionEntries("t3-ps5"),
              {
                type: "expect_outbound",
                frame: {
                  id: 3,
                  method: "v4/command",
                  params: {
                    commandId: "<ignored>",
                    clientId: "t3-ps5",
                    sessionId: "s1",
                    baseRevision: 7,
                    baseLogEpoch: "e1",
                    issuedAt: "<ignored>",
                    type: "forkAssistant",
                    payload: { target: { rowId: 3, entityId: "ent-a3" } },
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
                    revisionAtDecision: 8,
                    result: { type: "forkAssistant", sessionId: "s2" },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 4,
                  method: "v4/conversation/unsubscribe",
                  params: {
                    topic: "conversation/s1",
                    subscriptionId: "sub1",
                    connectionId: "t3-ps5",
                  },
                },
              },
              { type: "emit_inbound", frame: { id: 4, result: {} } },
              {
                type: "expect_outbound",
                frame: {
                  id: 5,
                  method: "session/close",
                  params: { sessionId: "s1" },
                },
              },
              { type: "emit_inbound", frame: { id: 5, result: { closed: true } } },
              {
                type: "expect_outbound",
                frame: {
                  id: 6,
                  method: "v4/conversation/subscribe",
                  params: {
                    topic: "conversation/s2",
                    connectionId: "t3-ps5",
                    clientMode: "desktop-continuous",
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  id: 6,
                  result: { ack: { subscriptionId: "sub2", mode: "snapshot", logEpoch: "e2" } },
                },
              },
              {
                type: "emit_inbound",
                frame: wireFrame(
                  1,
                  {
                    kind: "snapshot",
                    snapshot: {
                      ...rollbackSnapshot,
                      sessionId: "s2",
                      logEpoch: "e2",
                      rows: {
                        window: rollbackRows.slice(0, 3),
                        totalCount: 3,
                        firstRowId: null,
                      },
                    },
                  },
                  "initial",
                  "conversation/s2",
                  "sub2",
                ),
              },
            ],
          } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
          const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
          const adapter = yield* makeZcodeAdapterV2({
            instanceId: "zcode-test" as never,
            settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
            environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
            openClient: makeReplayOpenClient(driver),
          });
          const runtime = yield* adapter
            .openSession({ ...sessionOpenInput, providerSessionId: "ps5" as never })
            .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
          const providerThread = yield* runtime.ensureThread(sessionOpenInput);
          const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
          const boundaryTurn = snapshot.providerTurns.find(
            (turn) => turn.nativeTurnRef?.nativeId === "turn-1",
          );
          if (boundaryTurn === undefined) {
            return yield* Effect.die("boundary provider turn missing from snapshot");
          }
          const rolledBack = yield* runtime.rollbackThread({
            providerThread,
            target: {
              type: "provider_turn",
              checkpointId: "cp-1" as never,
              appRunOrdinal: 1,
              providerTurn: boundaryTurn,
            },
            providerThreadTurns: snapshot.providerTurns,
          });
          assert.equal(rolledBack.providerThread.id, providerThread.id);
          assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, "s2");
          assert.equal(rolledBack.providerThread.nativeConversationHeadRef?.nativeId, "turn-1");
          assert.equal(rolledBack.providerThread.status, "idle");
          const st = yield* Ref.get(driver.state);
          assert.isNull(st.failure, JSON.stringify(st.failure));
          assert.equal(st.cursor, transcript.entries.length);
        }),
    );

    it.effect("rolls back to thread start by adopting a fresh empty session", () =>
      Effect.gen(function* () {
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "p5 rollback thread_start",
          entries: [
            ...seededSessionEntries("t3-ps6"),
            {
              type: "expect_outbound",
              frame: {
                id: 3,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps6",
                  sessionId: null,
                  issuedAt: "<ignored>",
                  type: "createSession",
                  payload: {
                    workspaceId: "/tmp/ws",
                    config: {
                      provider: PROVIDER_ID,
                      model: MODEL_ID,
                      thought: "low",
                      mode: "build",
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
                  revisionAtDecision: 8,
                  result: { type: "createSession", sessionId: "s3" },
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "v4/conversation/unsubscribe",
                params: {
                  topic: "conversation/s1",
                  subscriptionId: "sub1",
                  connectionId: "t3-ps6",
                },
              },
            },
            { type: "emit_inbound", frame: { id: 4, result: {} } },
            {
              type: "expect_outbound",
              frame: { id: 5, method: "session/close", params: { sessionId: "s1" } },
            },
            { type: "emit_inbound", frame: { id: 5, result: { closed: true } } },
            {
              type: "expect_outbound",
              frame: {
                id: 6,
                method: "v4/conversation/subscribe",
                params: {
                  topic: "conversation/s3",
                  connectionId: "t3-ps6",
                  clientMode: "desktop-continuous",
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 6,
                result: { ack: { subscriptionId: "sub3", mode: "snapshot", logEpoch: "e3" } },
              },
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
        const adapter = yield* makeZcodeAdapterV2({
          instanceId: "zcode-test" as never,
          settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
          environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
          openClient: makeReplayOpenClient(driver),
        });
        const runtime = yield* adapter
          .openSession({ ...sessionOpenInput, providerSessionId: "ps6" as never })
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
        const providerThread = yield* runtime.ensureThread(sessionOpenInput);
        yield* runtime.readThreadSnapshot({ providerThread });
        const rolledBack = yield* runtime.rollbackThread({
          providerThread,
          target: { type: "thread_start", checkpointId: "cp-0" as never, appRunOrdinal: 0 },
          providerThreadTurns: [],
        });
        assert.equal(rolledBack.providerThread.id, providerThread.id);
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, "s3");
        assert.isNull(rolledBack.providerThread.nativeConversationHeadRef);
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length);
      }),
    );

    it.effect("forks a thread at a provider turn boundary and subscribes the child", () =>
      Effect.gen(function* () {
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "p5 forkThread",
          entries: [
            ...seededSessionEntries("t3-ps7"),
            {
              type: "expect_outbound",
              frame: {
                id: 3,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-ps7",
                  sessionId: "s1",
                  baseRevision: 7,
                  baseLogEpoch: "e1",
                  issuedAt: "<ignored>",
                  type: "forkAssistant",
                  payload: { target: { rowId: 3, entityId: "ent-a3" } },
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
                  revisionAtDecision: 8,
                  result: { type: "forkAssistant", sessionId: "s2" },
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "v4/conversation/subscribe",
                params: {
                  topic: "conversation/s2",
                  connectionId: "t3-ps7",
                  clientMode: "desktop-continuous",
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 4,
                result: { ack: { subscriptionId: "sub2", mode: "snapshot", logEpoch: "e2" } },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(
                1,
                {
                  kind: "snapshot",
                  snapshot: {
                    ...rollbackSnapshot,
                    sessionId: "s2",
                    logEpoch: "e2",
                    rows: { window: rollbackRows.slice(0, 3), totalCount: 3, firstRowId: null },
                  },
                },
                "initial",
                "conversation/s2",
                "sub2",
              ),
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
        const adapter = yield* makeZcodeAdapterV2({
          instanceId: "zcode-test" as never,
          settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
          environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
          openClient: makeReplayOpenClient(driver),
        });
        const runtime = yield* adapter
          .openSession({ ...sessionOpenInput, providerSessionId: "ps7" as never })
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
        const providerThread = yield* runtime.ensureThread(sessionOpenInput);
        const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
        const boundaryTurn = snapshot.providerTurns.find(
          (turn) => turn.nativeTurnRef?.nativeId === "turn-1",
        );
        if (boundaryTurn === undefined) {
          return yield* Effect.die("boundary provider turn missing from snapshot");
        }
        const forked = yield* runtime.forkThread({
          sourceProviderThread: providerThread,
          sourceProviderTurns: snapshot.providerTurns,
          providerTurnId: boundaryTurn.id,
          targetThreadId: "thread-2" as never,
        });
        assert.equal(forked.appThreadId, "thread-2");
        assert.equal(forked.nativeThreadRef?.nativeId, "s2");
        assert.equal(forked.forkedFrom?.providerThreadId, providerThread.id);
        assert.equal(forked.forkedFrom?.providerTurnId, boundaryTurn.id);
        // Fork keeps the source subscribed; only the new session is added.
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length);
      }),
    );

    it.effect(
      "projects a subagent child thread, subscribes a running child, and reports pending work",
      () =>
        Effect.gen(function* () {
          const childSnapshot = {
            ...snapshotFrame,
            sessionId: "child-1",
            logEpoch: "ec1",
            control: { ...snapshotFrame.control, phase: "running", sessionEnded: false },
            rows: {
              window: [
                {
                  rowId: 1,
                  createdAt: 1735689600200,
                  createdAtSeq: 1,
                  turnId: "cturn-1",
                  kind: "turnHeader",
                  origin: "userInput",
                  executionKind: "agent",
                  state: "running",
                  startedAt: 1735689600200,
                },
                {
                  rowId: 2,
                  createdAt: 1735689600200,
                  createdAtSeq: 2,
                  turnId: "cturn-1",
                  kind: "userInput",
                  origin: "mailbox",
                  text: "Review the zcode protocol package.",
                },
                {
                  rowId: 3,
                  createdAt: 1735689600300,
                  createdAtSeq: 3,
                  turnId: "cturn-1",
                  kind: "assistantText",
                  text: "Scanning",
                  state: "streaming",
                },
              ],
              totalCount: 3,
              firstRowId: null,
            },
          };
          const transcript = {
            provider: "zcode",
            protocol: "zcode.app-server-v4",
            version: "1",
            scenario: "p5 subagent child",
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
                    clientId: "t3-ps8",
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
                    connectionId: "t3-ps8",
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
                frame: wireFrame(
                  1,
                  {
                    kind: "snapshot",
                    snapshot: {
                      ...snapshotFrame,
                      subagents: {
                        revision: 1,
                        childSessionIds: [],
                        running: [],
                        endedTotal: 0,
                      },
                    },
                  },
                  "initial",
                ),
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 3,
                  method: "v4/command",
                  params: {
                    commandId: "<ignored>",
                    clientId: "t3-ps8",
                    sessionId: "s1",
                    issuedAt: "<ignored>",
                    type: "sendText",
                    payload: {
                      text: "spawn",
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
                  id: 3,
                  result: {
                    commandId: "c3",
                    status: "accepted",
                    revisionAtDecision: 1,
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
                    {
                      op: "row.upserted",
                      row: {
                        rowId: 2,
                        createdAt: 1735689600100,
                        createdAtSeq: 2,
                        turnId: "turn-1",
                        kind: "subagent",
                        subagentType: "Explore",
                        status: "running",
                        summaryText: "",
                        childSessionId: "child-1",
                      },
                    },
                    {
                      op: "state.updated",
                      patch: {
                        subagents: {
                          revision: 2,
                          childSessionIds: ["child-1"],
                          running: [
                            {
                              childSessionId: "child-1",
                              subagentType: "Explore",
                              title: "Explore",
                              status: "running",
                            },
                          ],
                          endedTotal: 0,
                        },
                        control: { ...snapshotFrame.control },
                      },
                    },
                  ],
                }),
              },
              // Running children are subscribed eagerly for live status.
              {
                type: "expect_outbound",
                frame: {
                  id: 4,
                  method: "v4/conversation/subscribe",
                  params: {
                    topic: "conversation/child-1",
                    connectionId: "t3-ps8",
                    clientMode: "desktop-continuous",
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  id: 4,
                  result: { ack: { subscriptionId: "subc1", mode: "snapshot", logEpoch: "ec1" } },
                },
              },
              {
                type: "emit_inbound",
                frame: wireFrame(
                  1,
                  { kind: "snapshot", snapshot: childSnapshot },
                  "initial",
                  "conversation/child-1",
                  "subc1",
                ),
              },
              // The child's own turn completes on its own topic — rows land
              // through the same turn-less turnHeader path the snapshot used.
              {
                type: "emit_inbound",
                frame: wireFrame(
                  2,
                  {
                    kind: "deltas",
                    deltas: [
                      {
                        op: "row.upserted",
                        row: {
                          rowId: 3,
                          createdAt: 1735689600300,
                          createdAtSeq: 4,
                          turnId: "cturn-1",
                          kind: "assistantText",
                          text: "Scanning done",
                          state: "complete",
                        },
                      },
                      {
                        op: "row.upserted",
                        row: {
                          rowId: 1,
                          createdAt: 1735689600200,
                          createdAtSeq: 5,
                          turnId: "cturn-1",
                          kind: "turnHeader",
                          origin: "userInput",
                          executionKind: "agent",
                          state: "completedSuccess",
                          startedAt: 1735689600200,
                          endedAt: 1735689605000,
                        },
                      },
                    ],
                  },
                  "online",
                  "conversation/child-1",
                  "subc1",
                ),
              },
            ],
          } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
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
                          frame?: {
                            payload?: { deltas?: Array<{ row?: Record<string, unknown> }> };
                          };
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
          const adapter = yield* makeZcodeAdapterV2({
            instanceId: "zcode-test" as never,
            settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
            environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
            openClient: makeReplayOpenClient(driver),
          });
          const allocator = yield* IdAllocator.IdAllocatorV2;
          const runtime = yield* adapter
            .openSession({ ...sessionOpenInput, providerSessionId: "ps8" as never })
            .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
          const providerThread = yield* runtime.ensureThread(sessionOpenInput);
          const childThreadId = allocator.derive.threadFromProviderThread({
            driver: "zcode" as never,
            nativeThreadId: "child-1",
            providerInstanceId: "zcode-test" as never,
          });
          const childProviderThreadId = allocator.derive.providerThread({
            driver: "zcode" as never,
            nativeThreadId: "child-1",
            providerInstanceId: "zcode-test" as never,
          });
          const seen = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* Stream.runForEach(runtime.events, (event) => Queue.offer(seen, event)).pipe(
            Effect.forkScoped,
          );
          const awaitEvent = Effect.fnUntraced(function* (
            predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
          ) {
            for (;;) {
              const event = yield* Queue.take(seen);
              if (predicate(event)) return event;
            }
          });
          yield* runtime.readThreadSnapshot({ providerThread });
          yield* runtime.startTurn({
            appThread: {
              id: "thread-1",
              title: "Parent thread",
              lineage: { rootThreadId: "thread-1" },
              modelSelection: { instanceId: "zcode-test", model: `${PROVIDER_ID}/${MODEL_ID}` },
            } as never,
            threadId: "thread-1" as never,
            runId: "run-1" as never,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: "attempt-1" as never,
            rootNodeId: "node-1" as never,
            providerThread,
            message: {
              messageId: "msg-1" as never,
              text: "spawn",
              attachments: [],
              createdBy: null,
              creationSource: "web",
            } as never,
            modelSelection: sessionOpenInput.modelSelection,
            runtimePolicy: sessionOpenInput.runtimePolicy,
          });
          const created = yield* awaitEvent((event) => event.type === "app_thread.created");
          assert.equal(
            created.type === "app_thread.created" ? created.appThread.id : undefined,
            childThreadId,
          );
          const childUpdated = yield* awaitEvent(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeThreadRef?.nativeId === "child-1",
          );
          assert.equal(
            childUpdated.type === "provider_thread.updated"
              ? childUpdated.providerThread.forkedFrom?.providerThreadId
              : undefined,
            providerThread.id,
          );
          const subagent = yield* awaitEvent((event) => event.type === "subagent.updated");
          assert.equal(
            subagent.type === "subagent.updated" ? subagent.subagent.childThreadId : undefined,
            childThreadId,
          );
          assert.equal(
            subagent.type === "subagent.updated" ? subagent.subagent.providerThreadId : undefined,
            childProviderThreadId,
          );
          // The running-subagents patch lands before its frame's
          // provider_thread.updated; that emit is the apply milestone.
          yield* awaitEvent(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeThreadRef?.nativeId === "s1" &&
              event.providerThread.status === "active",
          );
          const hasPending = runtime.hasPendingBackgroundWork ?? Effect.succeed(false);
          const forThread =
            runtime.hasPendingBackgroundWorkForThread ?? (() => Effect.succeed(false));
          assert.isTrue(yield* hasPending);
          assert.isTrue(yield* forThread(providerThread));
          // The child session's own turn projects as runless work on the
          // child thread: root node, provider turn, prompt, and content.
          const childRootNode = yield* awaitEvent(
            (event) =>
              event.type === "node.updated" &&
              event.node.threadId === childThreadId &&
              event.node.kind === "root_turn",
          );
          assert.equal(
            childRootNode.type === "node.updated" ? childRootNode.node.status : undefined,
            "running",
          );
          assert.equal(
            childRootNode.type === "node.updated" ? childRootNode.node.runId : "set",
            null,
          );
          const childTurnRunning = yield* awaitEvent(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.providerThreadId === childProviderThreadId,
          );
          assert.equal(
            childTurnRunning.type === "provider_turn.updated"
              ? childTurnRunning.providerTurn.status
              : undefined,
            "running",
          );
          assert.equal(
            childTurnRunning.type === "provider_turn.updated"
              ? childTurnRunning.providerTurn.runAttemptId
              : "set",
            null,
          );
          const childPrompt = yield* awaitEvent(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.threadId === childThreadId &&
              event.turnItem.type === "user_message",
          );
          assert.equal(
            childPrompt.type === "turn_item.updated" ? childPrompt.turnItem.runId : "set",
            null,
          );
          yield* awaitEvent(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.threadId === childThreadId &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.status === "running",
          );
          // The child's terminal turnHeader finalizes its observed turn:
          // provider_turn completed, root node completed — no run-scoped
          // turn.terminal is emitted for a runless turn.
          const childTurnDone = yield* awaitEvent(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.providerThreadId === childProviderThreadId &&
              event.providerTurn.status === "completed",
          );
          assert.equal(
            childTurnDone.type === "provider_turn.updated"
              ? childTurnDone.providerTurn.runAttemptId
              : "set",
            null,
          );
          yield* awaitEvent(
            (event) =>
              event.type === "node.updated" &&
              event.node.threadId === childThreadId &&
              event.node.kind === "root_turn" &&
              event.node.status === "completed",
          );
          const st = yield* Ref.get(driver.state);
          assert.isNull(st.failure, JSON.stringify(st.failure));
          assert.equal(st.cursor, transcript.entries.length);
        }),
    );

    it.effect("projects provider-started turns on the root thread as runless observed turns", () =>
      Effect.gen(function* () {
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "p8 observed turn on root",
          entries: [
            ...seededSessionEntries("t3-psA"),
            // A turn the provider itself started (background result): no
            // sourceCommandId, foreign clientId — nothing T3 issued.
            {
              type: "emit_inbound",
              frame: wireFrame(2, {
                kind: "deltas",
                deltas: [
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 10,
                      createdAt: 1735689603000,
                      createdAtSeq: 10,
                      turnId: "turn-bg",
                      kind: "turnHeader",
                      origin: "backgroundResult",
                      executionKind: "agent",
                      state: "running",
                      startedAt: 1735689603000,
                    },
                  },
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 11,
                      createdAt: 1735689603000,
                      createdAtSeq: 11,
                      turnId: "turn-bg",
                      kind: "userInput",
                      origin: "backgroundResult",
                      clientId: "zcode-desktop-9",
                      text: "[background] deploy finished",
                    },
                  },
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 12,
                      createdAt: 1735689603100,
                      createdAtSeq: 12,
                      turnId: "turn-bg",
                      kind: "assistantText",
                      text: "Background result applied.",
                      state: "complete",
                    },
                  },
                  {
                    op: "row.upserted",
                    row: {
                      rowId: 10,
                      createdAt: 1735689603000,
                      createdAtSeq: 13,
                      turnId: "turn-bg",
                      kind: "turnHeader",
                      origin: "backgroundResult",
                      executionKind: "agent",
                      state: "completedSuccess",
                      startedAt: 1735689603000,
                      endedAt: 1735689605000,
                    },
                  },
                ],
              }),
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
        const adapter = yield* makeZcodeAdapterV2({
          instanceId: "zcode-test" as never,
          settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
          environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
          openClient: makeReplayOpenClient(driver),
        });
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const runtime = yield* adapter
          .openSession({ ...sessionOpenInput, providerSessionId: "psA" as never })
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
        const providerThread = yield* runtime.ensureThread(sessionOpenInput);
        const seen = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(runtime.events, (event) => Queue.offer(seen, event)).pipe(
          Effect.forkScoped,
        );
        const awaitEvent = Effect.fnUntraced(function* (
          predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
        ) {
          for (;;) {
            const event = yield* Queue.take(seen);
            if (predicate(event)) return event;
          }
        });
        yield* runtime.readThreadSnapshot({ providerThread });
        const bgTurnId = allocator.derive.providerTurn({
          driver: "zcode" as never,
          nativeTurnId: "turn-bg",
        });
        // Historical snapshot turns are observed turns too (runAttemptId
        // null), same parity shape as subagent children.
        const turn1Id = allocator.derive.providerTurn({
          driver: "zcode" as never,
          nativeTurnId: "turn-1",
        });
        const t1 = yield* awaitEvent(
          (event) => event.type === "provider_turn.updated" && event.providerTurn.id === turn1Id,
        );
        assert.equal(
          t1.type === "provider_turn.updated" ? t1.providerTurn.runAttemptId : "set",
          null,
        );
        // Emission order: the observed root_turn node lands before the
        // running provider_turn, so await it first.
        const rootNode = yield* awaitEvent(
          (event) =>
            event.type === "node.updated" &&
            event.node.providerTurnId === bgTurnId &&
            event.node.kind === "root_turn",
        );
        assert.equal(
          rootNode.type === "node.updated" ? rootNode.node.threadId : undefined,
          "thread-1",
        );
        assert.equal(rootNode.type === "node.updated" ? rootNode.node.runId : "set", null);
        assert.equal(rootNode.type === "node.updated" ? rootNode.node.countsForRun : "set", false);
        const bgRunning = yield* awaitEvent(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.id === bgTurnId &&
            event.providerTurn.status === "running",
        );
        assert.equal(
          bgRunning.type === "provider_turn.updated"
            ? bgRunning.providerTurn.providerThreadId
            : undefined,
          providerThread.id,
        );
        assert.equal(
          bgRunning.type === "provider_turn.updated" ? bgRunning.providerTurn.runAttemptId : "set",
          null,
        );
        // The provider-injected input projects as the turn's user message.
        const prompt = yield* awaitEvent(
          (event) =>
            event.type === "message.updated" &&
            event.message.text === "[background] deploy finished",
        );
        assert.equal(
          prompt.type === "message.updated" ? prompt.message.threadId : undefined,
          "thread-1",
        );
        yield* awaitEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.providerTurnId === bgTurnId &&
            event.turnItem.type === "assistant_message",
        );
        const bgDone = yield* awaitEvent(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.id === bgTurnId &&
            event.providerTurn.status === "completed",
        );
        assert.equal(
          bgDone.type === "provider_turn.updated" ? bgDone.providerTurn.runAttemptId : "set",
          null,
        );
        yield* awaitEvent(
          (event) =>
            event.type === "node.updated" &&
            event.node.providerTurnId === bgTurnId &&
            event.node.kind === "root_turn" &&
            event.node.status === "completed",
        );
        // Observed turns settle without a run-scoped turn.terminal.
        const rest: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        for (;;) {
          const next = yield* Queue.poll(seen);
          if (Option.isNone(next)) break;
          rest.push(next.value);
        }
        assert.isFalse(
          rest.some((event) => event.type === "turn.terminal" && event.providerTurnId === bgTurnId),
        );
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length);
      }),
    );

    it.effect("creates grandchild threads under a lazily-subscribed child conversation", () =>
      Effect.gen(function* () {
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const derivedThread = (sessionId: string) =>
          allocator.derive.threadFromProviderThread({
            driver: "zcode" as never,
            nativeThreadId: sessionId,
            providerInstanceId: "zcode-test" as never,
          });
        const derivedProviderThread = (sessionId: string) =>
          allocator.derive.providerThread({
            driver: "zcode" as never,
            nativeThreadId: sessionId,
            providerInstanceId: "zcode-test" as never,
          });
        const childThreadId = derivedThread("child-1");
        const childProviderThreadId = derivedProviderThread("child-1");
        const gcThreadId = derivedThread("gc-1");
        const gcProviderThreadId = derivedProviderThread("gc-1");
        const gcSubagentNodeId = allocator.derive.nodeFromProviderItem({
          driver: "zcode" as never,
          nativeItemId: "cturn-1:row:3",
        });
        const childSnapshot = {
          ...snapshotFrame,
          sessionId: "child-1",
          logEpoch: "ec1",
          control: { ...snapshotFrame.control, phase: "running", sessionEnded: false },
          rows: {
            window: [
              {
                rowId: 1,
                createdAt: 1735689600200,
                createdAtSeq: 1,
                turnId: "cturn-1",
                kind: "turnHeader",
                origin: "userInput",
                executionKind: "agent",
                state: "running",
                startedAt: 1735689600200,
              },
              {
                rowId: 2,
                createdAt: 1735689600200,
                createdAtSeq: 2,
                turnId: "cturn-1",
                kind: "userInput",
                origin: "mailbox",
                text: "Review the zcode protocol package.",
              },
              {
                rowId: 3,
                createdAt: 1735689600300,
                createdAtSeq: 3,
                turnId: "cturn-1",
                kind: "subagent",
                subagentType: "Explore",
                status: "running",
                summaryText: "",
                childSessionId: "gc-1",
              },
            ],
            totalCount: 3,
            firstRowId: null,
          },
        };
        const gcSnapshot = {
          ...snapshotFrame,
          sessionId: "gc-1",
          logEpoch: "eg1",
          rows: {
            window: [
              {
                rowId: 1,
                createdAt: 1735689600400,
                createdAtSeq: 1,
                turnId: "gturn-1",
                kind: "turnHeader",
                origin: "userInput",
                executionKind: "agent",
                state: "completedSuccess",
                startedAt: 1735689600400,
                endedAt: 1735689600900,
              },
              {
                rowId: 2,
                createdAt: 1735689600500,
                createdAtSeq: 2,
                turnId: "gturn-1",
                kind: "assistantText",
                text: "Grandchild done",
                state: "complete",
              },
            ],
            totalCount: 2,
            firstRowId: null,
          },
        };
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "p8 cold child grandchild",
          entries: [
            ...seededSessionEntries("t3-psG"),
            {
              type: "expect_outbound",
              frame: {
                id: 3,
                method: "v4/command",
                params: {
                  commandId: "<ignored>",
                  clientId: "t3-psG",
                  sessionId: "s1",
                  issuedAt: "<ignored>",
                  type: "sendText",
                  payload: {
                    text: "hi",
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
                id: 3,
                result: {
                  commandId: "c3",
                  status: "accepted",
                  revisionAtDecision: 8,
                  result: { type: "inputAccepted", delivery: "startNow", inputId: "in1" },
                },
              },
            },
            // Cold path: the child conversation is only subscribed now, via
            // readThreadSnapshot — no eager seed ever ran for it.
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "v4/conversation/subscribe",
                params: {
                  topic: "conversation/child-1",
                  connectionId: "t3-psG",
                  clientMode: "desktop-continuous",
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 4,
                result: { ack: { subscriptionId: "subc1", mode: "snapshot", logEpoch: "ec1" } },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(
                1,
                { kind: "snapshot", snapshot: childSnapshot },
                "initial",
                "conversation/child-1",
                "subc1",
              ),
            },
            // The grandchild row inside the cold child must still create
            // and subscribe its own conversation.
            {
              type: "expect_outbound",
              frame: {
                id: 5,
                method: "v4/conversation/subscribe",
                params: {
                  topic: "conversation/gc-1",
                  connectionId: "t3-psG",
                  clientMode: "desktop-continuous",
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 5,
                result: { ack: { subscriptionId: "subg1", mode: "snapshot", logEpoch: "eg1" } },
              },
            },
            {
              type: "emit_inbound",
              frame: wireFrame(
                1,
                { kind: "snapshot", snapshot: gcSnapshot },
                "initial",
                "conversation/gc-1",
                "subg1",
              ),
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
        const adapter = yield* makeZcodeAdapterV2({
          instanceId: "zcode-test" as never,
          settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
          environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
          openClient: makeReplayOpenClient(driver),
        });
        const runtime = yield* adapter
          .openSession({ ...sessionOpenInput, providerSessionId: "psG" as never })
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
        const providerThread = yield* runtime.ensureThread(sessionOpenInput);
        const seen = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(runtime.events, (event) => Queue.offer(seen, event)).pipe(
          Effect.forkScoped,
        );
        const awaitEvent = Effect.fnUntraced(function* (
          predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
        ) {
          for (;;) {
            const event = yield* Queue.take(seen);
            if (predicate(event)) return event;
          }
        });
        yield* runtime.readThreadSnapshot({ providerThread });
        // A T3 turn gives the root conversation its appThread — the datum
        // the cold child's rebuild chains from.
        yield* runtime.startTurn({
          appThread: {
            id: "thread-1",
            title: "Parent thread",
            lineage: { rootThreadId: "thread-1" },
            modelSelection: { instanceId: "zcode-test", model: `${PROVIDER_ID}/${MODEL_ID}` },
          } as never,
          threadId: "thread-1" as never,
          runId: "run-1" as never,
          runOrdinal: 3,
          providerTurnOrdinal: 3,
          attemptId: "attempt-3" as never,
          rootNodeId: "node-3" as never,
          providerThread,
          message: {
            messageId: "msg-3" as never,
            text: "hi",
            attachments: [],
            createdBy: null,
            creationSource: "web",
          } as never,
          modelSelection: sessionOpenInput.modelSelection,
          runtimePolicy: sessionOpenInput.runtimePolicy,
        });
        const turn1ProviderTurnId = allocator.derive.providerTurn({
          driver: "zcode" as never,
          nativeTurnId: "turn-1",
        });
        // Restored child provider thread, exactly as persisted by the
        // orchestrator: derived ids, owner node, forkedFrom chain.
        const childProviderThread = {
          id: childProviderThreadId,
          driver: "zcode" as never,
          providerInstanceId: "zcode-test" as never,
          providerSessionId: "psG" as never,
          appThreadId: childThreadId,
          ownerNodeId: "owner-node-1" as never,
          nativeThreadRef: {
            driver: "zcode" as never,
            nativeId: "child-1",
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: {
            providerThreadId: providerThread.id,
            providerTurnId: turn1ProviderTurnId,
          },
          pendingBackgroundTasks: [],
          contextUsage: null,
          nativeMetadata: null,
          goal: null,
          createdAt: DateTime.makeUnsafe(0),
          updatedAt: DateTime.makeUnsafe(0),
        } satisfies OrchestrationV2ProviderThread;
        const childRead = yield* runtime.readThreadSnapshot({
          providerThread: childProviderThread,
        });
        assert.equal(childRead.providerThread.nativeThreadRef?.nativeId, "child-1");
        // The cold child got its thread record rebuilt (createOnly — the
        // stored record wins when present) before its snapshot projected.
        const childCreated = yield* awaitEvent(
          (event) => event.type === "app_thread.created" && event.appThread.id === childThreadId,
        );
        assert.equal(
          childCreated.type === "app_thread.created" ? childCreated.createOnly : undefined,
          true,
        );
        // Grandchild thread + provider thread created from the rebuilt parent.
        const gcCreated = yield* awaitEvent(
          (event) => event.type === "app_thread.created" && event.appThread.id === gcThreadId,
        );
        assert.equal(
          gcCreated.type === "app_thread.created"
            ? gcCreated.appThread.lineage.parentThreadId
            : undefined,
          childThreadId,
        );
        assert.equal(
          gcCreated.type === "app_thread.created"
            ? gcCreated.appThread.lineage.relationshipToParent
            : undefined,
          "subagent",
        );
        const gcProviderThread = yield* awaitEvent(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.nativeThreadRef?.nativeId === "gc-1",
        );
        assert.equal(
          gcProviderThread.type === "provider_thread.updated"
            ? gcProviderThread.providerThread.ownerNodeId
            : undefined,
          gcSubagentNodeId,
        );
        assert.equal(
          gcProviderThread.type === "provider_thread.updated"
            ? gcProviderThread.providerThread.forkedFrom?.providerThreadId
            : undefined,
          childProviderThreadId,
        );
        const subagent = yield* awaitEvent(
          (event) =>
            event.type === "subagent.updated" && event.subagent.childThreadId === gcThreadId,
        );
        assert.equal(
          subagent.type === "subagent.updated" ? subagent.subagent.threadId : undefined,
          childThreadId,
        );
        assert.equal(
          subagent.type === "subagent.updated" ? subagent.subagent.providerThreadId : undefined,
          gcProviderThreadId,
        );
        // And the grandchild's own turn projects + settles runlessly.
        const gcDone = yield* awaitEvent(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.providerThreadId === gcProviderThreadId &&
            event.providerTurn.status === "completed",
        );
        assert.equal(
          gcDone.type === "provider_turn.updated" ? gcDone.providerTurn.runAttemptId : "set",
          null,
        );
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length);
      }),
    );

    it.effect("reports retained native turns when upstream truncates the row window", () =>
      Effect.gen(function* () {
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "p5 retained turns on row.removed",
          entries: [
            ...seededSessionEntries("t3-ps9"),
            // A committed provider-side rewind drops turn-2's rows; the
            // surviving turnHeader ids go out on provider_thread.updated.
            {
              type: "emit_inbound",
              frame: wireFrame(2, {
                kind: "deltas",
                deltas: [{ op: "row.removed", fromRowId: 4 }],
              }),
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
        const adapter = yield* makeZcodeAdapterV2({
          instanceId: "zcode-test" as never,
          settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
          environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
          openClient: makeReplayOpenClient(driver),
        });
        const runtime = yield* adapter
          .openSession({ ...sessionOpenInput, providerSessionId: "ps9" as never })
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
        const providerThread = yield* runtime.ensureThread(sessionOpenInput);
        const seen = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Stream.runForEach(runtime.events, (event) => Queue.offer(seen, event)).pipe(
          Effect.forkScoped,
        );
        yield* runtime.readThreadSnapshot({ providerThread });
        const retained = yield* Effect.gen(function* () {
          for (;;) {
            const event = yield* Queue.take(seen);
            if (event.type === "provider_thread.updated" && event.retainedNativeTurnIds) {
              return event.retainedNativeTurnIds;
            }
          }
        });
        assert.deepEqual([...retained], ["turn-1"]);
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length);
      }),
    );

    it.effect(
      "detects pending work from background works and the goal loop, not session liveness",
      () =>
        Effect.gen(function* () {
          const idleControl = {
            ...snapshotFrame.control,
            phase: "completedSuccess",
            sessionEnded: false,
          };
          const transcript = {
            provider: "zcode",
            protocol: "zcode.app-server-v4",
            version: "1",
            scenario: "p5 pending background work signals",
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
                    clientId: "t3-ps10",
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
                    connectionId: "t3-ps10",
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
              // A live session carrying every pending signal at once: running
              // background work, a running subagent, and an active goal loop.
              {
                type: "emit_inbound",
                frame: wireFrame(
                  1,
                  {
                    kind: "snapshot",
                    snapshot: {
                      ...snapshotFrame,
                      control: idleControl,
                      backgroundWorks: [
                        {
                          workId: "w1",
                          kind: "bash",
                          title: "sleep",
                          status: "running",
                          startedAt: 1735689600000,
                          anchorRowId: null,
                        },
                      ],
                      subagents: {
                        revision: 1,
                        childSessionIds: ["c1"],
                        running: [
                          {
                            childSessionId: "c1",
                            subagentType: "t",
                            title: "t",
                            status: "running",
                          },
                        ],
                        endedTotal: 0,
                      },
                      goal: {
                        objective: "keep going",
                        status: "active",
                        iteration: 1,
                        verifications: [],
                      },
                    },
                  },
                  "initial",
                ),
              },
              // Everything clears while sessionEnded stays false — a live
              // session alone is not pending work.
              {
                type: "emit_inbound",
                frame: wireFrame(2, {
                  kind: "deltas",
                  deltas: [
                    {
                      op: "state.updated",
                      patch: {
                        backgroundWorks: [],
                        subagents: {
                          revision: 2,
                          childSessionIds: ["c1"],
                          running: [],
                          endedTotal: 1,
                        },
                        goal: null,
                        control: idleControl,
                      },
                    },
                  ],
                }),
              },
            ],
          } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
          const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
          const adapter = yield* makeZcodeAdapterV2({
            instanceId: "zcode-test" as never,
            settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
            environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
            openClient: makeReplayOpenClient(driver),
          });
          const runtime = yield* adapter
            .openSession({ ...sessionOpenInput, providerSessionId: "ps10" as never })
            .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
          const providerThread = yield* runtime.ensureThread(sessionOpenInput);
          const seen = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* Stream.runForEach(runtime.events, (event) => Queue.offer(seen, event)).pipe(
            Effect.forkScoped,
          );
          const awaitProviderThreadUpdate = Effect.fnUntraced(function* () {
            for (;;) {
              const event = yield* Queue.take(seen);
              if (event.type === "provider_thread.updated") return event;
            }
          });
          yield* runtime.readThreadSnapshot({ providerThread });
          const hasPending = runtime.hasPendingBackgroundWork ?? Effect.succeed(false);
          // Signals are already applied once readThreadSnapshot returns.
          assert.isTrue(yield* hasPending);
          // Each control patch republishes provider_thread.updated — the apply
          // milestone. After the clearing emit the live-but-idle session is not
          // pending work.
          yield* awaitProviderThreadUpdate();
          yield* awaitProviderThreadUpdate();
          assert.isFalse(yield* hasPending);
          const st = yield* Ref.get(driver.state);
          assert.isNull(st.failure, JSON.stringify(st.failure));
          assert.equal(st.cursor, transcript.entries.length);
        }),
    );

    it.effect("subscribes workspace-config after the first session and publishes its catalog", () =>
      Effect.gen(function* () {
        const gotConfig = yield* Deferred.make<{
          workspaceId: string;
          state: { slashCommands: ReadonlyArray<{ name: string }> };
        }>();
        const transcript = {
          provider: "zcode",
          protocol: "zcode.app-server-v4",
          version: "1",
          scenario: "p6 workspace catalog",
          entries: [
            ...seededSessionEntries("t3-ps6"),
            {
              type: "expect_outbound" as const,
              frame: {
                id: 3,
                method: "v4/conversation/subscribe",
                params: {
                  topic: "workspace-config//tmp/ws",
                  connectionId: "t3-ps6",
                  clientMode: "desktop-continuous",
                },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: {
                id: 3,
                result: {
                  ack: { subscriptionId: "wcs1", mode: "snapshot", logEpoch: "e1" },
                },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: wireFrame(
                1,
                {
                  kind: "snapshot",
                  snapshot: {
                    protocolVersion: 1,
                    workspaceId: "/tmp/ws",
                    logEpoch: "e1",
                    config: {
                      configOptions: [
                        {
                          id: "mode",
                          name: "Mode",
                          type: "select",
                          currentValue: "build",
                        },
                      ],
                      slashCommands: [{ name: "review", description: "Review changes" }],
                    },
                  },
                },
                "initial",
                "workspace-config//tmp/ws",
                "wcs1",
              ),
            },
          ],
        } satisfies ZCodeReplay.ZCodeAppServerReplayTranscript;
        const driver = yield* ZCodeReplay.makeReplayDriver(transcript);
        const adapter = yield* makeZcodeAdapterV2({
          instanceId: "zcode-test" as never,
          settings: { binaryPath: "zcode", enabled: true, customModels: [] } as never,
          environment: { ZCODE_HOME: "/nonexistent-zcode-home" },
          openClient: makeReplayOpenClient(driver),
          onWorkspaceConfig: (workspaceId, state) =>
            Deferred.succeed(gotConfig, { workspaceId, state }).pipe(Effect.asVoid),
        });
        const runtime = yield* adapter
          .openSession({ ...sessionOpenInput, providerSessionId: "ps6" as never })
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
        yield* runtime.ensureThread(sessionOpenInput);
        const pushed = yield* Deferred.await(gotConfig);
        assert.equal(pushed.workspaceId, "/tmp/ws");
        assert.equal(pushed.state.slashCommands[0]?.name, "review");
        const st = yield* Ref.get(driver.state);
        assert.isNull(st.failure, JSON.stringify(st.failure));
        assert.equal(st.cursor, transcript.entries.length);
      }),
    );
  },
);
