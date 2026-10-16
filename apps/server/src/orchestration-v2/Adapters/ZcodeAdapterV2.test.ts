import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type RuntimeMode } from "@t3tools/contracts";
import { ZcodeSettings } from "@t3tools/provider-zcode/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ZCODE_PROVIDER,
  ZcodeAdapterV2Driver,
  ZcodeProviderCapabilitiesV2,
  buildZcodeAcpSpawnInput,
  makeZcodeAcpAdapterFlavor,
  zcodeAcpSpawnArgs,
  zcodePromptFailure,
  zcodeSessionModeForPolicy,
} from "@t3tools/provider-zcode/testing";

const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);

const flavor = makeZcodeAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("zcode-test"),
  settings: decodeZcodeSettings({}),
  environment: {},
  selfInvocation: { command: "node", entrypoint: undefined },
  makeRuntime: () => Effect.die("not spawned in this test"),
});

describe("ZcodeAdapterV2", () => {
  it("exposes the ZCode driver kind and schema defaults", () => {
    assert.equal(ZcodeAdapterV2Driver.driverKind, ZCODE_PROVIDER);
    assert.deepEqual(ZcodeAdapterV2Driver.defaultConfig(), {
      enabled: false,
      binaryPath: "zcode-acp-server",
      zcodeBinaryPath: "",
      customModels: [],
    });
  });

  describe("bridge spawn", () => {
    // Both npm bin aliases share dist/cli.js; the bridge dispatches on
    // basename(argv[1]). The `zcode-acp-server` alias IS the stdio bridge, so
    // it takes no argv, while the generic `zcode-acp` shim needs `server`.
    it("runs the -server bin alias bare and other shims via the server subcommand", () => {
      assert.deepEqual(zcodeAcpSpawnArgs("zcode-acp-server"), []);
      assert.deepEqual(zcodeAcpSpawnArgs("/opt/zcode/bin/zcode-acp-server"), []);
      assert.deepEqual(zcodeAcpSpawnArgs("zcode-acp-server.cmd"), []);
      assert.deepEqual(zcodeAcpSpawnArgs("zcode-acp"), ["server"]);
      assert.deepEqual(zcodeAcpSpawnArgs("/opt/zcode/dist/cli.js"), ["server"]);
    });

    it("spawns the default bridge command and forwards ZCODE_BIN only when configured", () => {
      const settings = decodeZcodeSettings({});
      const spawn = buildZcodeAcpSpawnInput(settings, "/workspace", { PATH: "/usr/bin" });
      assert.equal(spawn.command, "zcode-acp-server");
      assert.deepEqual(spawn.args, []);
      assert.equal(spawn.cwd, "/workspace");
      assert.equal(spawn.env?.PATH, "/usr/bin");
      assert.isUndefined(spawn.env?.ZCODE_BIN);

      const configured = buildZcodeAcpSpawnInput(
        decodeZcodeSettings({
          binaryPath: "zcode-acp",
          zcodeBinaryPath: "/opt/zcode/bin/zcode",
        }),
        "/workspace",
        { PATH: "/usr/bin" },
      );
      assert.equal(configured.command, "zcode-acp");
      assert.deepEqual(configured.args, ["server"]);
      assert.equal(configured.env?.ZCODE_BIN, "/opt/zcode/bin/zcode");
    });
  });

  describe("session mode mapping", () => {
    // ZCode's session modes (bridge `buildModes`): plan/build/edit/guarded/yolo.
    const mode = (runtimeMode: RuntimeMode, interactionMode: "default" | "plan" = "default") =>
      zcodeSessionModeForPolicy(
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode,
          cwd: "/workspace",
        }),
      );

    it("maps every runtime mode onto an advertised ZCode mode", () => {
      assert.equal(mode("approval-required"), "build");
      assert.equal(mode("auto-accept-edits"), "edit");
      assert.equal(mode("auto"), "guarded");
      assert.equal(mode("full-access"), "yolo");
    });

    it("leaves plan interaction to the adapter's plan/build machinery", () => {
      // The adapter switches the session to the advertised `plan` mode itself
      // after recording the mode it restores on exit; sessionModeForPolicy
      // must keep reporting the underlying runtime mode as that restore point.
      assert.equal(mode("full-access", "plan"), "yolo");
      assert.equal(mode("approval-required", "plan"), "build");
    });
  });

  it("declares the optional ACP features the bridge supports", () => {
    assert.isTrue(ZcodeProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isFalse(ZcodeProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isTrue(ZcodeProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isTrue(ZcodeProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(ZcodeProviderCapabilitiesV2.checkpointing.providerCanReadConversationSnapshot);
    assert.isTrue(flavor.preferResumeSession);
    assert.isTrue(flavor.supportsCompaction);
    assert.isTrue(flavor.supportsImagePrompts);
  });

  describe("prompt failures", () => {
    it("preserves the bridge's turn-failure detail and retry hints", () => {
      const failure = zcodePromptFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "ZCode turn failed: rate limited",
          data: {
            type: "zcode_turn_failed",
            code: "model_request_failed",
            statusCode: 429,
            retryable: true,
          },
        }),
      );
      assert.equal(failure.class, "usage_limit");
      assert.equal(failure.code, "model_request_failed");
      assert.equal(failure.retryable, true);
      assert.equal(failure.message, "ZCode turn failed: rate limited");
    });

    it("keeps ordinary bridge and non-ACP errors as provider errors", () => {
      const plain = zcodePromptFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "ZCode turn failed: model offline",
        }),
      );
      assert.equal(plain.class, "provider_error");
      assert.equal(plain.code, "-32603");
      assert.equal(
        zcodePromptFailure(new Error("spawn zcode-acp-server ENOENT")).class,
        "provider_error",
      );
    });
  });
});
