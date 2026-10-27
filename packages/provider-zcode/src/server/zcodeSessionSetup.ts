/**
 * Per-connection wiring before commands can issue: runtime-preference
 * answers, the runtime-header credential lookup, and the account overlay
 * that seeds the model registry. Shared by adapter and text generation.
 *
 * @module provider-zcode/server/zcodeSessionSetup
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as ZCodeClient from "@t3tools/effect-zcode-protocol/client";
import * as ZCodeRpc from "@t3tools/effect-zcode-protocol/rpc";
import type * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";
import {
  buildZcodeAccountOverlay,
  readZcodeCredentialStore,
  resolveZcodeRequestApiKey,
} from "./zcodeCredentials.ts";

export interface ZcodeSessionSetupServices {
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/** The CLI asks on createSession and each sendText; both get T3's defaults. */
const ZCODE_RUNTIME_PREFERENCES: ZCodeSchema.ZCodeSessionRuntimePreferencesResult = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
};

/**
 * Registers `session/requestRuntimePreferences` and
 * `interaction/requestProviderRuntimeHeaders`. Header lookups decrypt the
 * local `~/.zcode` credential store; the apiKey itself never reaches logs.
 */
export const installZcodeRuntimeRequestHandlers = Effect.fn("installZcodeRuntimeRequestHandlers")(
  function* (
    client: ZCodeClient.ZCodeAppServerClient["Service"],
    services: ZcodeSessionSetupServices,
  ) {
    yield* client.handleServerRequest(
      ZCodeRpc.SERVER_REQUEST_METHODS.sessionRequestRuntimePreferences,
      () => Effect.succeed(ZCODE_RUNTIME_PREFERENCES),
    );
    yield* client.handleServerRequest(
      ZCodeRpc.SERVER_REQUEST_METHODS.interactionRequestProviderRuntimeHeaders,
      (params) =>
        readZcodeCredentialStore(services.environment).pipe(
          Effect.provideService(FileSystem.FileSystem, services.fileSystem),
          Effect.provideService(Path.Path, services.path),
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
  },
);

/**
 * Without the overlay the registry publishes zero executable models and every
 * model-bound request fails `modelUnavailable`. Pushed once per process;
 * requests self-gate on storage-ready. Failures warn, never fail the open.
 */
export const pushZcodeAccountOverlay = Effect.fn("pushZcodeAccountOverlay")(function* (
  client: ZCodeClient.ZCodeAppServerClient["Service"],
  input: ZcodeSessionSetupServices & {
    readonly revision: string;
    readonly refreshReason: string;
  },
) {
  const overlay = yield* buildZcodeAccountOverlay({
    environment: input.environment,
    revision: input.revision,
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    Effect.provideService(Path.Path, input.path),
  );
  if (overlay === undefined) {
    yield* Effect.logWarning("ZCode builtin provider config not found; account overlay skipped.");
    return;
  }
  yield* client.request(ZCodeRpc.LEGACY_METHODS.providerUpdateAccountConfig, overlay).pipe(
    Effect.andThen(
      client.request(ZCodeRpc.LEGACY_METHODS.providerRefreshRegistry, {
        reason: input.refreshReason,
      }),
    ),
    Effect.catch((cause) => Effect.logWarning("ZCode account overlay push failed", { cause })),
  );
});
