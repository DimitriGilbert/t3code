/**
 * ZCode's orchestration-v2 adapter: `ProviderAdapterV2` over
 * `zcode app-server --stdio` (Protocol v4). One process per provider session;
 * conversations multiplex via `conversation/<sessionId>` subscriptions.
 *
 * @module provider-zcode/server/adapter
 */
import {
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderApprovalOption,
  PositiveInt,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderTurnId,
  type ThreadId,
} from "@t3tools/contracts";
import * as ZCodeError from "@t3tools/effect-zcode-protocol/errors";
import * as ZCodeRpc from "@t3tools/effect-zcode-protocol/rpc";
import * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";
import * as ZCodeWire from "@t3tools/effect-zcode-protocol/wire";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ZcodeSettings } from "../settings.ts";
import { ZCODE_PROVIDER } from "./driverKind.ts";
import {
  buildZcodeAppServerSpawnInput,
  openZcodeAppServerClient,
  type ZcodeAppServerClientOpener,
} from "./zcodeAppServer.ts";
import {
  buildZcodeAccountOverlay,
  readZcodeCredentialStore,
  resolveZcodeRequestApiKey,
} from "./zcodeCredentials.ts";
import {
  zcodeNativeItemId,
  zcodePermissionAnswer,
  zcodeProviderTurnStatus,
  zcodeResolveModelSelection,
  zcodeRequestKindForTool,
  zcodeSessionModeForRuntimeMode,
  zcodeTimelineMarkerText,
  zcodeToolCallItemStatus,
  zcodeToolCommandText,
  zcodeToolFilePath,
  zcodeToolItemKind,
  zcodeToolOutputText,
  zcodeTurnItemStatusForText,
} from "./zcodeRows.ts";

const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZcodeSettings)({});
const ZCODE_CLIENT_MODE = "desktop-continuous" as const;
const INTERRUPT_GRACE = Duration.seconds(15);
const ASSISTANT_FLUSH_MS = 50;

export const ZcodeProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "native" },
} satisfies OrchestrationV2ProviderCapabilities;

function protocolError(
  detail: string,
  payload?: unknown,
): ProviderAdapter.ProviderAdapterProtocolError {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: ZCODE_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const isRuntimeRequestResponseError = Schema.is(
  ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);
const isOpenSessionError = Schema.is(ProviderAdapter.ProviderAdapterOpenSessionError);

interface ActiveZcodeTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly nativeTurnId: string;
  readonly providerTurnId: ProviderTurnId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnOrdinal: number;
  readonly projectionThreadId: ThreadId;
  readonly projectionRunId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"];
  readonly rootNodeId: NodeId;
  readonly startedAt: DateTime.Utc;
  readonly settled: Deferred.Deferred<void>;
  itemPositions: Map<string, number>;
  nextOrdinal: number;
  terminalEmitted: boolean;
  interrupted: boolean;
}

interface PendingInteractionRecord {
  readonly requestId: OrchestrationV2RuntimeRequest["id"];
  readonly interaction: ZCodeSchema.PendingInteraction;
}

interface ZcodeConversation {
  readonly sessionId: string;
  readonly topic: string;
  readonly providerThread: OrchestrationV2ProviderThread;
  subscriptionId: string | null;
  logEpoch: string | null;
  revision: number;
  rows: Map<number, ZCodeSchema.ConversationRow>;
  control: ZCodeSchema.SessionControl | null;
  config: ZCodeSchema.SessionConfigState | null;
  usage: ZCodeSchema.SessionUsageState | null;
  rowsTotalCount: number;
  rowsFirstRowId: number | null;
  pendingInteractions: ReadonlyArray<ZCodeSchema.PendingInteraction>;
  backgroundWorks: ReadonlyArray<ZCodeSchema.BackgroundWorkSummary>;
  readonly firstSnapshot: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterV2Error>;
  readonly turns: Map<string, ActiveZcodeTurn>;
  readonly pendingInputs: Map<string, ProviderAdapter.ProviderAdapterV2TurnInput>;
  readonly pendingRows: Map<string, Array<ZCodeSchema.ConversationRow>>;
  readonly interactions: Map<string, PendingInteractionRecord>;
  // turnHeader(failed) can arrive before the state.updated patch carrying
  // control.lastError; failure finalization is deferred to end of frame.
  readonly deferredFailures: Array<{ turn: ActiveZcodeTurn; completedAt: DateTime.Utc }>;
}

const conversationRef = (sessionId: string) => ({
  driver: ZCODE_PROVIDER,
  nativeId: sessionId,
  strength: "strong" as const,
});

const rowStatusToNodeStatus = (
  status: OrchestrationV2TurnItem["status"],
): OrchestrationV2ExecutionNode["status"] => (status === "waiting" ? "waiting" : status);

export interface ZcodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ZcodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  /** Test seam: replaces the spawned `zcode app-server --stdio` process. */
  readonly openClient?: ZcodeAppServerClientOpener;
}

export const makeZcodeAdapterV2 = Effect.fn("makeZcodeAdapterV2")(function* (
  adapterOptions: ZcodeAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = adapterOptions.settings;

  const openClient: ZcodeAppServerClientOpener =
    adapterOptions.openClient ?? openZcodeAppServerClient;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: ZCODE_PROVIDER,
    getCapabilities: Effect.fn("ProviderAdapter.ProviderAdapterV2.getCapabilities")(() =>
      Effect.succeed(ZcodeProviderCapabilitiesV2),
    ),
    planSelectionTransition: Effect.fn("ProviderAdapter.ProviderAdapterV2.planSelectionTransition")(
      () => Effect.succeed(turnScopedSelectionTransition()),
    ),
    openSession: Effect.fn("ZcodeAdapterV2.openSession")(
      function* (input) {
        const scope = yield* Scope.Scope;
        const hostCwd = yield* HostProcess.WorkingDirectory;
        const workspaceId = input.runtimePolicy.cwd ?? hostCwd;
        const spawnInput = buildZcodeAppServerSpawnInput(
          settings,
          workspaceId,
          adapterOptions.environment,
        );
        const client = yield* openClient({
          command: spawnInput.command,
          args: spawnInput.args,
          cwd: spawnInput.cwd,
          env: spawnInput.env,
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const clientId = `t3-${input.providerSessionId}`;

        // The CLI asks for runtime preferences on createSession and again on
        // each sendText; both scopes answer with T3's fixed defaults.
        yield* client.handleServerRequest(
          ZCodeRpc.SERVER_REQUEST_METHODS.sessionRequestRuntimePreferences,
          () =>
            Effect.succeed({
              nativeSearchEnhancementsEnabled: false,
              memoryEnabled: false,
              askUserQuestionAutoResolutionEnabled: true,
              modelContextBudgetStrategy: "preflight-v1" as const,
            }),
        );
        // Per model request the CLI needs account auth material; the host
        // decrypts ~/.zcode credentials locally (never logged).
        yield* client.handleServerRequest(
          ZCodeRpc.SERVER_REQUEST_METHODS.interactionRequestProviderRuntimeHeaders,
          (params) =>
            readZcodeCredentialStore(adapterOptions.environment).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.map((credentials) => {
                const apiKey = resolveZcodeRequestApiKey(credentials, params.providerId);
                return apiKey === undefined
                  ? {
                      headersApplied: false as const,
                      errorMessage: `No ZCode credential for provider ${params.providerId}.`,
                    }
                  : { headersApplied: true as const, requestAuth: { apiKey } };
              }),
            ),
        );

        // Without the account overlay the registry publishes zero executable
        // models and every sendText fails modelUnavailable. Push once per
        // process; requests self-gate on storage-ready.
        yield* buildZcodeAccountOverlay({
          environment: adapterOptions.environment,
          revision: `t3-${input.providerSessionId}`,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.flatMap((overlay) =>
            overlay === undefined
              ? Effect.logWarning(
                  "ZCode builtin provider config not found; account overlay skipped.",
                )
              : client.request(ZCodeRpc.LEGACY_METHODS.providerUpdateAccountConfig, overlay).pipe(
                  Effect.andThen(
                    client.request(ZCodeRpc.LEGACY_METHODS.providerRefreshRegistry, {
                      reason: "t3-session-open",
                    }),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("ZCode account overlay push failed", { cause }),
                  ),
                ),
          ),
        );
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: ZCODE_PROVIDER,
          providerInstanceId: adapterOptions.instanceId,
          status: "ready",
          cwd: workspaceId,
          model: input.modelSelection.model,
          capabilities: ZcodeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        const conversations = new Map<string, ZcodeConversation>();
        const wire = new ZCodeWire.TopicWireFrameAssembler<unknown>(Schema.Unknown);

        const sendCommand = Effect.fn("ZcodeAdapterV2.sendCommand")(function* <
          T extends ZCodeSchema.CommandType,
        >(input: {
          readonly sessionId: string | null;
          readonly type: T;
          readonly payload: ZCodeSchema.CommandPayloadFor<T>;
        }): Effect.fn.Return<
          {
            readonly ack: ZCodeSchema.CommandAck;
            readonly envelope: ZCodeSchema.CommandEnvelopeFor<T>;
          },
          ZCodeError.ZCodeAppServerError | Schema.SchemaError
        > {
          const conversation =
            input.sessionId === null ? undefined : conversations.get(input.sessionId);
          const envelope = ZCodeSchema.makeCommandEnvelope({
            commandId: yield* Effect.orDie(crypto.randomUUIDv7()),
            clientId,
            sessionId: input.sessionId,
            ...(conversation !== undefined &&
            ZCodeSchema.COMMANDS_REQUIRING_BASE_REVISION.has(input.type)
              ? { baseRevision: conversation.revision }
              : {}),
            ...(conversation?.logEpoch != null && ZCodeSchema.ROW_TARGETING_COMMANDS.has(input.type)
              ? { baseLogEpoch: conversation.logEpoch }
              : {}),
            issuedAt: DateTime.toEpochMillis(yield* DateTime.now),
            type: input.type,
            payload: input.payload,
          } as ZCodeSchema.CommandEnvelopeFor<T>);
          const ack = yield* client.request(
            ZCodeRpc.V4_METHODS.command,
            envelope as ZCodeSchema.CommandEnvelope,
          );
          return { ack, envelope };
        });

        const itemOrdinal = (turn: ActiveZcodeTurn, nativeItemId: string) => {
          const existing = turn.itemPositions.get(nativeItemId);
          if (existing !== undefined) return existing;
          const ordinal = turn.nextOrdinal++;
          turn.itemPositions.set(nativeItemId, ordinal);
          return ordinal;
        };

        const nodeFor = (
          turn: ActiveZcodeTurn,
          row: ZCodeSchema.ConversationRow,
          kind: OrchestrationV2ExecutionNode["kind"],
          status: OrchestrationV2ExecutionNode["status"],
          completedAt: DateTime.Utc | null,
        ): OrchestrationV2ExecutionNode => ({
          id: idAllocator.derive.nodeFromProviderItem({
            driver: ZCODE_PROVIDER,
            nativeItemId: zcodeNativeItemId(row.turnId, row.rowId),
          }),
          threadId: turn.projectionThreadId,
          runId: turn.projectionRunId,
          parentNodeId: turn.rootNodeId,
          rootNodeId: turn.rootNodeId,
          kind,
          status,
          countsForRun: false,
          providerThreadId: turn.providerThread.id,
          providerTurnId: turn.providerTurnId,
          nativeItemRef: conversationRef(zcodeNativeItemId(row.turnId, row.rowId)),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: turn.startedAt,
          completedAt,
        });

        const flushTextRow = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          row: ZCodeSchema.AssistantTextRow | ZCodeSchema.ReasoningRow,
        ) {
          const turn = conversation.turns.get(row.turnId);
          if (turn === undefined) return;
          const status = zcodeTurnItemStatusForText(row.state);
          const completed = status !== "running";
          const at = yield* DateTime.now;
          const nativeItemId = zcodeNativeItemId(row.turnId, row.rowId);
          const node = nodeFor(
            turn,
            row,
            row.kind === "reasoning" ? "reasoning" : "assistant_message",
            rowStatusToNodeStatus(status),
            completed ? at : null,
          );
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: ZCODE_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: ZCODE_PROVIDER,
            nativeItemId,
          });
          yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
          if (row.kind === "assistantText") {
            const message: OrchestrationV2ConversationMessage = {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: turn.projectionThreadId,
              runId: turn.projectionRunId,
              nodeId: node.id,
              role: "assistant",
              text: row.text,
              attachments: [],
              streaming: !completed,
              createdAt: turn.startedAt,
              updatedAt: at,
            };
            yield* emit({ type: "message.updated", driver: ZCODE_PROVIDER, message });
          }
          const turnItem: OrchestrationV2TurnItem =
            row.kind === "reasoning"
              ? {
                  id: turnItemId,
                  threadId: turn.projectionThreadId,
                  runId: turn.projectionRunId,
                  nodeId: node.id,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  nativeItemRef: node.nativeItemRef,
                  parentItemId: null,
                  ordinal: itemOrdinal(turn, nativeItemId),
                  status,
                  title: null,
                  startedAt: turn.startedAt,
                  completedAt: completed ? at : null,
                  updatedAt: at,
                  type: "reasoning",
                  text: row.text,
                  streaming: !completed,
                }
              : {
                  id: turnItemId,
                  threadId: turn.projectionThreadId,
                  runId: turn.projectionRunId,
                  nodeId: node.id,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  nativeItemRef: node.nativeItemRef,
                  parentItemId: null,
                  ordinal: itemOrdinal(turn, nativeItemId),
                  status,
                  title: null,
                  startedAt: turn.startedAt,
                  completedAt: completed ? at : null,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId,
                  text: row.text,
                  streaming: !completed,
                };
          yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
        });

        // Buffered text flushes: row.delta mutates the model immediately;
        // turn_item.updated republishes on the codex cadence.
        const textFlushScheduled = new Set<string>();
        const scheduleTextFlush = (
          conversation: ZcodeConversation,
          rowId: number,
        ): Effect.Effect<void> => {
          const key = `${conversation.sessionId}:${rowId}`;
          if (textFlushScheduled.has(key)) return Effect.void;
          textFlushScheduled.add(key);
          return Effect.sleep(Duration.millis(ASSISTANT_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                textFlushScheduled.delete(key);
                const row = conversation.rows.get(rowId);
                if (row?.kind === "assistantText" || row?.kind === "reasoning") {
                  yield* flushTextRow(conversation, row);
                }
              }),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          );
        };

        const emitProviderTurn = Effect.fnUntraced(function* (
          turn: ActiveZcodeTurn,
          status: OrchestrationV2ProviderTurn["status"],
          completedAt: DateTime.Utc | null,
        ) {
          yield* emit({
            type: "provider_turn.updated",
            driver: ZCODE_PROVIDER,
            threadId: turn.projectionThreadId,
            providerTurn: {
              id: turn.providerTurnId,
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.input.attemptId,
              nativeTurnRef: {
                driver: ZCODE_PROVIDER,
                nativeId: turn.nativeTurnId,
                strength: "strong",
              },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt: turn.startedAt,
              completedAt,
            },
          });
        });

        const finalizeInterruptedTurn = Effect.fn("ZcodeAdapterV2.finalizeInterruptedTurn")(
          function* (conversation: ZcodeConversation, turn: ActiveZcodeTurn) {
            const at = yield* DateTime.now;
            yield* finalizeTurn(conversation, turn, "interrupted", at);
          },
        );

        const finalizeTurn = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          turn: ActiveZcodeTurn,
          status: "completed" | "interrupted" | "failed",
          completedAt: DateTime.Utc,
          failureDetail?: string,
        ) {
          if (turn.terminalEmitted) return;
          turn.terminalEmitted = true;
          for (const row of conversation.rows.values()) {
            if (
              row.turnId === turn.nativeTurnId &&
              (row.kind === "assistantText" || row.kind === "reasoning")
            ) {
              yield* flushTextRow(conversation, row);
            }
          }
          yield* emitProviderTurn(turn, status, completedAt);
          if (status === "failed") {
            yield* emit({
              type: "turn.terminal",
              driver: ZCODE_PROVIDER,
              providerThreadId: turn.providerThread.id,
              providerTurnId: turn.providerTurnId,
              runOrdinal: turn.input.runOrdinal,
              failureItemOrdinal: itemOrdinal(turn, `terminal-failure:${turn.providerTurnId}`),
              status: "failed",
              failure: makeProviderFailure({
                message: failureDetail ?? "ZCode turn failed.",
                class: "provider_error",
              }),
              threadDisposition: "reusable",
            });
          } else {
            yield* emit({
              type: "turn.terminal",
              driver: ZCODE_PROVIDER,
              providerThreadId: turn.providerThread.id,
              providerTurnId: turn.providerTurnId,
              runOrdinal: turn.input.runOrdinal,
              status: turn.interrupted ? "interrupted" : status,
              failure: null,
              threadDisposition: "reusable",
            });
          }
          yield* Deferred.succeed(turn.settled, undefined);
        });

        const adoptTurn = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          nativeTurnId: string,
          startedAt: DateTime.Utc,
        ) {
          const existing = conversation.turns.get(nativeTurnId);
          if (existing !== undefined) return existing;
          const turn: ActiveZcodeTurn = {
            input: turnInput,
            nativeTurnId,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ZCODE_PROVIDER,
              nativeTurnId,
            }),
            providerThread: turnInput.providerThread,
            providerTurnOrdinal: turnInput.providerTurnOrdinal,
            projectionThreadId: turnInput.threadId,
            projectionRunId: turnInput.runId,
            rootNodeId: turnInput.rootNodeId,
            startedAt,
            settled: yield* Deferred.make<void>(),
            itemPositions: new Map(),
            nextOrdinal: 0,
            terminalEmitted: false,
            interrupted: false,
          };
          conversation.turns.set(nativeTurnId, turn);
          yield* emitProviderTurn(turn, "running", null);
          const queued = conversation.pendingRows.get(nativeTurnId) ?? [];
          conversation.pendingRows.delete(nativeTurnId);
          for (const row of queued) yield* projectRow(conversation, row);
          return turn;
        });

        const queuePendingRow = (
          conversation: ZcodeConversation,
          row: ZCodeSchema.ConversationRow,
        ) => {
          // Bounded: rows for a turnId that never gets adopted must not grow
          // without limit across a long-lived subscription.
          if (!conversation.pendingRows.has(row.turnId) && conversation.pendingRows.size >= 64) {
            const oldest = conversation.pendingRows.keys().next().value;
            if (oldest !== undefined) conversation.pendingRows.delete(oldest);
          }
          const pending = conversation.pendingRows.get(row.turnId) ?? [];
          if (pending.length === 0) conversation.pendingRows.set(row.turnId, pending);
          pending.push(row);
        };

        const applyToolCallRow = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          row: ZCodeSchema.ToolCallRow,
        ) {
          const turn = conversation.turns.get(row.turnId);
          if (turn === undefined) {
            queuePendingRow(conversation, row);
            return;
          }
          const at = yield* DateTime.now;
          const status = zcodeToolCallItemStatus(row.status);
          const completed = status !== "running" && status !== "waiting";
          const itemKind = zcodeToolItemKind(row.toolName);
          const node = nodeFor(
            turn,
            row,
            "tool_call",
            rowStatusToNodeStatus(status),
            completed ? at : null,
          );
          const nativeItemId = zcodeNativeItemId(row.turnId, row.rowId);
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: ZCODE_PROVIDER,
            nativeItemId,
          });
          const base = {
            id: turnItemId,
            threadId: turn.projectionThreadId,
            runId: turn.projectionRunId,
            nodeId: node.id,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurnId,
            nativeItemRef: node.nativeItemRef,
            parentItemId: null,
            ordinal: itemOrdinal(turn, nativeItemId),
            status,
            title: row.toolName,
            startedAt: turn.startedAt,
            completedAt: completed ? at : null,
            updatedAt: at,
          } as const;
          const turnItem: OrchestrationV2TurnItem =
            itemKind === "command_execution"
              ? {
                  ...base,
                  type: "command_execution",
                  input: zcodeToolCommandText(row),
                  ...(zcodeToolOutputText(row) === undefined
                    ? {}
                    : { output: zcodeToolOutputText(row) }),
                  ...(row.error === undefined ? {} : { outputIndicatesFailure: true }),
                }
              : itemKind === "file_change"
                ? {
                    ...base,
                    type: "file_change",
                    fileName: zcodeToolFilePath(row),
                  }
                : {
                    ...base,
                    type: "dynamic_tool",
                    toolName: row.toolName,
                    input: row.input ?? row.inputText,
                    ...(row.output === undefined ? {} : { output: row.output }),
                  };
          yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
          yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
        });

        const emitSystemNotice = Effect.fnUntraced(function* (
          turn: ActiveZcodeTurn,
          row: ZCodeSchema.ConversationRow,
          text: string,
        ) {
          const at = yield* DateTime.now;
          const nativeItemId = zcodeNativeItemId(row.turnId, row.rowId);
          const node = nodeFor(turn, row, "system", "completed", at);
          const turnItem: OrchestrationV2TurnItem = {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: ZCODE_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.projectionThreadId,
            runId: turn.projectionRunId,
            nodeId: node.id,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurnId,
            nativeItemRef: node.nativeItemRef,
            parentItemId: null,
            ordinal: itemOrdinal(turn, nativeItemId),
            status: "completed",
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type: "system_notice",
            message: text,
          };
          yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
          yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
        });

        const projectSubagentRow = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          row: ZCodeSchema.SubagentRow,
        ) {
          const turn = conversation.turns.get(row.turnId);
          if (turn === undefined) {
            queuePendingRow(conversation, row);
            return;
          }
          const at = yield* DateTime.now;
          const nativeItemId = zcodeNativeItemId(row.turnId, row.rowId);
          const subagentNodeId = idAllocator.derive.nodeFromProviderItem({
            driver: ZCODE_PROVIDER,
            nativeItemId,
          });
          const status =
            row.status === "running"
              ? "running"
              : row.status === "success"
                ? "completed"
                : row.status === "failed"
                  ? "failed"
                  : "cancelled";
          const completed = status !== "running";
          const childThreadId =
            row.childSessionId === undefined
              ? null
              : idAllocator.derive.threadFromProviderThread({
                  driver: ZCODE_PROVIDER,
                  nativeThreadId: row.childSessionId,
                  providerInstanceId: adapterOptions.instanceId,
                });
          const subagent: OrchestrationV2Subagent = {
            id: subagentNodeId,
            threadId: turn.projectionThreadId,
            runId: turn.projectionRunId,
            parentNodeId: turn.rootNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: ZCODE_PROVIDER,
            providerInstanceId: adapterOptions.instanceId,
            providerThreadId: turn.providerThread.id,
            childThreadId,
            nativeTaskRef: conversationRef(nativeItemId),
            prompt: "",
            title: row.subagentType,
            model: null,
            status,
            result: row.summaryText.length > 0 ? row.summaryText : null,
            startedAt: turn.startedAt,
            completedAt: completed ? at : null,
            updatedAt: at,
          };
          yield* emit({ type: "subagent.updated", driver: ZCODE_PROVIDER, subagent });
          const node = nodeFor(
            turn,
            row,
            "subagent",
            rowStatusToNodeStatus(status),
            completed ? at : null,
          );
          const turnItem: OrchestrationV2TurnItem = {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: ZCODE_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.projectionThreadId,
            runId: turn.projectionRunId,
            nodeId: node.id,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurnId,
            nativeItemRef: node.nativeItemRef,
            parentItemId: null,
            ordinal: itemOrdinal(turn, nativeItemId),
            status,
            title: row.subagentType,
            startedAt: turn.startedAt,
            completedAt: completed ? at : null,
            updatedAt: at,
            type: "subagent",
            subagentId: subagentNodeId,
            origin: "provider_native",
            driver: ZCODE_PROVIDER,
            providerInstanceId: adapterOptions.instanceId,
            childThreadId,
            prompt: "",
            result: row.summaryText.length > 0 ? row.summaryText : null,
          };
          yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
          yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
        });

        const projectRow = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          row: ZCodeSchema.ConversationRow,
        ): Effect.fn.Return<void> {
          if (row.kind === "turnHeader") {
            const status = zcodeProviderTurnStatus(row.state);
            const sourceCommandId = row.sourceCommandId;
            const pending =
              sourceCommandId === undefined || sourceCommandId === null
                ? undefined
                : conversation.pendingInputs.get(sourceCommandId);
            let turn = conversation.turns.get(row.turnId);
            if (turn === undefined && pending !== undefined && sourceCommandId != null) {
              conversation.pendingInputs.delete(sourceCommandId);
              turn = yield* adoptTurn(
                conversation,
                pending,
                row.turnId,
                DateTime.makeUnsafe(row.startedAt),
              );
            }
            if (turn === undefined) return;
            if (status === "running") {
              yield* emitProviderTurn(turn, "running", null);
              return;
            }
            const completedAt = DateTime.makeUnsafe(row.endedAt ?? row.startedAt);
            // control.lastError lands in a state.updated patch that can follow
            // the failed turnHeader in the same frame; defer so the failure
            // text is read after the whole payload applied.
            if (status === "failed") {
              conversation.deferredFailures.push({ turn, completedAt });
              return;
            }
            yield* finalizeTurn(conversation, turn, status, completedAt);
            return;
          }

          if (row.kind === "assistantText" || row.kind === "reasoning") {
            yield* flushTextRow(conversation, row);
            return;
          }
          if (row.kind === "toolCall") {
            yield* applyToolCallRow(conversation, row);
            return;
          }
          if (row.kind === "subagent") {
            yield* projectSubagentRow(conversation, row);
            return;
          }

          const turn = conversation.turns.get(row.turnId);
          if (row.kind === "userInput") {
            // T3-owned inputs already live in the transcript; foreign-origin
            // inputs (background results, goals, mailbox) project as notices.
            const ours =
              row.clientId === clientId ||
              (row.sourceCommandId !== undefined &&
                conversation.pendingInputs.has(row.sourceCommandId));
            if (ours || turn === undefined) return;
            yield* emitSystemNotice(turn, row, row.text);
            return;
          }
          if (row.kind === "timelineMarker") {
            if (turn === undefined || row.marker.type === "compact") {
              if (turn === undefined) return;
            }
            if (row.marker.type === "compact") {
              const at = yield* DateTime.now;
              const nativeItemId = zcodeNativeItemId(row.turnId, row.rowId);
              const status =
                row.marker.status === "running"
                  ? ("running" as const)
                  : row.marker.status === "failed" || row.marker.status === "cancelled"
                    ? ("failed" as const)
                    : ("completed" as const);
              const node = nodeFor(
                turn,
                row,
                "system",
                status === "running" ? "running" : status === "completed" ? "completed" : "failed",
                status === "running" ? null : at,
              );
              const turnItem: OrchestrationV2TurnItem = {
                id: idAllocator.derive.turnItemFromProviderItem({
                  driver: ZCODE_PROVIDER,
                  nativeItemId,
                }),
                threadId: turn.projectionThreadId,
                runId: turn.projectionRunId,
                nodeId: node.id,
                providerThreadId: turn.providerThread.id,
                providerTurnId: turn.providerTurnId,
                nativeItemRef: node.nativeItemRef,
                parentItemId: null,
                ordinal: itemOrdinal(turn, nativeItemId),
                status,
                title: "Compaction",
                startedAt: turn.startedAt,
                completedAt: status === "running" ? null : at,
                updatedAt: at,
                type: "compaction",
                driver: ZCODE_PROVIDER,
                ...(row.marker.tokensBefore === undefined
                  ? {}
                  : { beforeTokenCount: row.marker.tokensBefore }),
                ...(row.marker.tokensAfter === undefined
                  ? {}
                  : { afterTokenCount: row.marker.tokensAfter }),
              };
              yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
              yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
              return;
            }
            yield* emitSystemNotice(turn, row, zcodeTimelineMarkerText(row.marker));
            return;
          }
          if (row.kind === "hookInvocation") {
            if (turn === undefined) return;
            const at = yield* DateTime.now;
            const nativeItemId = zcodeNativeItemId(row.turnId, row.rowId);
            const status =
              row.state === "running" ? "running" : row.state === "failed" ? "failed" : "completed";
            const node = nodeFor(turn, row, "hook", status, status === "running" ? null : at);
            const turnItem: OrchestrationV2TurnItem = {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: ZCODE_PROVIDER,
                nativeItemId,
              }),
              threadId: turn.projectionThreadId,
              runId: turn.projectionRunId,
              nodeId: node.id,
              providerThreadId: turn.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: node.nativeItemRef,
              parentItemId: null,
              ordinal: itemOrdinal(turn, nativeItemId),
              status,
              title: `Hook ${row.hookEventName}`,
              startedAt: turn.startedAt,
              completedAt: status === "running" ? null : at,
              updatedAt: at,
              type: "dynamic_tool",
              toolName: `hook:${row.hookEventName}`,
              input: { executions: row.executions.length },
            };
            yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
            yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
            return;
          }
          if (row.kind === "artifact" && turn !== undefined) {
            yield* emitSystemNotice(turn, row, `Created artifact ${row.displayName}.`);
          }
        });

        const syncInteractions = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          next: ReadonlyArray<ZCodeSchema.PendingInteraction>,
        ): Effect.fn.Return<void, IdAllocator.IdAllocatorV2AllocationError> {
          const previous = new Set(conversation.interactions.keys());
          conversation.pendingInteractions = next;
          for (const interaction of next) {
            previous.delete(interaction.interactionId);
            if (conversation.interactions.has(interaction.interactionId)) continue;
            // P4 demux point: permission/userInput/hookReview requests become
            // T3 runtime requests resolved via resolveInteraction.
            const anchorTurn =
              interaction.anchorRowId === null
                ? undefined
                : (conversation.rows.get(interaction.anchorRowId)?.turnId ?? undefined);
            const turn =
              anchorTurn === undefined
                ? [...conversation.turns.values()].at(-1)
                : conversation.turns.get(anchorTurn);
            if (turn === undefined) continue;
            const requestId = yield* idAllocator.allocate.runtimeRequest({
              driver: ZCODE_PROVIDER,
              providerTurnId: turn.providerTurnId,
              nativeRequestId: interaction.interactionId,
            });
            const nodeId = idAllocator.derive.approvalNode({ requestId });
            const providerSessionId = turn.providerThread.providerSessionId;
            if (providerSessionId === null) continue;
            const createdAt = yield* DateTime.now;
            const kind =
              interaction.kind === "userInput"
                ? ("user_input" as const)
                : interaction.kind === "permission"
                  ? interaction.payload.kind === "permission"
                    ? zcodeRequestKindForTool(interaction.payload.toolName)
                    : "permission"
                  : ("permission" as ProviderRequestKind);
            const request: OrchestrationV2RuntimeRequest = {
              id: requestId,
              nodeId,
              providerTurnId: turn.providerTurnId,
              nativeRequestRef: {
                driver: ZCODE_PROVIDER,
                nativeId: interaction.interactionId,
                strength: "strong",
              },
              kind,
              status: "pending",
              responseCapability: { type: "live", providerSessionId },
              createdAt,
              resolvedAt: null,
            };
            const nativeItemId = `interaction:${interaction.interactionId}`;
            const ordinal = itemOrdinal(turn, nativeItemId);
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: turn.projectionThreadId,
              runId: turn.projectionRunId,
              parentNodeId: turn.rootNodeId,
              rootNodeId: turn.rootNodeId,
              kind: interaction.kind === "userInput" ? "user_input_request" : "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: turn.providerThread.id,
              providerTurnId: turn.providerTurnId,
              nativeItemRef: conversationRef(nativeItemId),
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: createdAt,
              completedAt: null,
            };
            let turnItem: OrchestrationV2TurnItem;
            if (interaction.kind === "userInput" && interaction.payload.kind === "userInput") {
              const payload = interaction.payload;
              const questions = payload.questions?.map((question, index) => ({
                id: question.header || `question-${index + 1}`,
                header: question.header || `Question ${index + 1}`,
                question: question.question,
                options: question.options.map((option) => ({
                  label: option.label,
                  description: option.description ?? option.label,
                  ...(option.value === undefined ? {} : { value: option.value }),
                  ...(option.preview === undefined ? {} : { preview: option.preview }),
                })),
                ...(question.multiSelect === undefined
                  ? {}
                  : { multiSelect: question.multiSelect }),
              })) ?? [
                {
                  id: "answer",
                  header: payload.toolName ?? "Input",
                  question: payload.prompt,
                  options: (payload.options ?? []).map((option) => ({
                    label: option.label,
                    description: option.label,
                    value: option.optionId,
                  })),
                  allowCustomAnswer: payload.freeText,
                },
              ];
              turnItem = {
                id: idAllocator.derive.approvalTurnItem({ requestId }),
                threadId: turn.projectionThreadId,
                runId: turn.projectionRunId,
                nodeId,
                providerThreadId: turn.providerThread.id,
                providerTurnId: turn.providerTurnId,
                nativeItemRef: node.nativeItemRef,
                parentItemId: null,
                ordinal,
                status: "waiting",
                title: null,
                startedAt: createdAt,
                completedAt: null,
                updatedAt: createdAt,
                type: "user_input_request",
                requestId,
                questions,
              };
            } else {
              const prompt =
                interaction.payload.kind === "permission"
                  ? interaction.payload.summary
                  : interaction.payload.kind === "workspaceHookReview"
                    ? `ZCode asks to trust ${interaction.payload.summary.hookCount} workspace hook(s) from ${interaction.payload.workspaceLabel}.`
                    : "ZCode requests approval.";
              const options: Array<ProviderApprovalOption> | undefined =
                interaction.payload.kind === "permission"
                  ? interaction.payload.options.map((option) => ({
                      decision:
                        option.kind === "allowOnce"
                          ? "accept"
                          : option.kind === "allowAlways"
                            ? "acceptAlways"
                            : option.kind === "deny"
                              ? "decline"
                              : "accept",
                      label: option.label,
                    }))
                  : [
                      { decision: "accept" as const, label: "Allow" },
                      { decision: "decline" as const, label: "Decline" },
                    ];
              turnItem = {
                id: idAllocator.derive.approvalTurnItem({ requestId }),
                threadId: turn.projectionThreadId,
                runId: turn.projectionRunId,
                nodeId,
                providerThreadId: turn.providerThread.id,
                providerTurnId: turn.providerTurnId,
                nativeItemRef: node.nativeItemRef,
                parentItemId: null,
                ordinal,
                status: "waiting",
                title: null,
                startedAt: createdAt,
                completedAt: null,
                updatedAt: createdAt,
                type: "approval_request",
                requestId,
                requestKind: kind === "user_input" ? "permission" : kind,
                prompt,
                options,
              };
            }
            conversation.interactions.set(interaction.interactionId, {
              requestId,
              interaction,
            });
            yield* emit({ type: "node.updated", driver: ZCODE_PROVIDER, node });
            yield* emit({
              type: "runtime_request.updated",
              driver: ZCODE_PROVIDER,
              threadId: turn.projectionThreadId,
              runtimeRequest: request,
            });
            yield* emit({ type: "turn_item.updated", driver: ZCODE_PROVIDER, turnItem });
          }
          // Interactions that left the pending set resolved or expired.
          for (const gone of previous) {
            const record = conversation.interactions.get(gone);
            if (record === undefined) continue;
            conversation.interactions.delete(gone);
            const turn = [...conversation.turns.values()].at(-1);
            yield* emit({
              type: "runtime_request.updated",
              driver: ZCODE_PROVIDER,
              ...(turn === undefined ? {} : { threadId: turn.projectionThreadId }),
              runtimeRequest: {
                id: record.requestId,
                nodeId: idAllocator.derive.approvalNode({ requestId: record.requestId }),
                providerTurnId: turn?.providerTurnId ?? null,
                nativeRequestRef: {
                  driver: ZCODE_PROVIDER,
                  nativeId: record.interaction.interactionId,
                  strength: "strong",
                },
                kind: "permission",
                status: "resolved",
                responseCapability: { type: "not_resumable", reason: "Resolved by the runtime." },
                createdAt: yield* DateTime.now,
                resolvedAt: yield* DateTime.now,
              },
            });
          }
        });

        const emitProviderThread = Effect.fnUntraced(function* (conversation: ZcodeConversation) {
          const control = conversation.control;
          const status: OrchestrationV2ProviderThread["status"] =
            control === null || control.sessionEnded
              ? "idle"
              : control.phase === "error"
                ? "error"
                : control.phase === "running" || control.phase === "prewarming"
                  ? "active"
                  : "idle";
          const usage = conversation.usage;
          const updatedAt = yield* DateTime.now;
          yield* emit({
            type: "provider_thread.updated",
            driver: ZCODE_PROVIDER,
            providerThread: {
              ...conversation.providerThread,
              status,
              updatedAt,
              ...(usage === null
                ? {}
                : {
                    contextUsage: {
                      usedTokens: usage.contextWindow?.usedTokens ?? 0,
                      ...(usage.contextWindow === null
                        ? {}
                        : { maxTokens: usage.contextWindow.maxTokens }),
                      inputTokens: usage.cumulative.inputTokens,
                      outputTokens: usage.cumulative.outputTokens,
                      cachedInputTokens: usage.cumulative.cacheReadTokens,
                    },
                  }),
            },
          });
        });

        const applySnapshot = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          snapshot: ZCodeSchema.ConversationSnapshot,
        ): Effect.fn.Return<void, IdAllocator.IdAllocatorV2AllocationError> {
          conversation.revision = snapshot.revision;
          conversation.logEpoch = snapshot.logEpoch;
          conversation.control = snapshot.control;
          conversation.config = snapshot.config;
          conversation.usage = snapshot.usage;
          conversation.rowsTotalCount = snapshot.rows.totalCount;
          conversation.rowsFirstRowId = snapshot.rows.firstRowId;
          conversation.backgroundWorks = snapshot.backgroundWorks;
          for (const row of snapshot.rows.window) {
            conversation.rows.set(row.rowId, row);
          }
          yield* syncInteractions(conversation, snapshot.pendingInteractions);
          for (const row of snapshot.rows.window) yield* projectRow(conversation, row);
          yield* emitProviderThread(conversation);
          yield* Deferred.succeed(conversation.firstSnapshot, undefined).pipe(Effect.ignore);
        });

        const applyDelta = Effect.fnUntraced(function* (
          conversation: ZcodeConversation,
          delta: ZCodeSchema.ConversationDelta,
        ): Effect.fn.Return<void, IdAllocator.IdAllocatorV2AllocationError> {
          if (delta.op === "row.appended" || delta.op === "row.upserted") {
            conversation.rows.set(delta.row.rowId, delta.row);
            yield* projectRow(conversation, delta.row);
            return;
          }
          if (delta.op === "row.removed") {
            for (const rowId of conversation.rows.keys()) {
              if (rowId >= delta.fromRowId) conversation.rows.delete(rowId);
            }
            return;
          }
          if (delta.op === "row.delta") {
            const row = conversation.rows.get(delta.rowId);
            if (row === undefined) return;
            if (
              delta.path === "text" &&
              (row.kind === "assistantText" || row.kind === "reasoning")
            ) {
              conversation.rows.set(delta.rowId, { ...row, text: row.text + delta.append });
              yield* scheduleTextFlush(conversation, delta.rowId);
            } else if (delta.path === "inputText" && row.kind === "toolCall") {
              conversation.rows.set(delta.rowId, {
                ...row,
                inputText: row.inputText + delta.append,
              });
            } else if (delta.path === "output.text" && row.kind === "toolCall") {
              const output = row.output ?? { text: "" };
              conversation.rows.set(delta.rowId, {
                ...row,
                output: { ...output, text: output.text + delta.append },
              });
              const turn = conversation.turns.get(row.turnId);
              if (turn !== undefined) {
                yield* emit({
                  type: "command_output.delta",
                  driver: ZCODE_PROVIDER,
                  threadId: turn.projectionThreadId,
                  itemId: idAllocator.derive.turnItemFromProviderItem({
                    driver: ZCODE_PROVIDER,
                    nativeItemId: zcodeNativeItemId(row.turnId, row.rowId),
                  }),
                  chunk: delta.append,
                });
              }
            }
            return;
          }
          if (delta.op === "state.updated") {
            const patch = delta.patch;
            if (patch.revision !== undefined) conversation.revision = patch.revision;
            if (patch.control !== undefined) {
              conversation.control = patch.control;
              if (patch.control.sessionEnded) {
                for (const turn of conversation.turns.values()) {
                  if (!turn.terminalEmitted) {
                    const at = yield* DateTime.now;
                    yield* finalizeTurn(conversation, turn, "completed", at);
                  }
                }
              }
            }
            if (patch.config !== undefined) conversation.config = patch.config;
            if (patch.usage !== undefined) conversation.usage = patch.usage;
            if (patch.backgroundWorks !== undefined) {
              conversation.backgroundWorks = patch.backgroundWorks;
            }
            if (patch.control !== undefined || patch.usage !== undefined) {
              yield* emitProviderThread(conversation);
            }
            if (patch.pendingInteractions !== undefined) {
              yield* syncInteractions(conversation, patch.pendingInteractions);
            }
          }
        });

        const routeFrame = Effect.fnUntraced(function* (
          frame: unknown,
          deliveryKind: unknown,
        ): Effect.fn.Return<void, IdAllocator.IdAllocatorV2AllocationError> {
          const topic = (frame as { topic?: unknown }).topic;
          if (typeof topic !== "string") return;
          if (topic.startsWith("conversation/")) {
            const conversation = conversations.get(topic.slice("conversation/".length));
            if (conversation === undefined) return;
            const decoded = yield* Schema.decodeUnknownEffect(conversationFrameCodec)(frame).pipe(
              Effect.option,
            );
            if (Option.isNone(decoded)) {
              yield* Effect.logWarning("ZCode conversation frame failed to decode", {
                sessionId: conversation.sessionId,
                deliveryKind,
              });
              return;
            }
            if (decoded.value.payload.kind === "snapshot") {
              yield* applySnapshot(conversation, decoded.value.payload.snapshot);
            } else {
              for (const delta of decoded.value.payload.deltas) {
                yield* applyDelta(conversation, delta);
              }
            }
            const deferred = conversation.deferredFailures.splice(0);
            for (const { turn, completedAt } of deferred) {
              yield* finalizeTurn(
                conversation,
                turn,
                "failed",
                completedAt,
                ...(conversation.control?.lastError === null ||
                conversation.control?.lastError === undefined
                  ? []
                  : [conversation.control.lastError.message]),
              );
            }
            return;
          }
          // sessions-index + workspace-config frames land here in later phases.
        });

        // DecodingServices is `unknown` for schemas containing Unknown fields;
        // it is a phantom for these decodes (no service is actually required).
        const wireCandidateCodec = ZCodeWire.TopicWireFrameCandidate as unknown as Schema.Codec<
          ZCodeWire.TopicWireFrameCandidate,
          unknown,
          never,
          never
        >;
        const conversationFrameCodec =
          ZCodeSchema.ConversationTopicFrame as unknown as Schema.Codec<
            ZCodeSchema.ConversationTopicFrame,
            unknown,
            never,
            never
          >;
        const decodeWireCandidate = Schema.decodeUnknownEffect(wireCandidateCodec);

        yield* client.handleServerNotification(
          ZCodeRpc.SERVER_NOTIFICATION_METHODS.conversationFrame,
          (params: unknown) =>
            Effect.gen(function* () {
              const candidate = yield* decodeWireCandidate(params).pipe(Effect.option);
              if (Option.isNone(candidate)) return;
              const at = DateTime.toEpochMillis(yield* DateTime.now);
              for (const event of wire.accept(candidate.value, at)) {
                if (event.kind === "fault") {
                  yield* Effect.logWarning("ZCode wire frame assembly fault", {
                    reasonCode: event.fault.reasonCode,
                    topic: event.fault.topic,
                  });
                  continue;
                }
                yield* routeFrame(event.frame, event.deliveryKind);
              }
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("ZCode conversation frame handling failed", { cause }),
              ),
            ),
        );

        // §2.6: unknown reverse requests must never hang the caller.
        yield* client.handleUnknownServerRequest((method: string) =>
          Effect.fail(ZCodeError.ZCodeAppServerRequestError.methodNotFound(method)),
        );

        const ensureConversation = Effect.fn("ZcodeAdapterV2.ensureConversation")(function* (
          sessionId: string,
          providerThread: OrchestrationV2ProviderThread,
        ) {
          const existing = conversations.get(sessionId);
          if (existing !== undefined) return existing;
          const conversation: ZcodeConversation = {
            sessionId,
            topic: ZCodeSchema.conversationTopic(sessionId),
            providerThread,
            subscriptionId: null,
            logEpoch: null,
            revision: 0,
            rows: new Map(),
            control: null,
            config: null,
            usage: null,
            rowsTotalCount: 0,
            rowsFirstRowId: null,
            pendingInteractions: [],
            backgroundWorks: [],
            firstSnapshot: yield* Deferred.make<void, ProviderAdapter.ProviderAdapterV2Error>(),
            turns: new Map(),
            pendingInputs: new Map(),
            pendingRows: new Map(),
            interactions: new Map(),
            deferredFailures: [],
          };
          conversations.set(sessionId, conversation);
          const subscribed = yield* client
            .request(ZCodeRpc.V4_METHODS.conversationSubscribe, {
              topic: conversation.topic,
              connectionId: clientId,
              clientMode: ZCODE_CLIENT_MODE,
            })
            .pipe(
              // A half-initialized entry would wedge every later call path;
              // failed subscribes must leave no conversation behind.
              Effect.tapError(() => Effect.sync(() => conversations.delete(sessionId))),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: ZCODE_PROVIDER,
                    detail: `Failed to subscribe ${conversation.topic}.`,
                    cause,
                  }),
              ),
            );
          conversation.subscriptionId = subscribed.ack.subscriptionId;
          conversation.logEpoch = subscribed.ack.logEpoch;
          return conversation;
        });

        const nativeSessionId = (
          providerThread: OrchestrationV2ProviderThread,
        ): Effect.Effect<string, ProviderAdapter.ProviderAdapterProtocolError> => {
          const nativeId = providerThread.nativeThreadRef?.nativeId;
          return nativeId === undefined || nativeId === null || nativeId === ""
            ? Effect.fail(
                protocolError(`Provider thread ${providerThread.id} has no ZCode session id.`),
              )
            : Effect.succeed(nativeId);
        };

        const zcodeModelSelectionPayload = (
          resolved: ReturnType<typeof zcodeResolveModelSelection>,
        ) =>
          resolved === undefined
            ? {}
            : {
                modelSelection: {
                  providerId: resolved.providerId,
                  modelId: resolved.modelId,
                  options: { reasoningLevel: resolved.reasoningLevel },
                },
              };

        const sendTextCommand = Effect.fn("ZcodeAdapterV2.sendTextCommand")(function* (
          conversation: ZcodeConversation,
          text: string,
          requestedDelivery?: "startNow" | "queue" | "guide",
        ) {
          const { ack } = yield* sendCommand({
            sessionId: conversation.sessionId,
            type: "sendText",
            payload: {
              text,
              ...(requestedDelivery === undefined ? {} : { requestedDelivery }),
            },
          });
          if (ack.status !== "accepted" && ack.status !== "duplicate") {
            return yield* protocolError(
              `ZCode rejected sendText: ${ack.status}${ack.message === undefined ? "" : ` (${ack.message})`}`,
            );
          }
        });

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          driver: ZCODE_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          hasPendingBackgroundWork: Effect.sync(() =>
            [...conversations.values()].some(
              (conversation) =>
                conversation.backgroundWorks.some((work) => work.status === "running") ||
                conversation.control?.sessionEnded === false,
            ),
          ),
          ensureThread: Effect.fn("ZcodeAdapterV2.ensureThread")(function* (threadInput) {
            // No conversation exists yet: resolve the selection against the
            // T3 slug alone; the session snapshot carries it from then on.
            const resolved = zcodeResolveModelSelection({
              model: threadInput.modelSelection.model,
              reasoningEffort: threadInput.runtimePolicy.reasoningEffort,
              config: null,
            });
            const { ack } = yield* sendCommand({
              sessionId: null,
              type: "createSession",
              payload: {
                workspaceId,
                config: {
                  mode: zcodeSessionModeForRuntimeMode(threadInput.runtimePolicy.runtimeMode),
                  ...(threadInput.runtimePolicy.interactionMode === "plan"
                    ? { planEnabled: true }
                    : {}),
                  ...(resolved === undefined
                    ? {}
                    : {
                        provider: resolved.providerId,
                        model: resolved.modelId,
                        thought: resolved.reasoningLevel,
                        ...zcodeModelSelectionPayload(resolved),
                      }),
                },
              },
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: ZCODE_PROVIDER,
                    threadId: threadInput.threadId,
                    cause,
                  }),
              ),
            );
            if (ack.status !== "accepted" && ack.status !== "duplicate") {
              return yield* new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: ZCODE_PROVIDER,
                threadId: threadInput.threadId,
                cause: `ZCode rejected createSession: ${ack.status}`,
              });
            }
            const result = ack.result;
            if (result === undefined || result.type !== "createSession") {
              return yield* new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: ZCODE_PROVIDER,
                threadId: threadInput.threadId,
                cause: "ZCode createSession returned no session id.",
              });
            }
            const sessionId = result.sessionId;
            const createdAt = yield* DateTime.now;
            const providerThread: OrchestrationV2ProviderThread = {
              id: idAllocator.derive.providerThread({
                driver: ZCODE_PROVIDER,
                nativeThreadId: sessionId,
                providerInstanceId: adapterOptions.instanceId,
              }),
              driver: ZCODE_PROVIDER,
              providerInstanceId: adapterOptions.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: conversationRef(sessionId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              contextUsage: null,
              nativeMetadata: null,
              goal: null,
              createdAt,
              updatedAt: createdAt,
            };
            yield* ensureConversation(sessionId, providerThread).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: ZCODE_PROVIDER,
                    threadId: threadInput.threadId,
                    cause,
                  }),
              ),
            );
            return providerThread;
          }),
          resumeThread: Effect.fn("ZcodeAdapterV2.resumeThread")(
            function* (threadInput) {
              const sessionId = yield* nativeSessionId(threadInput.providerThread);
              yield* ensureConversation(sessionId, threadInput.providerThread);
              const updatedAt = yield* DateTime.now;
              return {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                providerInstanceId: adapterOptions.instanceId,
                status: "idle" as const,
                updatedAt,
              };
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: ZCODE_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          startTurn: Effect.fn("ZcodeAdapterV2.startTurn")(
            function* (turnInput) {
              const sessionId = yield* nativeSessionId(turnInput.providerThread);
              const conversation = yield* ensureConversation(sessionId, turnInput.providerThread);
              const commandId = yield* Effect.orDie(crypto.randomUUIDv7());
              if (conversation.pendingInputs.size >= 256) {
                const oldest = conversation.pendingInputs.keys().next().value;
                if (oldest !== undefined) conversation.pendingInputs.delete(oldest);
              }
              conversation.pendingInputs.set(commandId, turnInput);
              // sendText.modelSelection requires options.reasoningLevel — an
              // accepted command without it still fails invalid_model_request.
              const resolved = zcodeResolveModelSelection({
                model: turnInput.modelSelection.model,
                reasoningEffort: turnInput.runtimePolicy.reasoningEffort,
                config: conversation.config,
              });
              const envelope = ZCodeSchema.makeCommandEnvelope({
                commandId,
                clientId,
                sessionId,
                issuedAt: DateTime.toEpochMillis(yield* DateTime.now),
                type: "sendText" as const,
                payload: {
                  text: turnInput.message.text,
                  requestedDelivery: "startNow" as const,
                  ...zcodeModelSelectionPayload(resolved),
                },
              });
              const ack = yield* client.request(ZCodeRpc.V4_METHODS.command, envelope).pipe(
                Effect.onError(() =>
                  Effect.sync(() => {
                    conversation.pendingInputs.delete(commandId);
                  }),
                ),
              );
              if (ack.status !== "accepted" && ack.status !== "duplicate") {
                conversation.pendingInputs.delete(commandId);
                return yield* protocolError(
                  `ZCode rejected sendText: ${ack.status}${ack.message === undefined ? "" : ` (${ack.message})`}`,
                );
              }
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  isProtocolError(cause)
                    ? cause
                    : new ProviderAdapter.ProviderAdapterTurnStartError({
                        driver: ZCODE_PROVIDER,
                        threadId: turnInput.threadId,
                        providerThreadId: turnInput.providerThread.id,
                        runId: turnInput.runId,
                        cause,
                      }),
                ),
              ),
          ),
          steerTurn: Effect.fn("ZcodeAdapterV2.steerTurn")(
            function* (steerInput) {
              const sessionId = yield* nativeSessionId(steerInput.providerThread);
              const conversation = yield* ensureConversation(sessionId, steerInput.providerThread);
              yield* sendTextCommand(conversation, steerInput.message.text, "guide");
            },
            (effect, steerInput) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  isProtocolError(cause)
                    ? cause
                    : new ProviderAdapter.ProviderAdapterSteerRunError({
                        driver: ZCODE_PROVIDER,
                        providerThreadId: steerInput.providerThread.id,
                        providerTurnId: steerInput.providerTurnId,
                        cause,
                      }),
                ),
              ),
          ),
          unloadThread: Effect.fn("ZcodeAdapterV2.unloadThread")(
            function* (unloadInput) {
              const sessionId = yield* nativeSessionId(unloadInput.providerThread);
              const conversation = conversations.get(sessionId);
              if (conversation !== undefined && conversation.subscriptionId !== null) {
                yield* client
                  .request(ZCodeRpc.V4_METHODS.conversationUnsubscribe, {
                    topic: conversation.topic,
                    subscriptionId: conversation.subscriptionId,
                    connectionId: clientId,
                  })
                  .pipe(Effect.ignore);
              }
              conversations.delete(sessionId);
              yield* client
                .request(ZCodeRpc.LEGACY_METHODS.sessionClose, { sessionId })
                .pipe(Effect.ignore);
            },
            (effect, unloadInput) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  isProtocolError(cause)
                    ? cause
                    : new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: ZCODE_PROVIDER,
                        detail: `Failed to unload ZCode thread for provider thread ${unloadInput.providerThread.id}`,
                        cause,
                      }),
                ),
              ),
          ),
          interruptTurn: Effect.fn("ZcodeAdapterV2.interruptTurn")(
            function* (interruptInput) {
              const sessionId = yield* nativeSessionId(interruptInput.providerThread);
              const conversation = conversations.get(sessionId);
              if (conversation === undefined) {
                return yield* protocolError(
                  `ZCode session ${sessionId} is not subscribed on this provider session.`,
                );
              }
              const turn = [...conversation.turns.values()].find(
                (candidate) => candidate.providerTurnId === interruptInput.providerTurnId,
              );
              if (turn === undefined) {
                return yield* protocolError(
                  `Provider turn ${interruptInput.providerTurnId} is not active on ZCode session ${sessionId}.`,
                );
              }
              const { ack } = yield* sendCommand({ sessionId, type: "stop", payload: {} });
              if (ack.status !== "accepted" && ack.status !== "duplicate") {
                return yield* protocolError(
                  `ZCode rejected stop: ${ack.status}${ack.message === undefined ? "" : ` (${ack.message})`}`,
                );
              }
              turn.interrupted = true;
              yield* Deferred.await(turn.settled).pipe(
                Effect.timeoutOrElse({
                  duration: INTERRUPT_GRACE,
                  orElse: () => finalizeInterruptedTurn(conversation, turn),
                }),
              );
            },
            (effect, interruptInput) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  isProtocolError(cause)
                    ? cause
                    : new ProviderAdapter.ProviderAdapterInterruptError({
                        driver: ZCODE_PROVIDER,
                        providerThreadId: interruptInput.providerThread.id,
                        providerTurnId: interruptInput.providerTurnId,
                        cause,
                      }),
                ),
              ),
          ),
          respondToRuntimeRequest: Effect.fn("ZcodeAdapterV2.respondToRuntimeRequest")(
            function* (requestInput) {
              for (const conversation of conversations.values()) {
                for (const [interactionId, record] of conversation.interactions) {
                  if (record.requestId !== requestInput.requestId) continue;
                  const interaction = record.interaction;
                  let answer: ReturnType<typeof zcodePermissionAnswer>;
                  if (interaction.payload.kind === "permission") {
                    if (requestInput.decision === undefined) {
                      return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                        driver: ZCODE_PROVIDER,
                        requestId: requestInput.requestId,
                        cause: "ZCode permission requests require an approval decision.",
                      });
                    }
                    answer = zcodePermissionAnswer({
                      payload: interaction.payload,
                      decision: requestInput.decision,
                      ...(requestInput.feedback === undefined
                        ? {}
                        : { feedback: requestInput.feedback }),
                    });
                  } else if (interaction.payload.kind === "userInput") {
                    if (requestInput.answers === undefined && requestInput.decision === undefined) {
                      return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                        driver: ZCODE_PROVIDER,
                        requestId: requestInput.requestId,
                        cause: "ZCode user-input requests require answers or a decision.",
                      });
                    }
                    answer =
                      requestInput.decision === "cancel" || requestInput.decision === "decline"
                        ? { action: "cancel" as const }
                        : requestInput.answers === undefined
                          ? {}
                          : { content: requestInput.answers };
                  } else {
                    answer =
                      requestInput.decision === "accept" ||
                      requestInput.decision === "acceptAlways" ||
                      requestInput.decision === "acceptForSession"
                        ? { action: "accept" as const }
                        : { action: "decline" as const };
                  }
                  const hookReview =
                    interaction.payload.kind === "workspaceHookReview" && answer.action === "accept"
                      ? interaction.payload
                      : undefined;
                  // Hook trust decisions go through the dedicated review
                  // command; resolveInteraction still serves rejections.
                  const { ack } =
                    hookReview === undefined
                      ? yield* sendCommand({
                          sessionId: conversation.sessionId,
                          type: "resolveInteraction",
                          payload: { interactionId, answer },
                        })
                      : yield* sendCommand({
                          sessionId: conversation.sessionId,
                          type: "respondWorkspaceHookReview",
                          payload: {
                            sessionId: hookReview.sessionId,
                            taskId: hookReview.taskId,
                            runId: hookReview.runId,
                            workspaceIdentity: hookReview.workspaceIdentity,
                            bundleDigest: hookReview.bundleDigest,
                            reviewFlowId: hookReview.reviewFlowId,
                            generation: hookReview.generation,
                            interactionId: hookReview.interactionId,
                            ...(hookReview.remoteSessionId === undefined
                              ? {}
                              : { remoteSessionId: hookReview.remoteSessionId }),
                            decision: {
                              action: "trust_selected" as const,
                              reviewItemIds: hookReview.items.map((item) => item.reviewItemId),
                            },
                          },
                        });
                  if (ack.status !== "accepted" && ack.status !== "duplicate") {
                    return yield* protocolError(
                      `ZCode rejected interaction resolution: ${ack.status}${ack.message === undefined ? "" : ` (${ack.message})`}`,
                    );
                  }
                  conversation.interactions.delete(interactionId);
                  const resolvedAt = yield* DateTime.now;
                  yield* emit({
                    type: "runtime_request.updated",
                    driver: ZCODE_PROVIDER,
                    runtimeRequest: {
                      id: record.requestId,
                      nodeId: idAllocator.derive.approvalNode({
                        requestId: record.requestId,
                      }),
                      providerTurnId: null,
                      nativeRequestRef: {
                        driver: ZCODE_PROVIDER,
                        nativeId: interactionId,
                        strength: "strong",
                      },
                      kind: interaction.kind === "userInput" ? "user_input" : "permission",
                      status: "resolved",
                      responseCapability: {
                        type: "not_resumable",
                        reason: "Resolved.",
                      },
                      createdAt: resolvedAt,
                      resolvedAt,
                    },
                  });
                  return;
                }
              }
              return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: ZCODE_PROVIDER,
                requestId: requestInput.requestId,
                cause: protocolError(`No pending ZCode runtime request ${requestInput.requestId}.`),
              });
            },
            (effect, requestInput) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  isRuntimeRequestResponseError(cause)
                    ? cause
                    : new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                        driver: ZCODE_PROVIDER,
                        requestId: requestInput.requestId,
                        cause,
                      }),
                ),
              ),
          ),
          readThreadSnapshot: Effect.fn("ZcodeAdapterV2.readThreadSnapshot")(
            function* (snapshotInput) {
              const sessionId = yield* nativeSessionId(snapshotInput.providerThread);
              const conversation = yield* ensureConversation(
                sessionId,
                snapshotInput.providerThread,
              );
              const snapshotReady = yield* Deferred.await(conversation.firstSnapshot).pipe(
                Effect.timeoutOption("10 seconds"),
              );
              if (snapshotReady._tag === "None") {
                // Best-effort: project whatever has arrived so far rather than
                // failing the read on a slow cold restore.
                yield* Effect.logWarning(
                  "ZCode conversation snapshot did not arrive within 10s; reading partial rows.",
                  { sessionId },
                );
              }
              // The snapshot only carries the recent rows window; page
              // rowsRange backwards for earlier history.
              const allRows = new Map(conversation.rows);
              let beforeRowId = conversation.rowsFirstRowId ?? undefined;
              while (
                beforeRowId !== undefined &&
                allRows.size < conversation.rowsTotalCount &&
                allRows.size < 10_000
              ) {
                const page = yield* client
                  .request(ZCodeRpc.V4_METHODS.conversationRowsRange, {
                    sessionId,
                    clientMode: ZCODE_CLIENT_MODE,
                    beforeRowId,
                    limit: 500,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("ZCode rowsRange paging failed", { cause, sessionId }).pipe(
                        Effect.as(undefined),
                      ),
                    ),
                  );
                if (page === undefined || page.rows.length === 0) break;
                let oldest = beforeRowId;
                for (const row of page.rows) {
                  allRows.set(row.rowId, row);
                  if (row.rowId < oldest) oldest = row.rowId;
                }
                if (!page.hasMore || oldest >= beforeRowId) break;
                beforeRowId = oldest;
              }
              const projectedRows = [...allRows.values()].sort(
                (left, right) => left.rowId - right.rowId,
              );
              const turns: Array<OrchestrationV2ProviderTurn> = [];
              const messages: Array<OrchestrationV2ConversationMessage> = [];
              const runtimeRequests: Array<OrchestrationV2RuntimeRequest> = [];
              const threadId = snapshotInput.providerThread.appThreadId;
              for (const row of projectedRows) {
                if (row.kind === "turnHeader") {
                  const ordinal = turns.length + 1;
                  turns.push({
                    id: idAllocator.derive.providerTurn({
                      driver: ZCODE_PROVIDER,
                      nativeTurnId: row.turnId,
                    }),
                    providerThreadId: snapshotInput.providerThread.id,
                    nodeId: idAllocator.derive.nodeFromProviderItem({
                      driver: ZCODE_PROVIDER,
                      nativeItemId: `${sessionId}:turn:${row.turnId}`,
                    }),
                    runAttemptId: null,
                    nativeTurnRef: {
                      driver: ZCODE_PROVIDER,
                      nativeId: row.turnId,
                      strength: "strong",
                    },
                    ordinal: PositiveInt.make(ordinal),
                    status: zcodeProviderTurnStatus(row.state),
                    startedAt: DateTime.makeUnsafe(row.startedAt),
                    completedAt:
                      row.endedAt === undefined ? null : DateTime.makeUnsafe(row.endedAt),
                  });
                } else if (
                  threadId !== null &&
                  (row.kind === "userInput" || row.kind === "assistantText")
                ) {
                  const nativeItemId = zcodeNativeItemId(row.turnId, row.rowId);
                  const at = DateTime.makeUnsafe(row.createdAt);
                  messages.push({
                    createdBy: row.kind === "userInput" ? "user" : "agent",
                    creationSource: "provider",
                    id: idAllocator.derive.messageFromProviderItem({
                      driver: ZCODE_PROVIDER,
                      nativeItemId,
                    }),
                    threadId,
                    runId: null,
                    nodeId: idAllocator.derive.nodeFromProviderItem({
                      driver: ZCODE_PROVIDER,
                      nativeItemId,
                    }),
                    role: row.kind === "userInput" ? "user" : "assistant",
                    text: row.text,
                    attachments: [],
                    streaming: row.kind === "assistantText" && row.state === "streaming",
                    createdAt: at,
                    updatedAt: at,
                  });
                }
              }
              for (const record of conversation.interactions.values()) {
                runtimeRequests.push({
                  id: record.requestId,
                  nodeId: idAllocator.derive.approvalNode({ requestId: record.requestId }),
                  providerTurnId: null,
                  nativeRequestRef: {
                    driver: ZCODE_PROVIDER,
                    nativeId: record.interaction.interactionId,
                    strength: "strong",
                  },
                  kind:
                    record.interaction.kind === "userInput"
                      ? "user_input"
                      : record.interaction.payload.kind === "permission"
                        ? zcodeRequestKindForTool(record.interaction.payload.toolName)
                        : "permission",
                  status: "pending",
                  responseCapability: {
                    type: "live",
                    providerSessionId: input.providerSessionId,
                  },
                  createdAt: yield* DateTime.now,
                  resolvedAt: null,
                });
              }
              return {
                providerThread: {
                  ...snapshotInput.providerThread,
                  providerSessionId: input.providerSessionId,
                  nativeThreadRef: conversationRef(sessionId),
                  updatedAt: yield* DateTime.now,
                },
                providerTurns: turns,
                messages,
                runtimeRequests,
              };
            },
            (effect, snapshotInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                      driver: ZCODE_PROVIDER,
                      providerThreadId: snapshotInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          rollbackThread: (_rollbackInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: ZCODE_PROVIDER,
                providerThreadId: _rollbackInput.providerThread.id,
                cause: "ZCode thread rollback is not supported yet.",
              }),
            ),
          forkThread: (_forkInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: ZCODE_PROVIDER,
                providerThreadId: _forkInput.sourceProviderThread.id,
                cause: "ZCode thread forking is not supported yet.",
              }),
            ),
        };
        return runtime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isOpenSessionError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: ZCODE_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
          ),
        ),
    ),
  });
});

export type ZcodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path;

export const ZcodeAdapterV2Driver: ProviderAdapterDriver<ZcodeSettings, ZcodeAdapterV2DriverEnv> = {
  driverKind: ZCODE_PROVIDER,
  configSchema: ZcodeSettings,
  defaultConfig: (): ZcodeSettings => DEFAULT_ZCODE_SETTINGS,
  create: Effect.fn("ZcodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ZcodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      return yield* makeZcodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ZCODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create the ZCode adapter.",
              cause,
            }),
        ),
      ),
  ),
};
