/**
 * ZCode provider status probing: version the `zcode` CLI, resolve the binary
 * (`binaryPath` → `ZCODE_BIN` → PATH → well-known paths), then open a
 * disposable `workspace-config` subscription for models and slash commands.
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
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
import * as ZCodeRpc from "@t3tools/effect-zcode-protocol/rpc";
import * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";
import {
  buildZcodeAppServerSpawnInput,
  openZcodeAppServerClient,
  type ZcodeAppServerClientOpener,
} from "./zcodeAppServer.ts";

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
// `zcode app-server --stdio` can be slow to reach storage-ready on
// a cold install; this still bounds the whole disposable session.
const ZCODE_ACP_PROBE_TIMEOUT_MS = 15_000;

const ZCODE_CLI_COMMAND = "zcode";
const ZCODE_BIN_ENV = "ZCODE_BIN";
const ZCODE_HOME_ENV = "ZCODE_HOME";
const ZCODE_DOCUMENTATION_URL = "https://github.com/zai-org/ZCode";

/** The slug that means "keep the session's current model". */
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

export const buildInitialZcodeProviderSnapshot = Effect.fn("buildInitialZcodeProviderSnapshot")(
  function* (zcodeSettings: ZcodeSettings) {
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
  },
);
const MAX_MODEL_ID_LENGTH = 256;
const MAX_COMMAND_NAME_LENGTH = 128;
const MAX_COMMAND_DESCRIPTION_LENGTH = 1_024;

/** The directory ZCode keeps credentials and provider config in. */
export const zcodeHomePath = Effect.fn("zcodeHomePath")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
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
export const zcodeCredentialFilesPresent = Effect.fn("zcodeCredentialFilesPresent")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
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

const fileExists = Effect.fnUntraced(function* (
  candidate: string,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
});

/**
 * Where the `zcode` binary comes from: the `binaryPath` setting (when it
 * points somewhere other than the default name), `ZCODE_BIN`, PATH, then the
 * well-known paths the installer and desktop bundle write.
 */
const resolveZcodeBackend = Effect.fn("resolveZcodeBackend")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ZcodeBackendResolution, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const executable = platform === "win32" ? `${ZCODE_CLI_COMMAND}.exe` : ZCODE_CLI_COMMAND;

  const configured = nonEmptyTrimmed(zcodeSettings.binaryPath);
  if (configured !== undefined && configured !== ZCODE_CLI_COMMAND) {
    return (yield* fileExists(configured))
      ? { kind: "resolved", commandPath: configured }
      : { kind: "configured-missing", commandPath: configured, source: "binaryPath" };
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

const runZcodeCliCommand = Effect.fn("runZcodeCliCommand")(function* (
  zcodeSettings: ZcodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const command = zcodeSettings.binaryPath || ZCODE_CLI_COMMAND;
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  // Same env the real session spawn gets: headless installs need the
  // provider-config files resolved or the backend boots with no registry.
  const childEnv = buildZcodeAppServerSpawnInput(zcodeSettings, cwd ?? ".", environment).env;
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: childEnv,
      shell: spawnCommand.shell,
    }),
  );
});

interface ZcodeProbeResult {
  readonly authenticated: boolean;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

export interface ZcodeStatusProbeOptions {
  /**
   * Overrides the disposable app-server the probe spawns; tests substitute a
   * fake client. The default spawns `zcode app-server --stdio`.
   */
  readonly openClient?: ZcodeAppServerClientOpener;
}

function zcodeModelsFromWorkspaceOptions(
  options: ReadonlyArray<ZCodeSchema.WorkspaceConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const option of options) {
    if (option.id !== "model") continue;
    for (const candidate of option.options ?? []) {
      const slug = nonEmptyTrimmed(candidate.value);
      if (slug === undefined || slug.length > MAX_MODEL_ID_LENGTH || seen.has(slug)) continue;
      seen.add(slug);
      models.push({
        slug,
        name: nonEmptyTrimmed(candidate.name) ?? slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      });
      if (models.length >= 256) return models;
    }
  }
  return models;
}

function zcodeSlashCommandsFromWorkspaceConfig(
  commands: ReadonlyArray<ZCodeSchema.WorkspaceSlashCommand>,
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
    const hint = (command.inputHint ?? "").trim().slice(0, MAX_COMMAND_DESCRIPTION_LENGTH);
    slashCommands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
    if (slashCommands.length >= 128) break;
  }
  return slashCommands;
}

/**
 * One disposable `app-server` round trip: subscribe `workspace-config/<cwd>`
 * and read the first frame's model options + slash commands. Auth is never
 * triggered — a storage/subscription failure is the probe's signal.
 */
const discoverZcodeMetadataViaAppServer = Effect.fn("discoverZcodeMetadataViaAppServer")(function* (
  zcodeSettings: ZcodeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  openClient: ZcodeAppServerClientOpener,
) {
  const spawnInput = buildZcodeAppServerSpawnInput(zcodeSettings, cwd, environment);
  const client = yield* openClient({
    command: spawnInput.command,
    args: spawnInput.args,
    cwd: spawnInput.cwd,
    env: spawnInput.env,
  });
  const snapshotReady = yield* Deferred.make<ZCodeSchema.WorkspaceConfigSnapshot>();
  yield* client.handleServerNotification("v4/conversation/frame", (params: unknown) =>
    Effect.gen(function* () {
      const frame = (params as { readonly frame?: unknown }).frame;
      // See adapter.ts: DecodingServices is a phantom `unknown` for schemas
      // containing Unknown fields; nothing is actually required.
      const codec = ZCodeSchema.WorkspaceConfigTopicFrame as unknown as Schema.Codec<
        ZCodeSchema.WorkspaceConfigTopicFrame,
        unknown,
        never,
        never
      >;
      const decoded = yield* Schema.decodeUnknownEffect(codec)(frame).pipe(Effect.option);
      const payload = Option.getOrUndefined(decoded)?.payload;
      if (payload?.kind === "snapshot") {
        yield* Deferred.succeed(snapshotReady, payload.snapshot);
      }
    }),
  );
  yield* client.request(ZCodeRpc.V4_METHODS.conversationSubscribe, {
    topic: ZCodeSchema.workspaceConfigTopic(cwd),
    connectionId: "t3-status-probe",
    clientMode: "desktop-continuous" as const,
  });
  const snapshot = yield* Deferred.await(snapshotReady).pipe(
    Effect.timeoutOption(ZCODE_ACP_PROBE_TIMEOUT_MS / 2),
  );
  if (Option.isNone(snapshot)) {
    return { authenticated: true, models: [], slashCommands: [] } satisfies ZcodeProbeResult;
  }
  return {
    authenticated: true,
    models: zcodeModelsFromWorkspaceOptions(snapshot.value.config.configOptions),
    slashCommands: zcodeSlashCommandsFromWorkspaceConfig(snapshot.value.config.slashCommands),
  } satisfies ZcodeProbeResult;
}, Effect.scoped);

const makeDefaultProbeOpener = (): ZcodeAppServerClientOpener => openZcodeAppServerClient;

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

  const versionResult = yield* runZcodeCliCommand(
    zcodeSettings,
    ["--version"],
    environment,
    cwd,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("ZCode CLI health check failed.", {
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
          ? "The ZCode CLI (`zcode`) is not installed or not on PATH."
          : "Failed to execute the ZCode CLI health check.",
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
        message: "The ZCode CLI is installed but timed out while running `--version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("ZCode CLI version probe exited with a non-zero status.", {
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
        message: "The ZCode CLI is installed but failed to run.",
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

  const probeExit = yield* discoverZcodeMetadataViaAppServer(
    zcodeSettings,
    environment,
    cwd ?? process.cwd(),
    probeOptions?.openClient ?? makeDefaultProbeOpener(),
  ).pipe(Effect.timeoutOption(ZCODE_ACP_PROBE_TIMEOUT_MS), Effect.exit);
  const probe = Exit.isSuccess(probeExit) ? Option.getOrUndefined(probeExit.value) : undefined;
  const probeFailed = probe === undefined;
  if (probeFailed) {
    yield* Effect.logWarning("ZCode app-server probe failed or timed out.", {
      errorTag: Exit.isFailure(probeExit) ? causeErrorTag(probeExit.cause) : "Timeout",
    });
  }

  const discoveredModels = probe?.models ?? [];
  const models =
    discoveredModels.length > 0
      ? zcodeModelsFromSettings(zcodeSettings.customModels, discoveredModels)
      : fallbackModels;

  const auth: ServerProviderAuth = !hasCredentials
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
              "The ZCode CLI is installed but its app-server probe failed. Model options may be incomplete.",
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
