/**
 * ZCode provider status probing.
 *
 * Two binaries are involved: the `zcode-acp-server` bridge (npm) and the
 * `zcode` backend the bridge spawns (desktop app / installer, not on npm).
 * The probe versions the bridge, resolves the backend the same way the
 * bridge does (`ZCODE_BIN` → PATH → well-known install paths), then opens a
 * disposable `initialize` + `session/new` ACP session to read auth methods,
 * the `model` config option, and advertised slash commands. Credentials are
 * detected by the files ZCode writes under `~/.zcode` (`ZCODE_HOME`
 * re-roots it) — the store itself is encrypted, so presence plus a
 * successful session probe is the only honest signal.
 *
 * @module provider-zcode/server/status
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type { ZcodeSettings } from "../settings.ts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { ServerProvider } from "@t3tools/contracts";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as Scope from "effect/Scope";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeZcodeAcpRuntime, ZCODE_ACP_SERVER_BIN, zcodeProviderConfigEnv } from "./zcodeAcp.ts";

const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  supportsConversationRollback: false,
  // ZCode has a real `plan` session mode, so the composer toggle stays on.
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `session/new` makes the bridge boot `zcode app-server`, which can be slow on
// a cold install; this still bounds the whole disposable session.
const ZCODE_ACP_PROBE_TIMEOUT_MS = 15_000;
const COMMAND_ADVERTISEMENT_GRACE = "500 millis";

const ZCODE_CLI_COMMAND = "zcode";
const ZCODE_BIN_ENV = "ZCODE_BIN";
const ZCODE_HOME_ENV = "ZCODE_HOME";
const ZCODE_DOCUMENTATION_URL = "https://github.com/zai-org/ZCode";

/** The slug that means "keep the session's current model" (see zcodeAcp.ts). */
export const ZCODE_DEFAULT_MODEL_SLUG = "default";

const ZCODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: ZCODE_DEFAULT_MODEL_SLUG,
    name: "Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/** ZCode instance snapshots never offer application text generation. */
const withZcodeSnapshotDefaults = (draft: ServerProviderDraft): ServerProviderDraft => ({
  ...draft,
  supportsTextGeneration: false,
  // ZCode has no remote sign-out the bridge can drive (auth.ts logout is a
  // guided failure). canLogout must say so explicitly — otherwise the UI's
  // `canLogout ?? setup.canAuthenticate` fallback offers a control that can
  // only fail.
  auth: { ...draft.auth, canLogout: false },
  setup: {
    canAuthenticate: true,
    canInstall: false,
    documentationUrl: ZCODE_DOCUMENTATION_URL,
  },
});

function zcodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ZCODE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialZcodeProviderSnapshot(
  zcodeSettings: ZcodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = zcodeModelsFromSettings(zcodeSettings.customModels);

    if (!zcodeSettings.enabled) {
      return withZcodeSnapshotDefaults(
        buildServerProvider({
          presentation: ZCODE_PRESENTATION,
          enabled: false,
          checkedAt,
          models,
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "ZCode is disabled in T3 Code settings.",
          },
        }),
      );
    }

    return withZcodeSnapshotDefaults(
      buildServerProvider({
        presentation: ZCODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking ZCode availability...",
        },
      }),
    );
  });
}

const MAX_MODEL_ID_LENGTH = 256;
const MAX_COMMAND_NAME_LENGTH = 128;
const MAX_COMMAND_DESCRIPTION_LENGTH = 1_024;

/**
 * Models from the session's `model` config option. The bridge encodes values
 * as `providerId\modelId` / `custom:...`; T3 keeps them verbatim — they round
 * trip back through `session/set_config_option`.
 */
export function zcodeModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  let currentValue: string | undefined;
  for (const option of configOptions ?? []) {
    if (option.category !== "model" || option.type !== "select") continue;
    currentValue = nonEmptyTrimmed(option.currentValue) ?? currentValue;
    for (const candidate of option.options) {
      const choices = "value" in candidate ? [candidate] : candidate.options;
      for (const choice of choices) {
        const slug = nonEmptyTrimmed(choice.value);
        if (slug === undefined || slug.length > MAX_MODEL_ID_LENGTH || seen.has(slug)) continue;
        seen.add(slug);
        models.push({
          slug,
          name: nonEmptyTrimmed(choice.name) ?? slug,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        });
        if (models.length >= 256) return models;
      }
    }
  }
  const current = currentValue !== undefined && seen.has(currentValue) ? currentValue : undefined;
  return models.map((model) => (model.slug === current ? { ...model, isDefault: true } : model));
}

/** Slash commands the bridge advertises via `available_commands_update`. */
export function zcodeSlashCommandsFromCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>([COMPACT_SLASH_COMMAND.name]);
  const slashCommands: Array<ServerProviderSlashCommand> = [COMPACT_SLASH_COMMAND];
  for (const command of commands) {
    const name = command.name.trim();
    const key = name.toLowerCase();
    if (
      name.length === 0 ||
      name.length > MAX_COMMAND_NAME_LENGTH ||
      seen.has(key) ||
      name.startsWith("$")
    ) {
      continue;
    }
    seen.add(key);
    const description = command.description.trim().slice(0, MAX_COMMAND_DESCRIPTION_LENGTH);
    const hint = command.input?.hint.trim().slice(0, MAX_COMMAND_DESCRIPTION_LENGTH);
    slashCommands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
    if (slashCommands.length >= 128) break;
  }
  return slashCommands;
}

/** The directory ZCode keeps credentials and provider config in. */
export const zcodeHomePath = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const fromEnv = nonEmptyTrimmed(environment[ZCODE_HOME_ENV]);
    if (fromEnv !== undefined) return fromEnv;
    const path = yield* Path.Path;
    return path.join(yield* HostProcess.HomeDirectory, ".zcode");
  });

/**
 * True when ZCode has written any of its credential-bearing files: the GLM
 * config, the encrypted credential store, or personal provider rules.
 * Presence is the best signal available — `credentials.json` is encrypted.
 */
export const zcodeCredentialFilesPresent = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* zcodeHomePath(environment);
    for (const relative of [
      path.join("v2", "config.json"),
      path.join("v2", "credentials.json"),
      "provider_config.json",
    ]) {
      if (
        yield* fileSystem.exists(path.join(home, relative)).pipe(Effect.orElseSucceed(() => false))
      ) {
        return true;
      }
    }
    return false;
  });

type ZcodeBackendResolution =
  | { readonly kind: "resolved"; readonly commandPath: string }
  | { readonly kind: "configured-missing"; readonly commandPath: string; readonly source: string }
  | { readonly kind: "missing" };

const fileExists = (candidate: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  });

/**
 * Where the `zcode` backend binary comes from, mirroring the bridge's own
 * discovery order: the `zcodeBinaryPath` setting (forwarded as `ZCODE_BIN`),
 * then `ZCODE_BIN` in the instance environment, then PATH, then the
 * well-known paths the installer and desktop bundle write.
 */
const resolveZcodeBackend = (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<ZcodeBackendResolution, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const executable = platform === "win32" ? `${ZCODE_CLI_COMMAND}.exe` : ZCODE_CLI_COMMAND;

    const configured = nonEmptyTrimmed(zcodeSettings.zcodeBinaryPath);
    if (configured !== undefined) {
      return (yield* fileExists(configured))
        ? { kind: "resolved", commandPath: configured }
        : { kind: "configured-missing", commandPath: configured, source: "zcodeBinaryPath" };
    }
    const fromEnv = nonEmptyTrimmed(environment[ZCODE_BIN_ENV]);
    if (fromEnv !== undefined) {
      return (yield* fileExists(fromEnv))
        ? { kind: "resolved", commandPath: fromEnv }
        : { kind: "configured-missing", commandPath: fromEnv, source: ZCODE_BIN_ENV };
    }
    const onPath = yield* resolveCommandPath(ZCODE_CLI_COMMAND, { env: environment });
    if (onPath !== null) {
      return { kind: "resolved", commandPath: onPath };
    }
    const home = yield* HostProcess.HomeDirectory;
    const zcodeHome = yield* zcodeHomePath(environment);
    for (const candidate of [
      path.join(home, ".local", "bin", executable),
      path.join(zcodeHome, "runtime", "bin", executable),
    ]) {
      if (yield* fileExists(candidate)) {
        return { kind: "resolved", commandPath: candidate };
      }
    }
    return { kind: "missing" };
  });

const runZcodeBridgeCommand = Effect.fn("runZcodeBridgeCommand")(function* (
  zcodeSettings: ZcodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = zcodeSettings.binaryPath || ZCODE_ACP_SERVER_BIN;
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  // Same env the real session spawn gets: the bridge needs the headless
  // provider-config files resolved or it boots the backend with no registry.
  const childEnv = { ...zcodeProviderConfigEnv(environment), ...environment };
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: childEnv,
      shell: spawnCommand.shell,
    }),
  );
});

interface ZcodeAcpProbeResult {
  readonly authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod>;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/** The surface the disposable session probe actually exercises. */
type ZcodeProbeRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "handleSessionUpdate" | "start"
>;

export interface ZcodeStatusProbeOptions {
  /**
   * Overrides the disposable ACP session the probe opens; tests substitute a
   * fake bridge. The default spawns `zcode-acp-server` and never authenticates.
   */
  readonly makeRuntime?: (input: {
    readonly settings: ZcodeSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
  }) => Effect.Effect<
    ZcodeProbeRuntime,
    EffectAcpErrors.AcpError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  >;
}

/**
 * One disposable `initialize` + `session/new` round trip. `session/new` is
 * where the bridge reports the `model` config option; `available_commands_update`
 * can land just after it, so the read waits out a short grace period. Auth is
 * never triggered — an auth-required answer is the probe's signal, not an
 * invitation to log in.
 */
const discoverZcodeMetadataViaAcp = Effect.fn("discoverZcodeMetadataViaAcp")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  makeRuntime: NonNullable<ZcodeStatusProbeOptions["makeRuntime"]>,
) {
  const acp = yield* makeRuntime({ settings: zcodeSettings, environment, cwd });
  const commandsRef = yield* Ref.make<ReadonlyArray<ServerProviderSlashCommand>>([]);
  const commandsAdvertised = yield* Deferred.make<void>();
  yield* acp.handleSessionUpdate((notification) =>
    notification.update.sessionUpdate === "available_commands_update"
      ? Ref.set(
          commandsRef,
          zcodeSlashCommandsFromCommands(notification.update.availableCommands),
        ).pipe(Effect.andThen(Deferred.succeed(commandsAdvertised, undefined)), Effect.asVoid)
      : Effect.void,
  );
  const started = yield* acp.start();
  yield* Deferred.await(commandsAdvertised).pipe(Effect.timeoutOption(COMMAND_ADVERTISEMENT_GRACE));
  return {
    authMethods: started.initializeResult.authMethods ?? [],
    models: zcodeModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
    slashCommands: yield* Ref.get(commandsRef),
  } satisfies ZcodeAcpProbeResult;
}, Effect.scoped);

const isAcpAuthRequired = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "AcpRequestError" &&
  (error as { readonly code?: unknown }).code === -32000;

const makeZcodeProbeRuntime = (input: {
  readonly settings: ZcodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}) =>
  makeZcodeAcpRuntime({
    settings: input.settings,
    environment: input.environment,
    cwd: input.cwd,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    authenticateOnAuthRequired: false,
  });

export const checkZcodeProviderStatus = Effect.fn("checkZcodeProviderStatus")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  probeOptions?: ZcodeStatusProbeOptions,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = zcodeModelsFromSettings(zcodeSettings.customModels);
  const snapshot = (input: {
    readonly enabled: boolean;
    readonly models?: ReadonlyArray<ServerProviderModel>;
    readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
    readonly probe: {
      readonly installed: boolean;
      readonly version: string | null;
      readonly status: Exclude<ServerProvider["status"], "disabled">;
      readonly auth: ServerProviderAuth;
      readonly message?: string;
    };
  }): ServerProviderDraft =>
    withZcodeSnapshotDefaults(
      buildServerProvider({
        presentation: ZCODE_PRESENTATION,
        enabled: input.enabled,
        checkedAt,
        models: input.models ?? fallbackModels,
        ...(input.slashCommands ? { slashCommands: input.slashCommands } : {}),
        probe: input.probe,
      }),
    );

  if (!zcodeSettings.enabled) {
    return snapshot({
      enabled: false,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ZCode is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runZcodeBridgeCommand(
    zcodeSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("ZCode ACP bridge health check failed.", {
      errorTag: error._tag,
    });
    return snapshot({
      enabled: zcodeSettings.enabled,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "The ZCode ACP bridge (`zcode-acp-server`) is not installed or not on PATH."
          : "Failed to execute the ZCode ACP bridge health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return snapshot({
      enabled: zcodeSettings.enabled,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The ZCode ACP bridge is installed but timed out while running `--version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("ZCode ACP bridge version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return snapshot({
      enabled: zcodeSettings.enabled,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "The ZCode ACP bridge is installed but failed to run.",
      },
    });
  }

  const hasCredentials = yield* zcodeCredentialFilesPresent(environment);
  const unauthenticated: ServerProviderAuth = {
    status: "unauthenticated",
    type: "zcode",
    label: "ZCode account",
  };

  const backend = yield* resolveZcodeBackend(zcodeSettings, environment);
  if (backend.kind !== "resolved") {
    return snapshot({
      enabled: zcodeSettings.enabled,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: hasCredentials ? { status: "unknown" } : unauthenticated,
        message:
          backend.kind === "configured-missing"
            ? `The ZCode binary configured via ${backend.source} does not exist: ${backend.commandPath}`
            : "The ZCode CLI (`zcode`) was not found. Set the ZCode binary path in provider settings, or install the ZCode desktop app.",
      },
    });
  }

  const probeExit = yield* discoverZcodeMetadataViaAcp(
    zcodeSettings,
    environment,
    cwd ?? process.cwd(),
    probeOptions?.makeRuntime ?? makeZcodeProbeRuntime,
  ).pipe(Effect.timeoutOption(ZCODE_ACP_PROBE_TIMEOUT_MS), Effect.exit);
  const probe = Exit.isSuccess(probeExit) ? Option.getOrUndefined(probeExit.value) : undefined;
  const probeError = Exit.isFailure(probeExit)
    ? Option.getOrNull(Cause.findErrorOption(probeExit.cause))
    : null;
  const authRequired = isAcpAuthRequired(probeError);
  const probeFailed = probe === undefined;
  if (probeFailed) {
    yield* Effect.logWarning("ZCode ACP session probe failed or timed out.", {
      errorTag: Exit.isFailure(probeExit) ? causeErrorTag(probeExit.cause) : "Timeout",
    });
  }

  const discoveredModels = probe?.models ?? [];
  const models =
    discoveredModels.length > 0
      ? zcodeModelsFromSettings(zcodeSettings.customModels, discoveredModels)
      : fallbackModels;

  const auth: ServerProviderAuth = authRequired
    ? unauthenticated
    : !hasCredentials
      ? unauthenticated
      : probe !== undefined
        ? { status: "authenticated", type: "zcode", label: "ZCode account" }
        : { status: "unknown" };

  if (auth.status === "unauthenticated") {
    return snapshot({
      enabled: zcodeSettings.enabled,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message:
          "ZCode has no saved credentials. Sign in from provider settings or run `zcode login`.",
      },
    });
  }

  return snapshot({
    enabled: zcodeSettings.enabled,
    models,
    slashCommands: probe?.slashCommands ?? [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed metadata probe degrades the model picker; a real turn may
      // still work, so it is a warning, not an outage.
      status: probeFailed ? "warning" : "ready",
      auth,
      ...(probeFailed
        ? {
            message:
              "The ZCode ACP bridge is installed but its session probe failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichZcodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("ZCode version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
