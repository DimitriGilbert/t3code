/**
 * ZCode's `ProviderAuthController`. Credentials live in `~/.zcode`
 * (`ZCODE_HOME` re-roots it): saved-credential adoption via a disposable
 * app-server probe, plus a terminal `zcode login`. Logout is a guided failure.
 *
 * @module provider-zcode/server/auth
 */
import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ZcodeSettings } from "../settings.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { buildZcodeAppServerSpawnInput, openZcodeAppServerClient } from "./zcodeAppServer.ts";
import { zcodeCredentialFilesPresent, zcodeHomePath } from "./status.ts";

/** The saved-credentials method id (the app-server exposes no auth requests). */
export const ZCODE_CREDENTIALS_METHOD_ID = "zcode-credentials";

/** The terminal method id for `zcode login`. */
export const ZCODE_LOGIN_METHOD_ID = "zcode-login";

type ZcodeAuthSettings = Pick<ZcodeSettings, "enabled" | "binaryPath">;

export const makeZcodeAuth = Effect.fn("makeZcodeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ZcodeAuthSettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: (authenticated: boolean) => Effect.Effect<void, ProviderSetupError>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  // Adopting saved credentials == the app-server can spawn, reach
  // storage-ready, and list sessions against this workspace.
  const probeSavedCredentials = Effect.fn("probeSavedCredentials")(function* () {
    const spawnInput = buildZcodeAppServerSpawnInput(
      options.settings,
      options.cwd,
      options.environment,
    );
    const client = yield* openZcodeAppServerClient({
      command: spawnInput.command,
      args: spawnInput.args,
      cwd: spawnInput.cwd,
      env: spawnInput.env,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Scope.Scope, yield* Scope.Scope),
      Effect.mapError((cause) => failure("start", "Could not start the ZCode app-server.", cause)),
    );
    yield* client
      .request("session/list", {
        workspace: { workspacePath: options.cwd, workspaceKey: options.cwd },
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("verify", "ZCode could not list sessions with the saved credentials.", cause),
        ),
      );
  }, Effect.scoped);

  const methods: ReadonlyArray<ProviderAuthMethod> = [
    {
      id: ZCODE_CREDENTIALS_METHOD_ID,
      name: "ZCode account",
      description: "Use the credentials saved in the ZCode home directory.",
      type: "agent",
    },
    ...(Option.isSome(pty)
      ? [
          {
            id: ZCODE_LOGIN_METHOD_ID,
            name: "Run `zcode login`",
            description: "Sign in to ZCode interactively in a terminal on this environment.",
            type: "terminal" as const,
          },
        ]
      : []),
  ];

  /** Streams `zcode login` through the sign-in terminal interaction. */
  const runLoginTerminal = Effect.fnUntraced(function* (
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty)) {
      return yield* failure(
        "start",
        "Interactive provider login is unavailable on this environment.",
      );
    }
    const command = nonEmptyCommand(options.settings.binaryPath) ?? "zcode";
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: command,
        args: ["login"],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: options.environment,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not open the ZCode sign-in terminal.", cause),
        ),
      );
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {
          /* The login process may already have exited. */
        }
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () =>
                  failure("respond", "The provider sign-in terminal is no longer available."),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0) {
      return yield* failure("start", "The `zcode login` command did not finish successfully.");
    }
  });

  const credentialCheck = zcodeCredentialFilesPresent(options.environment).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const authenticate = Effect.fn("ZcodeAuth.authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ): Effect.fn.Return<void, ProviderSetupError, Scope.Scope> {
    if (!options.settings.enabled) {
      return yield* failure("start", "Enable this provider before signing in.");
    }
    if (methodId === ZCODE_LOGIN_METHOD_ID) {
      yield* runLoginTerminal(context).pipe(Effect.scoped);
      yield* context.verifying;
      // `zcode login` persists under ~/.zcode itself; its files are the proof.
      if (!(yield* credentialCheck)) {
        return yield* failure(
          "verify",
          "`zcode login` finished but no ZCode credentials were found.",
        );
      }
    } else {
      if (methodId !== ZCODE_CREDENTIALS_METHOD_ID) {
        return yield* failure("start", `Unknown ZCode auth method ${methodId}.`);
      }
      yield* context.verifying;
      yield* probeSavedCredentials();
    }
    yield* options.onChanged(true);
  });

  const zcodeHome = yield* zcodeHomePath(options.environment).pipe(
    Effect.provideService(Path.Path, path),
  );
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // Every ZCode instance on this environment reads the same ~/.zcode store.
    credentialBinding: { owner: "provider", key: `zcode:${zcodeHome}` },
    methods: Effect.succeed(methods),
    authenticate,
    logout: Effect.fail(
      failure(
        "logout",
        `ZCode has no remote sign-out. Remove the credentials under ${zcodeHome}/v2 or sign out in the ZCode desktop app.`,
      ),
    ),
  });
});

function nonEmptyCommand(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
