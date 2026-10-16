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
import { DevinSettings } from "../settings.ts";
import { checkDevinProviderStatus, type DevinStatusProbeOptions } from "./status.ts";

const settings = Schema.decodeSync(DevinSettings);

/**
 * Answers `--version` and `auth status`; the `auth status` text comes from
 * `DEVIN_FAKE_AUTH_STATUS` so a test can script both verdicts with one fake.
 */
const fakeDevin = (directory: string) =>
  writeFakeCli({
    directory,
    name: "devin",
    source: [
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version" || args[0] === "version") {',
      '  process.stdout.write("devin 3000.11.92 (7f4e64980e22)\\n");',
      '} else if (args[0] === "auth" && args[1] === "status") {',
      '  process.stdout.write(process.env.DEVIN_FAKE_AUTH_STATUS ?? "Not logged in.\\n");',
      "}",
    ].join("\n"),
  });

// A PATH that resolves `node` for the shebang launcher but no `devin` binary.
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
        agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-dev" },
        authMethods: [
          {
            id: "devin-browser",
            name: "Log in with browser",
            description: "Sign in via your browser",
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
            currentValue: "swe-2-high",
            options: [
              { value: "swe-2-high", name: "SWE 2 High" },
              { value: "adaptive", name: "Adaptive" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    }),
});

it.layer(NodeServices.layer)("Devin status", (it) => {
  it.effect("reports disabled without probing the CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(settings({}), { PATH: "" });
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.enabled).toBe(false);
    }),
  );

  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        settings({ enabled: true, binaryPath: "/definitely-missing/devin" }),
        { PATH: "" },
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("`devin`");
    }),
  );

  it.effect("reports unauthenticated when `devin auth status` says so", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-status-" });
        const xdgDataHome = path.join(directory, "xdg-data");
        const binary = fakeDevin(directory);
        const snapshot = yield* checkDevinProviderStatus(
          settings({ enabled: true, binaryPath: binary }),
          { PATH: nodeOnlyPath(), XDG_DATA_HOME: xdgDataHome },
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("3000.11.92");
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("devin auth login");
        expect(snapshot.supportsTextGeneration).toBe(false);
      }),
    ),
  );

  it.effect("softens a signed-out verdict to unknown when env credentials exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-status-" });
        const xdgDataHome = path.join(directory, "xdg-data");
        const binary = fakeDevin(directory);
        const probeOptions: DevinStatusProbeOptions = {
          makeRuntime: () => Effect.succeed(readyRuntime([])),
        };
        const snapshot = yield* checkDevinProviderStatus(
          settings({ enabled: true, binaryPath: binary }),
          {
            PATH: nodeOnlyPath(),
            XDG_DATA_HOME: xdgDataHome,
            WINDSURF_API_KEY: "wsk-test",
          },
          undefined,
          probeOptions,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("unknown");
      }),
    ),
  );

  it.effect("reads models and slash commands from the disposable session probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-status-" });
        const xdgDataHome = path.join(directory, "xdg-data");
        const binary = fakeDevin(directory);
        const probeOptions: DevinStatusProbeOptions = {
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
        const snapshot = yield* checkDevinProviderStatus(
          settings({ enabled: true, binaryPath: binary }),
          {
            PATH: nodeOnlyPath(),
            XDG_DATA_HOME: xdgDataHome,
            DEVIN_FAKE_AUTH_STATUS: "Logged in (via Devin).\n",
          },
          undefined,
          probeOptions,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth).toEqual({
          status: "authenticated",
          type: "devin",
          label: "Devin account",
          // `devin auth logout` is a real sign-out; the snapshot must say so.
          canLogout: true,
        });
        expect(snapshot.models.map((model) => model.slug)).toEqual(["swe-2-high", "adaptive"]);
        expect(snapshot.models[0]?.isDefault).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual([
          COMPACT_SLASH_COMMAND.name,
          "review",
        ]);
      }),
    ),
  );

  it.effect("treats credentials.toml under XDG_DATA_HOME as signed in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-status-" });
        const xdgDataHome = path.join(directory, "xdg-data");
        yield* fs.makeDirectory(path.join(xdgDataHome, "devin"), { recursive: true });
        yield* fs.writeFileString(path.join(xdgDataHome, "devin", "credentials.toml"), "");
        const binary = fakeDevin(directory);
        // `auth status` answers inconclusively; the credentials file carries
        // the verdict. ACP auth-required still wins over it.
        const probeOptions: DevinStatusProbeOptions = {
          makeRuntime: () =>
            Effect.fail(
              new EffectAcpErrors.AcpTransportError({
                detail: "probe inconclusive",
                cause: new Error("probe inconclusive"),
              }),
            ),
        };
        const snapshot = yield* checkDevinProviderStatus(
          settings({ enabled: true, binaryPath: binary }),
          {
            PATH: nodeOnlyPath(),
            XDG_DATA_HOME: xdgDataHome,
            DEVIN_FAKE_AUTH_STATUS: "unexpected output\n",
          },
          undefined,
          probeOptions,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.auth.status).toBe("authenticated");
      }),
    ),
  );

  it.effect("falls back to the default model and warning state when the probe fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-status-" });
        const binary = fakeDevin(directory);
        const probeOptions: DevinStatusProbeOptions = {
          makeRuntime: () =>
            Effect.fail(
              new EffectAcpErrors.AcpTransportError({
                detail: "agent exited",
                cause: new Error("agent exited"),
              }),
            ),
        };
        const snapshot = yield* checkDevinProviderStatus(
          settings({ enabled: true, binaryPath: binary }),
          {
            PATH: nodeOnlyPath(),
            XDG_DATA_HOME: path.join(directory, "xdg-data"),
            DEVIN_FAKE_AUTH_STATUS: "Logged in (via Devin).\n",
          },
          undefined,
          probeOptions,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
        expect(snapshot.message).toContain("session probe failed");
      }),
    ),
  );

  it.effect("reports unauthenticated when the probe hits ACP auth-required", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-status-" });
        const xdgDataHome = path.join(directory, "xdg-data");
        yield* fs.makeDirectory(path.join(xdgDataHome, "devin"), { recursive: true });
        yield* fs.writeFileString(path.join(xdgDataHome, "devin", "credentials.toml"), "");
        const binary = fakeDevin(directory);
        const probeOptions: DevinStatusProbeOptions = {
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
        const snapshot = yield* checkDevinProviderStatus(
          settings({ enabled: true, binaryPath: binary }),
          {
            PATH: nodeOnlyPath(),
            XDG_DATA_HOME: xdgDataHome,
            DEVIN_FAKE_AUTH_STATUS: "Logged in (via Devin).\n",
          },
          undefined,
          probeOptions,
        );
        // The ACP server's own auth demand outranks the CLI verdict.
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
      }),
    ),
  );

  it.effect("reads credentials.toml under ~/.local/share when XDG_DATA_HOME is unset", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-status-" });
        const home = path.join(directory, "home");
        const devinDir = path.join(home, ".local", "share", "devin");
        yield* fs.makeDirectory(devinDir, { recursive: true });
        yield* fs.writeFileString(path.join(devinDir, "credentials.toml"), "");
        const binary = fakeDevin(directory);
        const probeOptions: DevinStatusProbeOptions = {
          makeRuntime: () => Effect.succeed(readyRuntime([])),
        };
        const snapshot = yield* checkDevinProviderStatus(
          settings({ enabled: true, binaryPath: binary }),
          { PATH: nodeOnlyPath(), DEVIN_FAKE_AUTH_STATUS: "unexpected output\n" },
          undefined,
          probeOptions,
        ).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
        expect(snapshot.auth.status).toBe("authenticated");
      }),
    ),
  );
});
