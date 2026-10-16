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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
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
});
const decodeZcodeTurnFailureData = Schema.decodeUnknownOption(ZcodeTurnFailureData);

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
  });
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
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeZcodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
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
