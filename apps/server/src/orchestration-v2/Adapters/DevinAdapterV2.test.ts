import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type RuntimeMode } from "@t3tools/contracts";
import { DevinSettings } from "@t3tools/provider-devin/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  DEVIN_ACP_AUTH_METHOD_ID,
  DEVIN_PROVIDER,
  DevinAdapterV2Driver,
  DevinProviderCapabilitiesV2,
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  devinPermissionDisposition,
  devinPromptFailure,
  devinSessionModeForPolicy,
  extractDevinSubagentUpdate,
  makeDevinAcpAdapterFlavor,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "@t3tools/provider-devin/testing";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const flavor = makeDevinAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("devin-test"),
  settings: decodeDevinSettings({}),
  environment: {},
  selfInvocation: { command: "node", entrypoint: undefined },
  makeRuntime: () => Effect.die("not spawned in this test"),
});

describe("DevinAdapterV2", () => {
  it("declares the devin driver kind with schema defaults", () => {
    assert.equal(DevinAdapterV2Driver.driverKind, DEVIN_PROVIDER);
    assert.deepEqual(DevinAdapterV2Driver.defaultConfig(), {
      enabled: false,
      binaryPath: "devin",
      customModels: [],
    });
  });

  describe("spawn", () => {
    // `devin acp` is the first-party ACP server — no bridge, no wrapper args.
    it("runs the devin binary with the acp subcommand", () => {
      const spawn = buildDevinAcpSpawnInput(decodeDevinSettings({}), "/workspace", {
        PATH: "/usr/bin",
      });
      assert.equal(spawn.command, "devin");
      assert.deepEqual(spawn.args, ["acp"]);
      assert.equal(spawn.cwd, "/workspace");
      assert.equal(spawn.env?.PATH, "/usr/bin");
      assert.equal(DEVIN_ACP_AUTH_METHOD_ID, "devin-browser");
    });

    it("honors a binaryPath override", () => {
      const spawn = buildDevinAcpSpawnInput(
        decodeDevinSettings({ binaryPath: "/opt/devin/bin/devin" }),
        "/workspace",
      );
      assert.equal(spawn.command, "/opt/devin/bin/devin");
      assert.deepEqual(spawn.args, ["acp"]);
    });
  });

  describe("session mode mapping", () => {
    // Devin's ACP session modes: accept-edits|smart|ask|plan|bypass. The CLI's
    // `--permission-mode auto` (prompt-for-everything) is not selectable over
    // ACP — `set_config_option mode:"auto"` is silently ignored (verified
    // live) — so approval-required lands on the strictest selectable coding
    // mode, accept-edits, which still gates shell and dangerous operations.
    const mode = (runtimeMode: RuntimeMode, interactionMode: "default" | "plan" = "default") =>
      devinSessionModeForPolicy(
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode,
          cwd: "/workspace",
        }),
      );

    it("maps every runtime mode onto an advertised Devin mode", () => {
      assert.equal(mode("approval-required"), "accept-edits");
      assert.equal(mode("auto-accept-edits"), "accept-edits");
      assert.equal(mode("auto"), "smart");
      assert.equal(mode("full-access"), "bypass");
    });

    it("leaves plan interaction to the adapter's plan/build machinery", () => {
      // The adapter switches the session to the advertised `plan` mode itself
      // after recording the mode it restores on exit; sessionModeForPolicy
      // must keep reporting the underlying runtime mode as that restore point.
      assert.equal(mode("full-access", "plan"), "bypass");
      assert.equal(mode("approval-required", "plan"), "accept-edits");
    });
  });

  it("declares the optional ACP features Devin supports", () => {
    assert.isTrue(DevinProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isFalse(DevinProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isTrue(DevinProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isTrue(DevinProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(DevinProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(DevinProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.isTrue(DevinProviderCapabilitiesV2.subagents.emitsSubagentLifecycle);
    assert.isTrue(DevinProviderCapabilitiesV2.checkpointing.providerCanReadConversationSnapshot);
    assert.isTrue(flavor.preferResumeSession);
    assert.isTrue(flavor.supportsCompaction);
    assert.isTrue(flavor.supportsImagePrompts);
  });

  it("opts Devin into its typed session surface like the registry devin case", () => {
    // Same wiring the ACP Registry applies to agentId "devin": the typed
    // capabilities unlock subagent routing and grouped message ids, and the
    // normalizers read that metadata back.
    assert.deepEqual(flavor.clientCapabilitiesMeta, {
      "cognition.ai/subagentSupport": true,
      "cognition.ai/messageGrouping": true,
    });
    assert.strictEqual(flavor.normalizeSessionUpdate, normalizeDevinSessionUpdate);
    assert.strictEqual(flavor.normalizeToolCall, normalizeDevinToolCall);
    assert.strictEqual(flavor.extractSubagentUpdate, extractDevinSubagentUpdate);
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

    it("escalates smart-mode (auto) asks to the user instead of auto-allowing", () => {
      // Devin smart only asks about operations its own gate refused, so the
      // generic "allow" would silently collapse smart into bypass.
      assert.equal(devinPermissionDisposition(policy("auto"), request()), "ask");
      assert.equal(devinPermissionDisposition(policy("auto"), request("execute")), "ask");
    });

    it("keeps the generic policy answer elsewhere", () => {
      // approval-required asks, full-access allows, auto-accept-edits gates
      // only non-mutation kinds.
      assert.equal(
        devinPermissionDisposition(policy("approval-required"), request("execute")),
        "ask",
      );
      assert.equal(devinPermissionDisposition(policy("full-access"), request("execute")), "allow");
      assert.equal(
        devinPermissionDisposition(policy("auto-accept-edits"), request("execute")),
        "ask",
      );
      assert.equal(
        devinPermissionDisposition(policy("auto-accept-edits"), request("edit")),
        "allow",
      );
    });

    it("honors explicit approval overrides under auto", () => {
      assert.equal(
        devinPermissionDisposition(policy("auto", { approvalPolicy: "never" }), request()),
        "allow",
      );
    });
  });

  describe("session/update extraction", () => {
    const toolCall = (input: {
      meta?: unknown;
      title?: string;
      status?: "pending" | "inProgress" | "completed" | "failed";
    }) => ({
      toolCallId: "call-1",
      status: input.status ?? "completed",
      ...(input.title === undefined ? {} : { title: input.title }),
      data: { toolCallId: "call-1", ...(input.meta === undefined ? {} : { meta: input.meta }) },
    });

    it("routes child-session chunks and folds grouped stream ids", () => {
      const notification = normalizeDevinSessionUpdate({
        sessionId: "root",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
          _meta: {
            "cognition.ai/subagent_context": { parentAgentId: "child-a" },
            "cognition.ai/streamingMessageId": "msg-1",
          },
        },
      });
      assert.equal(notification.sessionId, "child-a");
      assert.equal((notification.update as { messageId?: string }).messageId, "msg-1");
      // "root" parent context stays on the root session.
      const root = normalizeDevinSessionUpdate({
        sessionId: "root",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
          _meta: { "cognition.ai/subagent_context": { parentAgentId: "root" } },
        },
      });
      assert.equal(root.sessionId, "root");
    });

    it("titles generic tool calls from cognition.ai/inferenceToolName", () => {
      const named = normalizeDevinToolCall(
        toolCall({ title: "Tool", meta: { "cognition.ai/inferenceToolName": "read_file" } }),
      );
      assert.equal(named.title, "read_file");
      const kept = normalizeDevinToolCall(
        toolCall({ title: "Read", meta: { "cognition.ai/inferenceToolName": "read_file" } }),
      );
      assert.equal(kept.title, "Read");
    });

    it("surfaces subagent_started/completed as subagent rows on the child session", () => {
      const running = extractDevinSubagentUpdate(
        toolCall({
          status: "inProgress",
          meta: {
            "cognition.ai/subagent_started": {
              agentId: "child-a",
              task: "Write audit.py",
              title: "Write audit script",
            },
          },
        }),
      );
      assert.deepEqual(running, {
        nativeTaskId: "child-a",
        childSessionId: "child-a",
        prompt: "Write audit.py",
        title: "Write audit script",
        model: null,
        status: "running",
        result: null,
      });
      const completed = extractDevinSubagentUpdate(
        toolCall({
          meta: {
            "cognition.ai/subagent_completed": {
              agentId: "child-a",
              success: true,
              summary: "Wrote audit.py",
            },
          },
        }),
      );
      assert.equal(completed?.status, "completed");
      assert.equal(completed?.result, "Wrote audit.py");
      assert.isUndefined(extractDevinSubagentUpdate(toolCall({})));
    });
  });

  describe("model selection", () => {
    const modelOption = (currentValue: string) => ({
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue,
      options: [
        { value: "swe-2-high", name: "SWE-2" },
        { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5" },
      ],
    });
    const runtime = (options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) => {
      const setCalls: Array<string> = [];
      return {
        setCalls,
        runtime: {
          getConfigOptions: Effect.succeed(options),
          setModel: (model: string) => Effect.sync(() => setCalls.push(model)),
        },
      };
    };

    it.effect("applies a picked model through the model config option", () =>
      Effect.gen(function* () {
        const stub = runtime([modelOption("swe-2-high")]);
        const applied = yield* applyDevinAcpModelSelection({
          runtime: stub.runtime,
          requestedModelId: "claude-opus-5-5-medium",
          mapError: (cause) => cause,
        });
        assert.equal(applied, "claude-opus-5-5-medium");
        assert.deepEqual(stub.setCalls, ["claude-opus-5-5-medium"]);
      }),
    );

    it.effect("keeps the session model for pass-through slugs and repeats", () =>
      Effect.gen(function* () {
        const stub = runtime([modelOption("swe-2-high")]);
        for (const requested of [undefined, "", "default", "auto", "swe-2-high"]) {
          const applied = yield* applyDevinAcpModelSelection({
            runtime: stub.runtime,
            requestedModelId: requested,
            mapError: (cause) => cause,
          });
          assert.equal(applied, "swe-2-high");
        }
        assert.deepEqual(stub.setCalls, []);
      }),
    );

    it.effect("does nothing when Devin advertises no model option", () =>
      Effect.gen(function* () {
        const stub = runtime([]);
        const applied = yield* applyDevinAcpModelSelection({
          runtime: stub.runtime,
          requestedModelId: "claude-opus-5-5-medium",
          mapError: (cause) => cause,
        });
        assert.isUndefined(applied);
        assert.deepEqual(stub.setCalls, []);
      }),
    );
  });

  describe("prompt failures", () => {
    // Verified live: `session/prompt` on an unknown session answers
    // `code: -32016, data: {"cognition.ai/errorKind": "session_not_found",
    // "cognition.ai/retryable": false}`.
    it("surfaces Devin's cognition.ai errorKind and retryable hint", () => {
      const failure = devinPromptFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32016,
          errorMessage: "Session not found",
          data: {
            "cognition.ai/errorKind": "session_not_found",
            "cognition.ai/retryable": false,
          },
        }),
      );
      assert.equal(failure.class, "provider_error");
      assert.equal(failure.code, "session_not_found");
      assert.equal(failure.retryable, false);
      assert.equal(failure.message, "Session not found");
    });

    it("keeps plain ACP and non-ACP errors as provider errors", () => {
      const plain = devinPromptFailure(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Devin turn failed",
        }),
      );
      assert.equal(plain.class, "provider_error");
      assert.equal(plain.code, "-32603");
      assert.equal(devinPromptFailure(new Error("spawn devin ENOENT")).class, "provider_error");
    });
  });
});
