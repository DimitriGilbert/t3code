/**
 * Launch and lifecycle support for the Devin ACP server (`devin acp`): spawn
 * argv/env, the browser auth method, and process-group ownership.
 *
 * @module provider-devin/server/devinAcp
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { DevinSettings } from "../settings.ts";

/** Devin's only advertised auth method: a browser sign-in flow. */
export const DEVIN_ACP_AUTH_METHOD_ID = "devin-browser";

/** The `devin` CLI binary; its `acp` subcommand is the stdio ACP server. */
export const DEVIN_CLI_BIN = "devin";

type DevinAcpRuntimeSettings = Pick<DevinSettings, "binaryPath">;

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly settings: DevinAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * `devin acp` is the ACP server — a single binary with no wrapper or config
 * env vars; Devin reads its own credentials file and model catalog. The
 * `--agent-type`, `--model`, and `--cloud` launch flags stay off: session
 * configuration rides `session/set_config_option`.
 */
export function buildDevinAcpSpawnInput(
  settings: DevinAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || DEVIN_CLI_BIN,
    args: ["acp"],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

export function devinAcpRuntimeProcessOwnership(
  processGroupPlatform: NodeJS.Platform,
): Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "ownDescendantProcessGroups" | "ownDetachedProcessGroup" | "processGroupPlatform"
> {
  // `devin acp` is a single binary but spawns tool subprocesses and child
  // agents, so Stop must reach the whole group or detached work survives.
  // Same caveat as Grok: descendant tracking rides the linux cgroup ledger
  // only until a stable identity provider covers nested detached groups on
  // macOS.
  return {
    ownDescendantProcessGroups: processGroupPlatform === "linux",
    ownDetachedProcessGroup: true,
    processGroupPlatform,
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const processGroupPlatform = yield* HostProcess.Platform.pipe(
      Effect.provide(NodeServices.layer),
    );
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.settings, input.cwd, input.environment),
        authMethodId: DEVIN_ACP_AUTH_METHOD_ID,
        ...devinAcpRuntimeProcessOwnership(processGroupPlatform),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Applies the model picker through Devin's `model` config option
 * (`session/set_config_option`; `runtime.setModel` resolves the option id).
 * Values are Devin model slugs (`swe-2-high`, `adaptive`, `claude-*`, ...).
 * The `default`/`auto` slugs mean "keep the session's current model" and are
 * never sent. Returns the model the session now runs on, or undefined when
 * Devin advertises no model option.
 */
export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setModel"
  >;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelOption = configOptions.find((option) => option.category === "model");
    if (modelOption === undefined) {
      return undefined;
    }
    const currentModelId =
      modelOption.type === "select" && typeof modelOption.currentValue === "string"
        ? modelOption.currentValue
        : undefined;
    const requestedModelId = input.requestedModelId?.trim();
    if (
      requestedModelId === undefined ||
      requestedModelId === "" ||
      requestedModelId === "default" ||
      requestedModelId === "auto" ||
      requestedModelId === currentModelId
    ) {
      return currentModelId;
    }
    yield* input.runtime.setModel(requestedModelId).pipe(Effect.mapError(input.mapError));
    return requestedModelId;
  });
}
