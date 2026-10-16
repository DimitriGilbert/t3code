/**
 * ZCode's `ProviderAuthController`. Credentials live in `~/.zcode` (the
 * `ZCODE_HOME` env re-roots it), never in T3, so sign-in offers two methods:
 * the bridge's `zcode-credentials` agent method, which asks the ACP bridge to
 * adopt whatever is already saved, and a terminal method that runs
 * `zcode login` interactively when a PTY is available on this environment.
 * ZCode exposes no sign-out the bridge can drive, so logout is a guided
 * failure rather than a silent no-op.
 *
 * @module provider-zcode/server/auth
 */
import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ZcodeSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
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
import { makeZcodeAcpRuntime, ZCODE_ACP_AUTH_METHOD_ID } from "./zcodeAcp.ts";
import { zcodeCredentialFilesPresent, zcodeHomePath } from "./status.ts";

/** The terminal method id for `zcode login` (the bridge advertises none itself). */
export const ZCODE_LOGIN_METHOD_ID = "zcode-login";

type ZcodeAuthSettings = Pick<ZcodeSettings, "enabled" | "binaryPath" | "zcodeBinaryPath">;

export const makeZcodeAuth = Effect.fn("makeZcodeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ZcodeAuthSettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: (authenticated: boolean) => Effect.Effect<void, ProviderSetupError>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
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

  const makeRuntime = () =>
    makeZcodeAcpRuntime({
      settings: options.settings,
      environment: options.environment,
      cwd: options.cwd,
      clientInfo: { name: "t3-code-provider-auth", version: "0.0.0" },
      authenticateOnAuthRequired: false,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) => failure("start", "Could not start the ZCode ACP bridge.", cause)),
    );

  const methods: ReadonlyArray<ProviderAuthMethod> = [
    {
      id: ZCODE_ACP_AUTH_METHOD_ID,
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
    const command = nonEmptyCommand(options.settings.zcodeBinaryPath) ?? "zcode";
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

  const authenticate = (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ): Effect.Effect<void, ProviderSetupError, Scope.Scope> =>
    Effect.gen(function* () {
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
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeRuntime();
            const initialized = yield* runtime
              .initialize()
              .pipe(
                Effect.mapError((cause) =>
                  failure("start", "Could not initialize the ZCode ACP bridge.", cause),
                ),
              );
            const method = initialized.authMethods?.find((entry) => entry.id === methodId);
            if (!method) {
              return yield* failure(
                "start",
                "The ZCode ACP bridge did not advertise its credentials sign-in method.",
              );
            }
            yield* (runtime.authenticate ?? (() => Effect.void))(methodId).pipe(
              Effect.mapError((cause) =>
                failure("start", "The bridge could not complete ZCode sign-in.", cause),
              ),
            );
            yield* context.verifying;
            yield* runtime
              .start()
              .pipe(
                Effect.mapError((cause) =>
                  failure(
                    "verify",
                    "ZCode could not create a session with the saved credentials.",
                    cause,
                  ),
                ),
              );
          }),
        );
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
