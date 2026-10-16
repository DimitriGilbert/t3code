import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { ZcodeSettings } from "../settings.ts";
import { checkZcodeProviderStatus, type ZcodeStatusProbeOptions } from "./status.ts";

const settings = Schema.decodeSync(ZcodeSettings);

const fakeBridge = (
  directory: string,
  source = 'process.stdout.write("zcode-acp-server 0.72.0\\n");',
) => writeFakeCli({ directory, name: "zcode-acp-server", source });

// A PATH that resolves `node` for the shebang launcher but no `zcode` binary.
const nodeOnlyPath = () => process.execPath.replace(/[/\\][^/\\]+$/, "");

const readyRuntime = (commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>) => ({
  handleSessionUpdate: (
    handler: (
      notification: EffectAcpSchema.SessionNotification,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>,
  ) =>
    handler({
      sessionId: "probe-session",
      update: { sessionUpdate: "available_commands_update", availableCommands: commands },
    }).pipe(Effect.ignore),
  start: () =>
    Effect.succeed({
      sessionId: "probe-session",
      initializeResult: {
        protocolVersion: 1,
        info: { name: "zcode-acp-server", version: "0.72.0" },
        authMethods: [
          {
            id: "zcode-credentials",
            name: "ZCode",
            description: null,
            type: "agent" as const,
          },
        ],
      },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select" as const,
            currentValue: "builtin\\glm-5",
            options: [
              { value: "builtin\\glm-5", name: "GLM 5" },
              { value: "custom\\glm-4.6", name: "GLM 4.6" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    }),
});

it.layer(NodeServices.layer)("Zcode status", (it) => {
  it.effect("reports disabled without probing the bridge", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkZcodeProviderStatus(settings({}), { PATH: "" });
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.enabled).toBe(false);
    }),
  );

  it.effect("reports a missing bridge as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkZcodeProviderStatus(
        settings({ enabled: true, binaryPath: "/definitely-missing/zcode-acp-server" }),
        { PATH: "" },
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("zcode-acp-server");
    }),
  );

  it.effect("warns when the bridge is installed but no zcode backend resolves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-status-" });
        const zcodeHome = path.join(directory, "zcode-home");
        const bridge = fakeBridge(directory);
        const snapshot = yield* checkZcodeProviderStatus(
          settings({ enabled: true, binaryPath: bridge }),
          { PATH: nodeOnlyPath(), ZCODE_HOME: zcodeHome },
        ).pipe(Effect.provideService(HostProcess.HomeDirectory, path.join(directory, "home")));
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("0.72.0");
        expect(snapshot.status).toBe("warning");
        expect(snapshot.message).toContain("`zcode`");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.supportsTextGeneration).toBe(false);
      }),
    ),
  );

  it.effect("reports unauthenticated when the probe hits auth-required", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-status-" });
        const zcodeHome = path.join(directory, "zcode-home");
        const bridge = fakeBridge(directory);
        const backend = writeFakeCli({ directory, name: "zcode", source: "" });
        const probeOptions: ZcodeStatusProbeOptions = {
          makeRuntime: () =>
            Effect.succeed({
              handleSessionUpdate: () => Effect.void,
              start: () =>
                Effect.fail(
                  new EffectAcpErrors.AcpRequestError({
                    code: -32000,
                    errorMessage: "Authentication required",
                  }),
                ),
            }),
        };
        const snapshot = yield* checkZcodeProviderStatus(
          settings({ enabled: true, binaryPath: bridge, zcodeBinaryPath: backend }),
          { PATH: nodeOnlyPath(), ZCODE_HOME: zcodeHome },
          undefined,
          probeOptions,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("zcode login");
      }),
    ),
  );

  it.effect("reads models and slash commands from the disposable session probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-status-" });
        const zcodeHome = path.join(directory, "zcode-home");
        yield* fs.makeDirectory(path.join(zcodeHome, "v2"), { recursive: true });
        yield* fs.writeFileString(path.join(zcodeHome, "v2", "config.json"), "{}");
        const bridge = fakeBridge(directory);
        const backend = writeFakeCli({ directory, name: "zcode", source: "" });
        const probeOptions: ZcodeStatusProbeOptions = {
          makeRuntime: () =>
            Effect.succeed(
              readyRuntime([
                {
                  name: "review",
                  description: "Review the current diff",
                  input: { type: "text" as const, hint: "files" },
                },
              ]),
            ),
        };
        const snapshot = yield* checkZcodeProviderStatus(
          settings({ enabled: true, binaryPath: bridge, zcodeBinaryPath: backend }),
          { PATH: nodeOnlyPath(), ZCODE_HOME: zcodeHome },
          undefined,
          probeOptions,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth).toEqual({
          status: "authenticated",
          type: "zcode",
          label: "ZCode account",
          // ZCode has no remote sign-out; the snapshot must say so instead of
          // letting the UI fall back to setup.canAuthenticate.
          canLogout: false,
        });
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "builtin\\glm-5",
          "custom\\glm-4.6",
        ]);
        expect(snapshot.models[0]?.isDefault).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
          COMPACT_SLASH_COMMAND.name,
          "review",
        ]);
      }),
    ),
  );

  it.effect("falls back to the default model and unknown auth when the probe fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-status-" });
        const zcodeHome = path.join(directory, "zcode-home");
        yield* fs.makeDirectory(path.join(zcodeHome, "v2"), { recursive: true });
        yield* fs.writeFileString(path.join(zcodeHome, "v2", "credentials.json"), "{}");
        const bridge = fakeBridge(directory);
        const backend = writeFakeCli({ directory, name: "zcode", source: "" });
        const probeOptions: ZcodeStatusProbeOptions = {
          makeRuntime: () =>
            Effect.fail(
              new EffectAcpErrors.AcpTransportError({
                detail: "backend exited",
                cause: new Error("backend exited"),
              }),
            ),
        };
        const snapshot = yield* checkZcodeProviderStatus(
          settings({ enabled: true, binaryPath: bridge, zcodeBinaryPath: backend }),
          { PATH: nodeOnlyPath(), ZCODE_HOME: zcodeHome },
          undefined,
          probeOptions,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
        expect(snapshot.message).toContain("session probe failed");
      }),
    ),
  );
});
