/**
 * Launch and lifecycle support for the ZCode ACP bridge (`zcode-acp-server`,
 * npm package of the same name): spawn argv/env, the bridge auth method, and
 * process-group ownership.
 *
 * @module provider-zcode/server/zcodeAcp
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
import type { ZcodeSettings } from "../settings.ts";

/** The bridge's only auth method: credentials live under ~/.zcode, not in T3. */
export const ZCODE_ACP_AUTH_METHOD_ID = "zcode-credentials";

/** npm bin alias that runs the stdio ACP bridge directly. */
const ZCODE_ACP_SERVER_BIN = "zcode-acp-server";

/** Env var the bridge reads to locate the `zcode` backend binary. */
const ZCODE_BIN_ENV = "ZCODE_BIN";

type ZcodeAcpRuntimeSettings = Pick<ZcodeSettings, "binaryPath" | "zcodeBinaryPath">;

interface ZcodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly settings: ZcodeAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Bridge argv. Both npm bin aliases point at the same `dist/cli.js` and the
 * bridge picks its surface from `basename(argv[1])`: `zcode-acp-server` IS the
 * stdio ACP bridge, while bare `zcode-acp` opens its TUI. A `binaryPath`
 * resolved to the generic `zcode-acp` shim still reaches the server through
 * the explicit `server` subcommand, matching the CLI's own dispatch.
 */
export function zcodeAcpSpawnArgs(command: string): ReadonlyArray<string> {
  const invokedAs = command
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1)$/, "");
  return invokedAs === ZCODE_ACP_SERVER_BIN ? [] : ["server"];
}

export function buildZcodeAcpSpawnInput(
  settings: ZcodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const command = settings?.binaryPath || ZCODE_ACP_SERVER_BIN;
  const zcodeBinaryPath = settings?.zcodeBinaryPath?.trim();
  return {
    command,
    args: zcodeAcpSpawnArgs(command),
    cwd,
    env: {
      ...environment,
      ...(zcodeBinaryPath ? { [ZCODE_BIN_ENV]: zcodeBinaryPath } : {}),
    },
  };
}

export function zcodeAcpRuntimeProcessOwnership(
  processGroupPlatform: NodeJS.Platform,
): Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "ownDescendantProcessGroups" | "ownDetachedProcessGroup" | "processGroupPlatform"
> {
  // The bridge re-execs under `bun --smol` when bun is on PATH and spawns
  // `zcode app-server --stdio` itself, so Stop must reach the whole group or
  // a detached bun/zcode backend survives. Same caveat as Grok: descendant
  // tracking rides the linux cgroup ledger only until a stable identity
  // provider covers nested detached groups on macOS.
  return {
    ownDescendantProcessGroups: processGroupPlatform === "linux",
    ownDetachedProcessGroup: true,
    processGroupPlatform,
  };
}

export const makeZcodeAcpRuntime = (
  input: ZcodeAcpRuntimeInput,
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
        spawn: buildZcodeAcpSpawnInput(input.settings, input.cwd, input.environment),
        authMethodId: ZCODE_ACP_AUTH_METHOD_ID,
        ...zcodeAcpRuntimeProcessOwnership(processGroupPlatform),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Applies the model picker through the bridge's `model` config option
 * (`session/set_config_option`; `runtime.setModel` resolves the option id).
 * Values are the bridge's provider-qualified encodings (`providerId\modelId`,
 * `custom:...`). The `default`/`auto` slugs mean "keep the session's current
 * model" and are never sent to the bridge. Returns the model the session now
 * runs on, or undefined when the bridge advertises no model option.
 */
export function applyZcodeAcpModelSelection<E>(input: {
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
