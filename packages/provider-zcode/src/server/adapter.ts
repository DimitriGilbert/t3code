/**
 * ZCode's orchestration-v2 adapter: an `AcpAdapterV2` flavor over the
 * third-party `zcode-acp-server` bridge, plus the `ProviderAdapterDriver` the
 * server registers.
 *
 * @module provider-zcode/server/adapter
 */
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import {
  acpPermissionDisposition,
  unknownRecord,
  type AcpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { ZcodeSettings } from "../settings.ts";
import { ZCODE_PROVIDER } from "./driverKind.ts";
import { applyZcodeAcpModelSelection, makeZcodeAcpRuntime } from "./zcodeAcp.ts";

const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZcodeSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export const ZcodeProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    // The bridge's `model` config option switches the live session's model.
    supportsModelSwitchInSession: true,
    // Mode selection still rides configureSession's setMode on (re)open; a
    // runtime-mode change detaches and reopens the session instead.
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    // ExitPlanMode arrives as a `switch_mode` tool call whose rawInput carries
    // the plan markdown; extractProposedPlanMarkdown turns it into the card.
    emitsProposedPlan: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    // Foreground `Agent`/`Task` tool calls surface as subagent rows; the
    // bridge never emits child-session traffic, so there is no child thread
    // id to expose.
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ZcodeAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: ZcodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

/**
 * T3 runtime modes onto the ZCode session modes the bridge advertises from
 * `buildModes` (plan/build/edit/guarded/yolo): `build` keeps the backend's own
 * permission prompts, `edit` auto-accepts file edits, `guarded` runs
 * autonomously but still gates the operations ZCode flags dangerous, and
 * `yolo` runs unguarded.
 *
 * `interactionMode: "plan"` deliberately maps through the runtime mode here;
 * the adapter's generic plan/build machinery switches the session to the
 * advertised `plan` mode itself after recording the pre-plan mode it must
 * restore. Returning "plan" from this hook would record `plan` as that
 * restore point.
 */
export function zcodeSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): string {
  switch (policy.runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto":
      return "guarded";
    case "auto-accept-edits":
      return "edit";
    case "approval-required":
      return "build";
  }
}

/**
 * The bridge's structured turn-failure payload (`data.type ===
 * "zcode_turn_failed"`, produced by `turnFailureRequestError`) carries the
 * backend's own code, HTTP status and retry hints through the ACP request
 * error's `data` field.
 */
const ZcodeTurnFailureData = Schema.Struct({
  type: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  statusCode: Schema.optional(Schema.Number),
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMs: Schema.optional(Schema.Number),
});
const decodeZcodeTurnFailureData = Schema.decodeUnknownOption(ZcodeTurnFailureData);

/** Retry-After arrives as a duration; resolve it against wall-clock now for the failure's ISO resetAt. */
const zcodeResetAtFromRetryAfterMs = (retryAfterMs: number): string =>
  DateTime.formatIso(
    // @effect-diagnostics-next-line globalDate:off - promptFailure is a synchronous flavor hook, so the duration has to resolve against wall-clock now without a Clock service.
    DateTime.makeUnsafe(new Date(Date.now() + retryAfterMs)),
  );

export function zcodePromptFailure(cause: unknown) {
  if (!isAcpRequestError(cause)) {
    return makeProviderFailure({ cause, class: "provider_error" });
  }
  const detail =
    cause.data === undefined
      ? undefined
      : Option.getOrUndefined(decodeZcodeTurnFailureData(cause.data));
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: detail?.code ?? String(cause.code),
    class: detail?.statusCode === 429 ? "usage_limit" : "provider_error",
    retryable: detail?.retryable ?? null,
    // The bridge reports Retry-After as a duration; makeProviderFailure only
    // projects resetAt onto usage_limit failures.
    ...(detail?.retryAfterMs !== undefined && Number.isFinite(detail.retryAfterMs)
      ? { resetAt: zcodeResetAtFromRetryAfterMs(detail.retryAfterMs) }
      : {}),
  });
}

const zcodeToolName = (toolCall: AcpToolCallState): string | undefined => {
  const toolName = unknownRecord(unknownRecord(toolCall.data.meta)?.claudeCode)?.toolName;
  return typeof toolName === "string" ? toolName : undefined;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * In ZCode's `guarded` session mode (the T3 `auto` runtime mode) the backend
 * runs autonomously and only raises `session/request_permission` for the
 * operations its own gate refused — AST-flagged dangerous commands, and the
 * ExitPlanMode plan approval the plan-mode flow depends on. The generic
 * disposition would auto-allow every one of those asks (kind `other` + no
 * sandbox → allow), collapsing guarded into yolo and letting plan exits
 * bypass review entirely. Escalate them to the user instead, the same way
 * Grok's Auto mode is handled. Explicit approval/sandbox overrides keep the
 * generic policy answer so an operator who opted out of prompts is not
 * re-asked.
 */
export function zcodePermissionDisposition(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  if (
    policy.runtimeMode === "auto" &&
    policy.approvalPolicy === undefined &&
    policy.sandboxPolicy === undefined
  ) {
    return "ask";
  }
  return acpPermissionDisposition(policy, request);
}

/**
 * Strips the `agentId:` / `<usage>` trailer the Agent result appends for the
 * model (bridge `formatAgentOutputForModel`) — noise on the user-facing row.
 */
const ZCODE_SUBAGENT_RESULT_MARKERS =
  /\n?\s*agentId:\s*agent_[A-Za-z0-9-]+[^\n]*|\s*<usage>[\s\S]*?<\/usage>/g;

/**
 * ZCode dispatches subagents through its `Agent` (legacy `Task`) tool; the
 * bridge tags those calls `_meta.subagent` and always carries
 * `_meta.claudeCode.toolName`. Only the launch card is extracted — the bridge
 * never produces child-session frames (background agents report through a
 * separate `bg_*` task card and a notification-turn text summary), so the
 * subagent row owns the full lifecycle of a foreground call.
 *
 * `run_in_background` launches are left as ordinary tool calls: their tool
 * result is just the launch acknowledgement while the real task keeps
 * running, and the post-settle `bg_*` card is the honest lifecycle surface.
 * A result frame that arrives without launch fields (mid-flight first
 * sighting) keeps the normal tool card too, rather than minting a
 * prompt-less phantom subagent.
 */
export function extractZcodeSubagentUpdate(
  toolCall: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const toolName = zcodeToolName(toolCall);
  if (toolName !== "Agent" && toolName !== "Task") return undefined;
  const input = unknownRecord(toolCall.data.rawInput);
  if (input?.run_in_background === true) return undefined;
  const prompt = nonEmptyString(input?.prompt) ?? "";
  const title = nonEmptyString(input?.description) ?? null;
  if (prompt === "" && title === null) return undefined;
  const rawResult = toolCall.data.rawOutput;
  const result =
    typeof rawResult === "string"
      ? rawResult.replaceAll(ZCODE_SUBAGENT_RESULT_MARKERS, "").trim()
      : "";
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt,
    title,
    model: nonEmptyString(input?.model) ?? nonEmptyString(input?.subagent_type) ?? null,
    status:
      toolCall.status === "failed"
        ? "failed"
        : toolCall.status === "completed"
          ? "completed"
          : "running",
    childSessionId: null,
    result: result.length > 0 ? result : null,
  };
}

/**
 * ZCode's ExitPlanMode reaches non-TUI clients as a `switch_mode` tool call
 * followed by `session/request_permission`; the bridge puts the plan markdown
 * in `rawInput.plan` (and `content`). Surfacing it gives the approval card a
 * proposed-plan to review instead of a bare approve/reject prompt.
 */
export function extractZcodeProposedPlanMarkdown(toolCall: AcpToolCallState): string | undefined {
  if (zcodeToolName(toolCall) !== "ExitPlanMode") return undefined;
  const plan = unknownRecord(toolCall.data.rawInput)?.plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan : undefined;
}

export function makeZcodeAcpAdapterFlavor(options: ZcodeAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: ZCODE_PROVIDER,
    runtimeHarness: "ZCode",
    capabilities: ZcodeProviderCapabilitiesV2,
    // The bridge advertises sessionCapabilities.list/resume; resume restores
    // the backend session without replaying the full history.
    preferResumeSession: true,
    // The bridge already advertises promptCapabilities.image: true; the flag
    // keeps image blocks allowed even if a future build under-reports it.
    supportsImagePrompts: true,
    // The bridge exposes ZCode's /compact and reports the real outcome.
    supportsCompaction: true,
    sessionModeForPolicy: zcodeSessionModeForPolicy,
    // Guarded-mode asks are escalations, not routine prompts — see the
    // function's doc. Approval options stay default: the bridge already
    // normalizes every zcode option kind to the four canonical ACP kinds
    // (allow_once/allow_always/reject_once/reject_always, including its
    // injected "allowSession" session grant), so generic kind-based selection
    // answers them correctly. AskUserQuestion never reaches permission
    // requests on T3 — the bridge sees elicitation.form and sends
    // `elicitation/create` — so no extractPermissionQuestion is needed.
    permissionDisposition: zcodePermissionDisposition,
    extractSubagentUpdate: extractZcodeSubagentUpdate,
    extractProposedPlanMarkdown: extractZcodeProposedPlanMarkdown,
    // The bridge's session-scoped BackgroundTaskListener forwards post-settle
    // root traffic (bg_* task cards, terminal exits, and the
    // `inputSource:"background_task"` notification turn's result text) as
    // ordinary session/updates. Buffering them for a continuation run is the
    // designed path; deferFinalizeForBackgroundWork /
    // isProviderWakeNotification stay unset because the bridge owns the
    // background lifecycle — a held-open turn would only duplicate its own
    // bookkeeping with ids that never correlate back to in-turn frames.
    enablePostSettleContinuation: true,
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyZcodeAcpModelSelection({
        runtime,
        requestedModelId: modelSelection.model,
        mapError: (cause) => cause,
      }),
    promptFailure: zcodePromptFailure,
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeZcodeAcpRuntime({
          ...input,
          settings: options.settings,
          environment: options.environment,
        })),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeZcodeAdapterV2 = Effect.fn("makeZcodeAdapterV2")(function* (
  options: ZcodeAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeZcodeAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type ZcodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const ZcodeAdapterV2Driver: ProviderAdapterDriver<ZcodeSettings, ZcodeAdapterV2DriverEnv> = {
  driverKind: ZCODE_PROVIDER,
  configSchema: ZcodeSettings,
  defaultConfig: (): ZcodeSettings => DEFAULT_ZCODE_SETTINGS,
  create: Effect.fn("ZcodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ZcodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeZcodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: ZCODE_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ZCODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create ZCode ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
