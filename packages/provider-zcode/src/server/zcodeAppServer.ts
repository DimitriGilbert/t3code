// @effect-diagnostics nodeBuiltinImport:off - spawn input must stat candidate
// config files synchronously; the spawn builders are plain functions.
/**
 * Launch and lifecycle support for `zcode app-server --stdio`: spawn argv/env
 * and the provider-config env the backend needs on a headless `~/.zcode`
 * install.
 *
 * @module provider-zcode/server/zcodeAppServer
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ZCodeClient from "@t3tools/effect-zcode-protocol/client";
import * as ZCodeError from "@t3tools/effect-zcode-protocol/errors";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { ZcodeSettings } from "../settings.ts";

/** The zcode CLI binary; settings.binaryPath overrides it. */
export const ZCODE_CLI_BIN = "zcode";

/** Env var re-rooting the ZCode home directory (default `~/.zcode`). */
const ZCODE_HOME_ENV = "ZCODE_HOME";

/** Backend env var pointing at the bundled provider registry. */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_ENV = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";

/** Backend env var pointing at the user's personal provider config. */
export const ZCODE_PERSONAL_PROVIDER_CONFIG_ENV = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";

type ZcodeAppServerSettings = Pick<ZcodeSettings, "binaryPath">;

export interface ZcodeAppServerSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

const nonBlankEnvValue = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== "" ? value : undefined;

/**
 * Provider-config env vars the app-server needs on a headless `~/.zcode`
 * install (`provider-node/src/runtime-paths.ts` throws at boot without them).
 * Point at the well-known files under ZCODE_HOME — only for variables the
 * caller's environment leaves unset, so user overrides always win.
 */
export function zcodeProviderConfigEnv(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const effective = environment ?? process.env;
  const isSet = (name: string) => nonBlankEnvValue(effective[name]) !== undefined;
  const zcodeHome =
    nonBlankEnvValue(effective[ZCODE_HOME_ENV]) ?? NodePath.join(NodeOS.homedir(), ".zcode");
  const env: NodeJS.ProcessEnv = {};
  for (const [name, relativePath] of [
    [
      ZCODE_BUILTIN_PROVIDER_CONFIG_ENV,
      NodePath.join("v2", "runtime", "provider", "bundled", "zcode-builtin.json"),
    ],
    [ZCODE_PERSONAL_PROVIDER_CONFIG_ENV, NodePath.join("v2", "provider_config.json")],
  ] as const) {
    if (isSet(name)) continue;
    const candidate = NodePath.join(zcodeHome, relativePath);
    if (NodeFS.existsSync(candidate)) {
      env[name] = candidate;
    }
  }
  return env;
}

export function buildZcodeAppServerSpawnInput(
  settings: ZcodeAppServerSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): ZcodeAppServerSpawnInput {
  return {
    command: settings?.binaryPath || ZCODE_CLI_BIN,
    args: ["app-server", "--stdio"],
    cwd,
    env: { ...zcodeProviderConfigEnv(environment), ...environment },
  };
}

/** Test seam: replaces the spawned process with a replay/in-memory client. */
export type ZcodeAppServerClientOpener = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) => Effect.Effect<
  ZCodeClient.ZCodeAppServerClient["Service"],
  ZCodeError.ZCodeAppServerError | ZcodeAppServerSpawnOpenError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
>;

export class ZcodeAppServerSpawnOpenError extends Schema.TaggedError<ZcodeAppServerSpawnOpenError>()(
  "ZcodeAppServerSpawnOpenError",
  {
    command: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** Spawn `zcode app-server --stdio` and hand the process to the client layer. */
export const openZcodeAppServerClient = Effect.fn("openZcodeAppServerClient")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const scope = yield* Scope.Scope;
  const spawn = yield* resolveSpawnCommand(input.command, input.args, { env: input.env });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(spawn.command, spawn.args, {
        cwd: input.cwd,
        env: input.env,
        shell: spawn.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) => new ZcodeAppServerSpawnOpenError({ command: input.command, cause }),
      ),
    );
  const context = yield* Layer.build(ZCodeClient.layerChildProcess(handle)).pipe(
    Effect.mapError((cause) => new ZcodeAppServerSpawnOpenError({ command: input.command, cause })),
  );
  return yield* ZCodeClient.ZCodeAppServerClient.pipe(Effect.provide(context));
});
