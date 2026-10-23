// @effect-diagnostics nodeBuiltinImport:off - temp dirs for spawn-env file checks.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type RuntimeMode } from "@t3tools/contracts";
import { ZcodeSettings } from "@t3tools/provider-zcode/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_ENV,
  ZCODE_PROVIDER,
  ZcodeAdapterV2Driver,
  ZcodeProviderCapabilitiesV2,
  buildZcodeAcpSpawnInput,
  extractZcodeProposedPlanMarkdown,
  extractZcodeSubagentUpdate,
  makeZcodeAcpAdapterFlavor,
  zcodeAcpSpawnArgs,
  zcodePermissionDisposition,
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

    it("points the bridge at headless ZCODE_HOME provider config files it cannot find itself", () => {
      // The bridge's builtinProviderEnv() only knows desktop bundle paths, so
      // on a `~/.zcode` server install the backend gets no provider registry
      // and every turn fails "Select a model before continuing". T3 resolves
      // the well-known files itself — only when they exist and the caller has
      // not set the variable.
      const zcodeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-home-"));
      const builtin = NodePath.join(
        zcodeHome,
        "v2",
        "runtime",
        "provider",
        "bundled",
        "zcode-builtin.json",
      );
      const personal = NodePath.join(zcodeHome, "v2", "provider_config.json");
      NodeFS.mkdirSync(NodePath.dirname(builtin), { recursive: true });
      NodeFS.writeFileSync(builtin, "{}");
      NodeFS.writeFileSync(personal, "{}");

      const spawn = buildZcodeAcpSpawnInput(decodeZcodeSettings({}), "/workspace", {
        ZCODE_HOME: zcodeHome,
      });
      assert.equal(spawn.env?.[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV], builtin);
      assert.equal(spawn.env?.[ZCODE_PERSONAL_PROVIDER_CONFIG_ENV], personal);
    });

    it("skips missing provider config files and keeps caller-set overrides", () => {
      const emptyHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-empty-"));
      const empty = buildZcodeAcpSpawnInput(decodeZcodeSettings({}), "/workspace", {
        ZCODE_HOME: emptyHome,
      });
      assert.isUndefined(empty.env?.[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV]);
      assert.isUndefined(empty.env?.[ZCODE_PERSONAL_PROVIDER_CONFIG_ENV]);

      const zcodeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-home-"));
      const builtin = NodePath.join(
        zcodeHome,
        "v2",
        "runtime",
        "provider",
        "bundled",
        "zcode-builtin.json",
      );
      NodeFS.mkdirSync(NodePath.dirname(builtin), { recursive: true });
      NodeFS.writeFileSync(builtin, "{}");
      const overridden = buildZcodeAcpSpawnInput(decodeZcodeSettings({}), "/workspace", {
        ZCODE_HOME: zcodeHome,
        [ZCODE_PERSONAL_PROVIDER_CONFIG_ENV]: "/custom/personal.json",
      });
      assert.equal(overridden.env?.[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV], builtin);
      assert.equal(overridden.env?.[ZCODE_PERSONAL_PROVIDER_CONFIG_ENV], "/custom/personal.json");
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
    assert.isTrue(ZcodeProviderCapabilitiesV2.planning.emitsProposedPlan);
    assert.isTrue(ZcodeProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(ZcodeProviderCapabilitiesV2.subagents.emitsSubagentLifecycle);
    assert.isFalse(ZcodeProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.isTrue(ZcodeProviderCapabilitiesV2.checkpointing.providerCanReadConversationSnapshot);
    assert.isTrue(flavor.preferResumeSession);
    assert.isTrue(flavor.supportsCompaction);
    assert.isTrue(flavor.supportsImagePrompts);
    assert.isTrue(flavor.enablePostSettleContinuation);
  });

  describe("permission disposition", () => {
    const policy = (
      runtimeMode: RuntimeMode,
      overrides: { approvalPolicy?: unknown; sandboxPolicy?: unknown } = {},
    ) =>
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "default",
        cwd: "/workspace",
        ...overrides,
      });
    const request = (kind?: string) => ({
      sessionId: "session-1",
      toolCall: { toolCallId: "call-1", ...(kind === undefined ? {} : { kind }) },
      options: [
        { optionId: "allow_once", kind: "allow_once" as const, name: "Allow" },
        { optionId: "reject_once", kind: "reject_once" as const, name: "Reject" },
      ],
    });

    it("escalates guarded-mode (auto) asks to the user instead of auto-allowing", () => {
      // ZCode guarded only asks about operations its own gate refused —
      // including kind-less ExitPlanMode prompts — so the generic "allow"
      // would silently collapse guarded into yolo.
      assert.equal(zcodePermissionDisposition(policy("auto"), request()), "ask");
      assert.equal(zcodePermissionDisposition(policy("auto"), request("execute")), "ask");
    });

    it("keeps the generic policy answer elsewhere", () => {
      // approval-required asks, full-access allows, auto-accept-edits gates
      // only non-mutation kinds.
      assert.equal(
        zcodePermissionDisposition(policy("approval-required"), request("execute")),
        "ask",
      );
      assert.equal(zcodePermissionDisposition(policy("full-access"), request("execute")), "allow");
      assert.equal(
        zcodePermissionDisposition(policy("auto-accept-edits"), request("execute")),
        "ask",
      );
      assert.equal(
        zcodePermissionDisposition(policy("auto-accept-edits"), request("edit")),
        "allow",
      );
    });

    it("honors explicit approval overrides under auto", () => {
      assert.equal(
        zcodePermissionDisposition(policy("auto", { approvalPolicy: "never" }), request()),
        "allow",
      );
    });
  });

  describe("session/update extraction", () => {
    const toolCall = (input: {
      toolName: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      status?: "pending" | "inProgress" | "completed" | "failed";
    }) => ({
      toolCallId: "call-1",
      status: input.status ?? "completed",
      data: {
        toolCallId: "call-1",
        meta: { claudeCode: { toolName: input.toolName } },
        ...(input.rawInput === undefined ? {} : { rawInput: input.rawInput }),
        ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
      },
    });

    it("surfaces a foreground Agent call as a subagent row", () => {
      const update = extractZcodeSubagentUpdate(
        toolCall({
          toolName: "Agent",
          rawInput: {
            prompt: "Map the codebase",
            description: "Explore repo",
            subagent_type: "explore",
          },
          status: "inProgress",
        }),
      );
      assert.deepEqual(update, {
        nativeTaskId: "call-1",
        prompt: "Map the codebase",
        title: "Explore repo",
        model: "explore",
        status: "running",
        childSessionId: null,
        result: null,
      });
      const finished = extractZcodeSubagentUpdate(
        toolCall({
          toolName: "Agent",
          rawInput: { prompt: "Map the codebase", description: "Explore repo" },
          rawOutput:
            "Found 3 modules.\nagentId: agent_abc123 (use SendMessage)\n<usage>subagent_tokens: 4\ntool_uses: 1\nduration_ms: 5</usage>",
          status: "completed",
        }),
      );
      assert.equal(finished?.status, "completed");
      assert.equal(finished?.result, "Found 3 modules.");
    });

    it("leaves background launches and non-agent tools as ordinary tool calls", () => {
      assert.isUndefined(
        extractZcodeSubagentUpdate(
          toolCall({ toolName: "Agent", rawInput: { prompt: "x", run_in_background: true } }),
        ),
      );
      assert.isUndefined(
        extractZcodeSubagentUpdate(toolCall({ toolName: "Bash", rawInput: { command: "ls" } })),
      );
      // A first-sighting result frame with no launch fields stays a tool card.
      assert.isUndefined(
        extractZcodeSubagentUpdate(toolCall({ toolName: "Agent", status: "completed" })),
      );
    });

    it("extracts ExitPlanMode plan markdown and nothing else", () => {
      assert.equal(
        extractZcodeProposedPlanMarkdown(
          toolCall({ toolName: "ExitPlanMode", rawInput: { plan: "# Plan\n\n1. Ship it" } }),
        ),
        "# Plan\n\n1. Ship it",
      );
      assert.isUndefined(
        extractZcodeProposedPlanMarkdown(toolCall({ toolName: "ExitPlanMode", rawInput: {} })),
      );
      assert.isUndefined(
        extractZcodeProposedPlanMarkdown(
          toolCall({ toolName: "Agent", rawInput: { plan: "not a plan" } }),
        ),
      );
    });
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

    it("maps the bridge's retryAfterMs onto a usage_limit resetAt", () => {
      // @effect-diagnostics-next-line globalDate:off - asserting a wall-clock deadline
      const before = Date.now();
      const failure = zcodePromptFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "ZCode turn failed: quota exceeded",
          data: {
            type: "zcode_turn_failed",
            code: "rate_limit",
            statusCode: 429,
            retryable: true,
            retryAfterMs: 60_000,
          },
        }),
      );
      assert.equal(failure.class, "usage_limit");
      const resetAt = failure.resetAt;
      assert.isString(resetAt);
      const resetAtMillis = Date.parse(resetAt!);
      // @effect-diagnostics-next-line globalDate:off - asserting a wall-clock deadline
      assert.isTrue(resetAtMillis >= before + 60_000 && resetAtMillis <= Date.now() + 60_000);

      // Non-usage-limit failures keep retryAfterMs out of the failure payload.
      const providerError = zcodePromptFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "ZCode turn failed: backend crashed",
          data: { type: "zcode_turn_failed", statusCode: 500, retryAfterMs: 60_000 },
        }),
      );
      assert.equal(providerError.class, "provider_error");
      assert.isUndefined(providerError.resetAt);
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
