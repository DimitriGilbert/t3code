/**
 * Devin's orchestration-v2 adapter: an `AcpAdapterV2` flavor over the
 * first-party `devin acp` server, plus the `ProviderAdapterDriver` the server
 * registers.
 *
 * @module provider-devin/server/adapter
 */
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
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
} from "@t3tools/provider-acp/server/adapter";
import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { DevinSettings } from "../settings.ts";
import { DEVIN_PROVIDER } from "./driverKind.ts";
import { applyDevinAcpModelSelection, makeDevinAcpRuntime } from "./devinAcp.ts";
import {
  extractDevinSubagentUpdate,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "./devinSessionUpdates.ts";

const DEFAULT_DEVIN_SETTINGS = Schema.decodeSync(DevinSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export const DevinProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    // Devin's `model` config option switches the live session's model.
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
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    // `cognition.ai/subagent_started|subagent_completed` metadata carries a
    // real Devin session id (`agentId`); normalizeDevinSessionUpdate routes
    // the child's session traffic onto that thread.
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface DevinAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: DevinSettings;
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
 * T3 runtime modes onto the Devin session modes `devin acp` advertises
 * (`accept-edits|smart|ask|plan|bypass`): `accept-edits` auto-approves edits
 * but still gates the rest, `smart` auto-approves what the model judges safe,
 * `bypass` auto-approves everything.
 *
 * `approval-required` has no exact Devin mode. The CLI's strictest
 * prompt-for-everything mode (`--permission-mode auto`) is not offered over
 * ACP — setting `mode: "auto"` via `session/set_config_option` is silently
 * ignored (verified live: `currentValue` unchanged) — and `ask` is a
 * read-only Q&A mode, not a coding gate. `accept-edits` is the strictest
 * selectable coding mode: Devin auto-approves workspace edits itself, but
 * shell commands still reach T3's approval-required policy as asks through
 * `session/request_permission` and the client-terminal guard.
 *
 * `interactionMode: "plan"` deliberately maps through the runtime mode here;
 * the adapter's generic plan/build machinery switches the session to the
 * advertised `plan` mode itself after recording the pre-plan mode it must
 * restore. Returning "plan" from this hook would record `plan` as that
 * restore point.
 */
export function devinSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): string {
  switch (policy.runtimeMode) {
    case "full-access":
      return "bypass";
    case "auto":
      return "smart";
    case "auto-accept-edits":
      return "accept-edits";
    case "approval-required":
      return "accept-edits";
  }
}

/**
 * In Devin's `smart` session mode (the T3 `auto` runtime mode) the agent
 * auto-approves the actions it judges safe and only raises
 * `session/request_permission` for the rest — those asks are escalations,
 * not routine prompts. The generic disposition would auto-allow every one of
 * them (kind `other` + no sandbox → allow), collapsing smart into bypass.
 * Escalate them to the user instead, the same way Grok's Auto and zcode's
 * guarded modes are handled. Explicit approval/sandbox overrides keep the
 * generic policy answer so an operator who opted out of prompts is not
 * re-asked.
 */
export function devinPermissionDisposition(
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
 * Devin's request errors carry a structured `data` payload —
 * `{"cognition.ai/errorKind": "session_not_found", "cognition.ai/retryable":
 * false}` on `code: -32016` (verified live). Surface the kind as the failure
 * code and keep the retryable hint. No rate-limit kind has been observed yet;
 * map one onto `usage_limit` when a real payload is captured.
 */
const DevinRequestErrorData = Schema.Struct({
  "cognition.ai/errorKind": Schema.optional(Schema.String),
  "cognition.ai/retryable": Schema.optional(Schema.Boolean),
});
const decodeDevinRequestErrorData = Schema.decodeUnknownOption(DevinRequestErrorData);

export function devinPromptFailure(cause: unknown) {
  if (!isAcpRequestError(cause)) {
    return makeProviderFailure({ cause, class: "provider_error" });
  }
  const detail =
    cause.data === undefined
      ? undefined
      : Option.getOrUndefined(decodeDevinRequestErrorData(cause.data));
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: detail?.["cognition.ai/errorKind"] ?? String(cause.code),
    class: "provider_error",
    retryable: detail?.["cognition.ai/retryable"] ?? null,
  });
}

export function makeDevinAcpAdapterFlavor(options: DevinAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: DEVIN_PROVIDER,
    runtimeHarness: "Devin",
    capabilities: DevinProviderCapabilitiesV2,
    // Opts Devin into its typed session surface: subagent updates route to
    // real child sessions (`subagent_context`) and grouped stream chunks
    // carry `streamingMessageId`. Same contract the ACP Registry's devin
    // special case applies.
    clientCapabilitiesMeta: {
      "cognition.ai/subagentSupport": true,
      "cognition.ai/messageGrouping": true,
    },
    normalizeSessionUpdate: normalizeDevinSessionUpdate,
    normalizeToolCall: normalizeDevinToolCall,
    extractSubagentUpdate: extractDevinSubagentUpdate,
    // Devin has no `sessionCapabilities.resume`; its loadSession flag routes
    // resume through `session/load`, which replays session history.
    preferResumeSession: true,
    // Devin advertises promptCapabilities.image: true; the flag keeps image
    // blocks allowed even if a future build under-reports it.
    supportsImagePrompts: true,
    // `/compact` is advertised in available_commands_update (verified live).
    supportsCompaction: true,
    sessionModeForPolicy: devinSessionModeForPolicy,
    permissionDisposition: devinPermissionDisposition,
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyDevinAcpModelSelection({
        runtime,
        requestedModelId: modelSelection.model,
        mapError: (cause) => cause,
      }),
    promptFailure: devinPromptFailure,
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeDevinAcpRuntime({
          ...input,
          settings: options.settings,
          environment: options.environment,
        })),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeDevinAdapterV2 = Effect.fn("makeDevinAdapterV2")(function* (
  options: DevinAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeDevinAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    // Devin runs its shell commands through client terminals (the ACP
    // `terminal` client capability) instead of its own executor — the only
    // provider that does so. `shellCommands` because it sends shell source in
    // `command` rather than an executable plus args. Creation is gated by
    // T3's runtime policy at the terminal boundary.
    clientTerminals: { environment: options.environment, shellCommands: true },
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type DevinAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const DevinAdapterV2Driver: ProviderAdapterDriver<DevinSettings, DevinAdapterV2DriverEnv> = {
  driverKind: DEVIN_PROVIDER,
  configSchema: DevinSettings,
  defaultConfig: (): DevinSettings => DEFAULT_DEVIN_SETTINGS,
  create: Effect.fn("DevinAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<DevinSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeDevinAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: DEVIN_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DEVIN_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Devin ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
