/**
 * ZcodeDriver — `ProviderDriver` for ZCode through a spawned
 * `zcode app-server --stdio` process (ZCode Protocol v4). Credentials live
 * under `~/.zcode`; auth offers saved-credential adoption plus `zcode login`.
 *
 * @module provider-zcode/server/driver
 */
import {
  AcpRegistryOperationError,
  ProviderSetupError,
  TextGenerationError,
} from "@t3tools/contracts";
import { ZcodeSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ZCodeClient from "@t3tools/effect-zcode-protocol/client";
import * as ZCodeRpc from "@t3tools/effect-zcode-protocol/rpc";
import * as ZCodeSchema from "@t3tools/effect-zcode-protocol/schema";
import { makeZcodeAdapterV2, type ZcodeAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialZcodeProviderSnapshot,
  checkZcodeProviderStatus,
  enrichZcodeSnapshot,
  probeZcodeWorkspaceCatalog,
  zcodeSlashCommandsFromWorkspaceConfig,
} from "./status.ts";
import { makeZcodeAuth } from "./auth.ts";
import { buildZcodeAppServerSpawnInput, openZcodeAppServerClient } from "./zcodeAppServer.ts";
import { ZCODE_PROVIDER } from "./driverKind.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);

const DRIVER_KIND = ZCODE_PROVIDER;
const ZCODE_NPM_PACKAGE = "zcode-cli";
// The bridge is only ever npm-installed (or a standalone binary the user
// dropped somewhere): package-manager ownership is proven from the resolved
// path, everything else stays manual. No `update` subcommand exists.
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: ZCODE_NPM_PACKAGE,
  nativeUpdate: null,
});

// The zcode backend's text helpers are not exposed over ACP, so instances
// never back application text generation; selectors read the snapshot flag.
const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ZCode does not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};

export type ZcodeDriverEnv =
  | ZcodeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

const isManagementError = Schema.is(AcpRegistryOperationError);

export const ZcodeDriver: ProviderDriver<ZcodeSettings, ZcodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ZCode",
    supportsMultipleInstances: true,
  },
  configSchema: ZcodeSettings,
  defaultConfig: (): ZcodeSettings => decodeZcodeSettings({}),
  create: Effect.fn("ZcodeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const { cwd } = host.paths;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies ZcodeSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const auth = yield* makeZcodeAuth({
      instanceId,
      settings: effectiveConfig,
      cwd,
      environment: processEnv,
      onChanged: (authenticated) =>
        snapshot.refresh.pipe(
          Effect.flatMap((provider) =>
            !authenticated || provider.auth.status === "authenticated"
              ? Effect.void
              : Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: provider.message ?? "Could not verify the ZCode sign-in. Try again.",
                  }),
                ),
          ),
        ),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the ZCode auth controller.",
            cause,
          }),
      ),
    );

    // Live workspace-config catalogs pushed by the adapter's sessions; keyed
    // by workspaceId (the session's cwd). readPresentation probes stay the
    // cold path; these win once a live session seeds the real catalog.
    const liveWorkspaceConfigs = new Map<string, ZCodeSchema.WorkspaceConfigState>();

    const orchestrationAdapter = yield* makeZcodeAdapterV2({
      instanceId,
      settings: effectiveConfig,
      environment: processEnv,
      onWorkspaceConfig: (workspaceId, state) =>
        Effect.sync(() => {
          liveWorkspaceConfigs.set(workspaceId, state);
        }),
      resolveAttachmentPath: host.resolveAttachmentPath,
      resolveExtractedTextPath: host.resolveExtractedTextPath,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build ZCode orchestration adapter.",
            cause,
          }),
      ),
    );

    const checkProvider = checkZcodeProviderStatus(effectiveConfig, processEnv, cwd).pipe(
      Effect.map(stampIdentity),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ZcodeSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialZcodeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichZcodeSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build ZCode snapshot.",
            cause,
          }),
      ),
    );

    const managementError =
      (operation: string, reason: AcpRegistryOperationError["reason"]) => (cause: unknown) =>
        new AcpRegistryOperationError({
          reason,
          message: `ZCode ${operation} failed.`,
          cause,
        });

    // Disposable app-server for session management; requests self-gate on the
    // storage gate so no handshake work is needed before session/list.
    const withManagementClient = <A>(
      cwd: string,
      use: (
        client: ZCodeClient.ZCodeAppServerClient["Service"],
      ) => Effect.Effect<A, AcpRegistryOperationError>,
      operation: string,
    ): Effect.Effect<A, AcpRegistryOperationError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawnInput = buildZcodeAppServerSpawnInput(effectiveConfig, cwd, processEnv);
          const client = yield* openZcodeAppServerClient({
            command: spawnInput.command,
            args: spawnInput.args,
            cwd: spawnInput.cwd,
            env: spawnInput.env,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          return yield* use(client);
        }),
      ).pipe(
        Effect.timeoutOption("20 seconds"),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new AcpRegistryOperationError({
                  reason: "session_list_unsupported",
                  message: `ZCode ${operation} timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isManagementError(cause)
            ? cause
            : managementError(operation, "session_list_unsupported")(cause),
        ),
      );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth,
      snapshot,
      snapshotForCwd: (cwd) =>
        (!effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.gen(function* () {
              const machineSnapshot = yield* snapshot.getSnapshot;
              const probed = yield* Effect.scoped(
                Effect.gen(function* () {
                  const spawnInput = buildZcodeAppServerSpawnInput(
                    effectiveConfig,
                    cwd,
                    processEnv,
                  );
                  const client = yield* openZcodeAppServerClient({
                    command: spawnInput.command,
                    args: spawnInput.args,
                    cwd: spawnInput.cwd,
                    env: spawnInput.env,
                  });
                  return yield* probeZcodeWorkspaceCatalog(client, cwd);
                }),
              ).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.timeoutOption("20 seconds"),
                Effect.option,
                Effect.map(Option.flatten),
                Effect.map(Option.getOrUndefined),
              );
              const live = liveWorkspaceConfigs.get(cwd);
              const slashCommands =
                live !== undefined
                  ? zcodeSlashCommandsFromWorkspaceConfig(live.slashCommands)
                  : probed?.slashCommands;
              return {
                ...machineSnapshot,
                skills: probed?.skills ?? machineSnapshot.skills,
                ...(slashCommands === undefined ? {} : { slashCommands }),
                // A probe that never answered leaves command discovery pending.
                ...(probed === undefined && live === undefined
                  ? { slashCommandsPending: true as const }
                  : {}),
              };
            })
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to probe the ZCode workspace catalog for '${cwd}'`,
                cause,
              }),
          ),
        ),
      acpSessionManagement: {
        listSessions: ({ cwd }) =>
          withManagementClient(
            cwd,
            (client) =>
              client
                .request(ZCodeRpc.LEGACY_METHODS.sessionList, {
                  workspace: { workspacePath: cwd, workspaceKey: cwd },
                })
                .pipe(
                  Effect.map((result) => ({
                    sessions: result.sessions.map((session) => ({
                      sessionId: session.sessionId,
                      cwd: session.workspace.workspacePath,
                      additionalDirectories: [],
                      title: session.title === "" ? null : session.title,
                      updatedAt: Option.match(DateTime.make(session.updatedAt), {
                        onNone: () => null,
                        onSome: DateTime.formatIso,
                      }),
                      importedThreadId: null,
                    })),
                    nextCursor: null,
                    canLoad: true,
                    canResume: true,
                    canDelete: true,
                  })),
                  Effect.mapError(managementError("session list", "session_import_failed")),
                ),
            "session list",
          ),
        deleteSession: ({ cwd, sessionId }) =>
          withManagementClient(
            cwd,
            (client) =>
              Effect.gen(function* () {
                const ack = yield* client
                  .request(
                    ZCodeRpc.V4_METHODS.command,
                    ZCodeSchema.makeCommandEnvelope({
                      commandId: yield* Effect.orDie(crypto.randomUUIDv7()),
                      clientId: `t3-${instanceId}-session-management`,
                      sessionId,
                      issuedAt: DateTime.toEpochMillis(yield* DateTime.now),
                      type: "deleteSession",
                      payload: {},
                    }),
                  )
                  .pipe(
                    Effect.mapError(managementError("session delete", "session_delete_failed")),
                  );
                if (
                  ack.status !== "accepted" &&
                  ack.status !== "duplicate" &&
                  ack.status !== "noop"
                ) {
                  return yield* new AcpRegistryOperationError({
                    reason: "session_delete_failed",
                    message: `ZCode rejected deleteSession: ${ack.status}${ack.message === undefined ? "" : ` (${ack.message})`}`,
                  });
                }
              }),
            "session delete",
          ),
        logout: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "logout_unsupported",
              message:
                "ZCode has no remote sign-out. Remove the credentials under ~/.zcode/v2 or sign out in the ZCode desktop app.",
            }),
          ),
        listProviders: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "providers_unsupported",
              message: "ZCode providers are managed by the ZCode CLI, not by T3 Code.",
            }),
          ),
        setProvider: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "provider_configuration_failed",
              message: "ZCode providers are managed by the ZCode CLI, not by T3 Code.",
            }),
          ),
        disableProvider: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "provider_configuration_failed",
              message: "ZCode providers are managed by the ZCode CLI, not by T3 Code.",
            }),
          ),
      },
      orchestrationAdapter,
      textGeneration: makeUnsupportedTextGeneration(),
    } satisfies ProviderInstance;
  }),
};
