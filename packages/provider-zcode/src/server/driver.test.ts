import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { ZcodeDriver } from "./driver.ts";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled ZCode must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled ZCode must not spawn a process"),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("ZcodeDriver", (it) => {
  it.effect("exposes its driver kind and an opt-in default config", () =>
    Effect.sync(() => {
      expect(ZcodeDriver.driverKind).toBe("zcode");
      const config = ZcodeDriver.defaultConfig();
      expect(config.enabled).toBe(false);
      expect(config.binaryPath).toBe("zcode-acp-server");
      expect(config.zcodeBinaryPath).toBe("");
      expect(config.customModels).toEqual([]);
    }),
  );

  it.effect.skipIf(windowsHost)("updates npm-installed bridges through npm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-zcode-driver-" });
      const binaryPath = path.join(
        tempDir,
        "lib",
        "node_modules",
        "zcode-acp-server",
        "dist",
        "cli.js",
      );
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* ZcodeDriver.create({
        instanceId: ProviderInstanceId.make("zcode-update"),
        displayName: "ZCode test",
        enabled: false,
        environment: [],
        config: { ...ZcodeDriver.defaultConfig(), binaryPath },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("zcode-acp-server");
      expect(capabilities.update?.executable).toBe("npm");
      expect(capabilities.update?.args).toEqual([
        "install",
        "-g",
        "--prefix",
        tempDir,
        "--allow-scripts=zcode-acp-server",
        "zcode-acp-server@latest",
      ]);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect("stays manual-only when the configured bridge does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-zcode-missing-" });
      const instance = yield* ZcodeDriver.create({
        instanceId: ProviderInstanceId.make("zcode-missing"),
        displayName: "ZCode test",
        enabled: false,
        environment: [],
        config: {
          ...ZcodeDriver.defaultConfig(),
          binaryPath: path.join(tempDir, "zcode-acp-server"),
        },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
