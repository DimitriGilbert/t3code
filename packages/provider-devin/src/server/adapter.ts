/**
 * Devin's orchestration-v2 adapter: an `AcpAdapterV2` flavor over the
 * first-party `devin acp` server, plus the `ProviderAdapterDriver` the server
 * registers.
 *
 * @module provider-devin/server/adapter
 */
import {
  type OrchestrationV2ProviderCapabilities,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
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
  extractDevinProposedPlanMarkdown,
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
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    // Verified live: plan mode writes the plan through the `write_plan` tool
    // (markdown in rawInput + an isPlanFileEdit diff), then asks approval via
    // `exit_plan_mode`'s permission prompt.
    emitsProposedPlan: true,
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
 * (`accept-edits|smart|ask|plan|bypass`). `approval-required` lands on
 * `accept-edits`, the strictest selectable coding mode (verified live);
 * `plan` stays on the runtime mode so generic machinery restores correctly.
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
 * In Devin's `smart` mode (T3 `auto`) `session/request_permission` asks are
 * escalations, not routine prompts; the generic disposition would auto-allow
 * them and collapse smart into bypass. Ask instead, unless explicit
 * approval/sandbox overrides opted the operator out of prompts.
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
 * Approval choices for a Devin `session/request_permission`: show the
 * session-grant button only when Devin offered `allow_always` — it is absent
 * on `exit_plan_mode`, where answering it would cancel the request.
 */
export function devinApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind);
  return [
    { decision: "cancel", label: "Cancel" },
    ...(has("reject_once") ? [{ decision: "decline", label: "Decline" } as const] : []),
    ...(has("allow_always")
      ? [{ decision: "acceptForSession", label: "Always allow this session" } as const]
      : []),
    ...(has("allow_once") ? [{ decision: "accept", label: "Approve" } as const] : []),
  ];
}

/**
 * Devin's request errors carry `{"cognition.ai/errorKind": ...,
 * "cognition.ai/retryable": ...}` in `data` (verified live on -32016
 * session_not_found). Map a future rate-limit kind onto `usage_limit`.
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
    extractProposedPlanMarkdown: extractDevinProposedPlanMarkdown,
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
    approvalOptions: devinApprovalOptions,
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
    // Devin runs shell commands through client terminals (the ACP `terminal`
    // capability) — `shellCommands` because it sends shell source in
    // `command`. Creation is gated by T3's runtime policy at that boundary.
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
