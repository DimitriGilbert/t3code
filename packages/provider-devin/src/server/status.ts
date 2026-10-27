/**
 * Devin provider status probing: `devin --version` proves the install, a
 * disposable ACP session reads model/slash-command metadata, and
 * `devin auth status` plus `credentials.toml` carry auth.
 *
 * @module provider-devin/server/status
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type { DevinSettings } from "../settings.ts";
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
import { resolveSpawnCommand } from "@t3tools/shared/shell";

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
import { DEVIN_CLI_BIN, makeDevinAcpRuntime } from "./devinAcp.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  supportsConversationRollback: false,
  // Devin has a real `plan` session mode, so the composer toggle stays on.
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `session/new` hits Devin's team-settings/model-config endpoints and can
// boot user-configured MCP servers, so it is slower than most ACP probes.
const DEVIN_ACP_PROBE_TIMEOUT_MS = 15_000;
const COMMAND_ADVERTISEMENT_GRACE = "500 millis";

const DEVIN_DOCUMENTATION_URL = "https://docs.devin.ai/cli";

/** The slug that means "keep the session's current model" (see devinAcp.ts). */
export const DEVIN_DEFAULT_MODEL_SLUG = "default";

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_DEFAULT_MODEL_SLUG,
    name: "Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/** Devin instance snapshots never offer application text generation. */
const withDevinSnapshotDefaults = (draft: ServerProviderDraft): ServerProviderDraft => ({
  ...draft,
  supportsTextGeneration: false,
  // `devin auth logout` is a real sign-out (auth.ts runs it), so the logout
  // control stays available. It is set explicitly rather than left to the
  // UI's `canLogout ?? setup.canAuthenticate` fallback.
  auth: { ...draft.auth, canLogout: true },
  setup: {
    canAuthenticate: true,
    canInstall: false,
    documentationUrl: DEVIN_DOCUMENTATION_URL,
  },
});

function devinModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export const buildInitialDevinProviderSnapshot = Effect.fn("buildInitialDevinProviderSnapshot")(
  function* (devinSettings: DevinSettings) {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return withDevinSnapshotDefaults(
        buildServerProvider({
          presentation: DEVIN_PRESENTATION,
          enabled: false,
          checkedAt,
          models,
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Devin is disabled in T3 Code settings.",
          },
        }),
      );
    }

    return withDevinSnapshotDefaults(
      buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Devin availability...",
        },
      }),
    );
  },
);

const MAX_MODEL_ID_LENGTH = 256;
const MAX_COMMAND_NAME_LENGTH = 128;
const MAX_COMMAND_DESCRIPTION_LENGTH = 1_024;

/**
 * Models from the session's `model` config option. Values are Devin model
 * slugs (`swe-2-high`, `adaptive`, `claude-*`, ...); T3 keeps them verbatim —
 * they round trip back through `session/set_config_option`.
 */
export function devinModelsFromConfigOptions(
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

/** Slash commands Devin advertises via `available_commands_update`. */
export function devinSlashCommandsFromCommands(
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

/**
 * The directory Devin keeps `credentials.toml` and its local state in:
 * `$XDG_DATA_HOME/devin` when set to an absolute path, else
 * `~/.local/share/devin`.
 */
export const devinDataDirPath = Effect.fn("devinDataDirPath")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const dataHome = nonEmptyTrimmed(environment["XDG_DATA_HOME"]);
  if (dataHome !== undefined && path.isAbsolute(dataHome)) {
    return path.join(dataHome, "devin");
  }
  return path.join(yield* HostProcess.HomeDirectory, ".local", "share", "devin");
});

/**
 * True when `credentials.toml` exists under the Devin data dir. The file is
 * the store `devin auth login` writes and `devin auth logout` removes, so
 * presence is the strongest local sign-in signal available without parsing
 * its contents.
 */
export const devinCredentialFilePresent = Effect.fn("devinCredentialFilePresent")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataDir = yield* devinDataDirPath(environment);
  return yield* fileSystem
    .exists(path.join(dataDir, "credentials.toml"))
    .pipe(Effect.orElseSucceed(() => false));
});

/**
 * Credentials Devin accepts from the environment ("fall back to env vars and
 * stored CLI credentials"): `WINDSURF_API_KEY` identifies a session outright,
 * and `OPENAI_API_KEY` covers a non-default `ACP_BACKEND`.
 */
const devinEnvCredentialsPresent = (environment: NodeJS.ProcessEnv): boolean =>
  nonEmptyTrimmed(environment["WINDSURF_API_KEY"]) !== undefined ||
  (nonEmptyTrimmed(environment["ACP_BACKEND"]) !== undefined &&
    nonEmptyTrimmed(environment["OPENAI_API_KEY"]) !== undefined);

const runDevinCliCommand = Effect.fn("runDevinCliCommand")(function* (
  devinSettings: Pick<DevinSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = nonEmptyTrimmed(devinSettings.binaryPath) ?? DEVIN_CLI_BIN;
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

interface DevinAcpProbeResult {
  readonly authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod>;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/** The surface the disposable session probe actually exercises. */
type DevinProbeRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "handleSessionUpdate" | "start"
>;

export interface DevinStatusProbeOptions {
  /**
   * Overrides the disposable ACP session the probe opens; tests substitute a
   * fake `devin acp`. The default spawns the real binary and never
   * authenticates.
   */
  readonly makeRuntime?: (input: {
    readonly settings: DevinSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
  }) => Effect.Effect<
    DevinProbeRuntime,
    EffectAcpErrors.AcpError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  >;
}

/**
 * One disposable `initialize` + `session/new` round trip: `session/new`
 * reports the `model` config option, and a short grace period lets a late
 * `available_commands_update` land. It proves nothing about sign-in — Devin
 * creates sessions without credentials (verified live).
 */
const discoverDevinMetadataViaAcp = Effect.fn("discoverDevinMetadataViaAcp")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  makeRuntime: NonNullable<DevinStatusProbeOptions["makeRuntime"]>,
) {
  const acp = yield* makeRuntime({ settings: devinSettings, environment, cwd });
  const commandsRef = yield* Ref.make<ReadonlyArray<ServerProviderSlashCommand>>([]);
  const commandsAdvertised = yield* Deferred.make<void>();
  yield* acp.handleSessionUpdate((notification) =>
    notification.update.sessionUpdate === "available_commands_update"
      ? Ref.set(
          commandsRef,
          devinSlashCommandsFromCommands(notification.update.availableCommands),
        ).pipe(Effect.andThen(Deferred.succeed(commandsAdvertised, undefined)), Effect.asVoid)
      : Effect.void,
  );
  const started = yield* acp.start();
  yield* Deferred.await(commandsAdvertised).pipe(Effect.timeoutOption(COMMAND_ADVERTISEMENT_GRACE));
  return {
    authMethods: started.initializeResult.authMethods ?? [],
    models: devinModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
    slashCommands: yield* Ref.get(commandsRef),
  } satisfies DevinAcpProbeResult;
}, Effect.scoped);

const isAcpAuthRequired = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "AcpRequestError" &&
  (error as { readonly code?: unknown }).code === -32000;

const makeDevinProbeRuntime = (input: {
  readonly settings: DevinSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}) =>
  makeDevinAcpRuntime({
    settings: input.settings,
    environment: input.environment,
    cwd: input.cwd,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    authenticateOnAuthRequired: false,
  });

type DevinCliAuthState = "authenticated" | "unauthenticated" | "unknown";

/**
 * `devin auth status` exits 0 whether or not the user is signed in (verified
 * live), so only its text carries the verdict: `Logged in (via Devin).` vs
 * `Not logged in.` Anything else — or a failed/timed-out invocation — is
 * inconclusive.
 */
const devinCliAuthState = (output: string): DevinCliAuthState => {
  const text = output.trimStart();
  if (text.startsWith("Logged in")) return "authenticated";
  if (text.startsWith("Not logged in")) return "unauthenticated";
  return "unknown";
};

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  probeOptions?: DevinStatusProbeOptions,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);
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
    withDevinSnapshotDefaults(
      buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: input.enabled,
        checkedAt,
        models: input.models ?? fallbackModels,
        ...(input.slashCommands ? { slashCommands: input.slashCommands } : {}),
        probe: input.probe,
      }),
    );

  if (!devinSettings.enabled) {
    return snapshot({
      enabled: false,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(devinSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return snapshot({
      enabled: devinSettings.enabled,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "The Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute the Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return snapshot({
      enabled: devinSettings.enabled,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The Devin CLI is installed but timed out while running `--version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return snapshot({
      enabled: devinSettings.enabled,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "The Devin CLI is installed but failed to run.",
      },
    });
  }

  // `devin auth status` can hit the network for team settings; the same
  // bound as the version probe keeps the whole status check fast, and an
  // inconclusive read falls back to the credentials file.
  const authStatusResult = yield* runDevinCliCommand(
    devinSettings,
    ["auth", "status"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);
  const authStatusOutput =
    Result.isSuccess(authStatusResult) &&
    Option.isSome(authStatusResult.success) &&
    authStatusResult.success.value.code === 0
      ? authStatusResult.success.value
      : undefined;
  const cliAuth = devinCliAuthState(
    authStatusOutput ? `${authStatusOutput.stdout}\n${authStatusOutput.stderr}` : "",
  );

  const credentialFile = yield* devinCredentialFilePresent(environment);
  const envCredentials = devinEnvCredentialsPresent(environment);

  // An explicit "Not logged in" outranks a stale credentials file; an
  // inconclusive CLI verdict falls back to file presence. Env keys can only
  // soften a signed-out answer to `unknown` — the ACP server's env fallback
  // means they may work, but nothing confirms it without a turn.
  const signedIn = cliAuth === "authenticated" || (cliAuth === "unknown" && credentialFile);
  const auth: ServerProviderAuth = signedIn
    ? { status: "authenticated", type: "devin", label: "Devin account" }
    : envCredentials
      ? { status: "unknown" }
      : { status: "unauthenticated" };

  const probeExit = yield* discoverDevinMetadataViaAcp(
    devinSettings,
    environment,
    cwd ?? process.cwd(),
    probeOptions?.makeRuntime ?? makeDevinProbeRuntime,
  ).pipe(Effect.timeoutOption(DEVIN_ACP_PROBE_TIMEOUT_MS), Effect.exit);
  const probe = Exit.isSuccess(probeExit) ? Option.getOrUndefined(probeExit.value) : undefined;
  const probeError = Exit.isFailure(probeExit)
    ? Option.getOrNull(Cause.findErrorOption(probeExit.cause))
    : null;
  const authRequired = isAcpAuthRequired(probeError);
  const probeFailed = probe === undefined;
  if (probeFailed) {
    yield* Effect.logWarning("Devin ACP session probe failed or timed out.", {
      errorTag: Exit.isFailure(probeExit) ? causeErrorTag(probeExit.cause) : "Timeout",
    });
  }

  const discoveredModels = probe?.models ?? [];
  const models =
    discoveredModels.length > 0
      ? devinModelsFromSettings(devinSettings.customModels, discoveredModels)
      : fallbackModels;

  // ACP auth-required means the server itself demands `authenticate` (the
  // ACP_BACKEND host-managed mode) — a stronger signed-out signal than the
  // CLI text.
  const resolvedAuth: ServerProviderAuth = authRequired ? { status: "unauthenticated" } : auth;

  if (resolvedAuth.status === "unauthenticated") {
    return snapshot({
      enabled: devinSettings.enabled,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: resolvedAuth,
        message:
          "Devin is not signed in. Sign in from provider settings or run `devin auth login`.",
      },
    });
  }

  return snapshot({
    enabled: devinSettings.enabled,
    models,
    slashCommands: probe?.slashCommands ?? [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed metadata probe degrades the model picker; a real turn may
      // still work, so it is a warning, not an outage.
      status: probeFailed ? "warning" : "ready",
      auth: resolvedAuth,
      ...(probeFailed
        ? {
            message:
              "The Devin CLI is installed but its ACP session probe failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichDevinSnapshot = (input: {
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
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
