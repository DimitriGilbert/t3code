/**
 * Devin's `ProviderAuthController`: credentials live in `credentials.toml`
 * under the XDG data dir, so sign-in offers the `devin-browser` agent method
 * plus a terminal `devin auth login`, and logout runs `devin auth logout`.
 *
 * @module provider-devin/server/auth
 */
import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { DevinSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { nonEmptyTrimmed, spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { DEVIN_ACP_AUTH_METHOD_ID, DEVIN_CLI_BIN, makeDevinAcpRuntime } from "./devinAcp.ts";
import { devinCredentialFilePresent, devinDataDirPath } from "./status.ts";

/** The terminal method id for `devin auth login` (the ACP server advertises none itself). */
export const DEVIN_LOGIN_METHOD_ID = "devin-login";

/** `devin auth logout` deletes the local credentials file; no network wait. */
const LOGOUT_TIMEOUT_MS = 10_000;

type DevinAuthSettings = Pick<DevinSettings, "enabled" | "binaryPath">;

export const makeDevinAuth = Effect.fn("makeDevinAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: DevinAuthSettings;
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
    makeDevinAcpRuntime({
      settings: options.settings,
      environment: options.environment,
      cwd: options.cwd,
      clientInfo: { name: "t3-code-provider-auth", version: "0.0.0" },
      authenticateOnAuthRequired: false,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) => failure("start", "Could not start the Devin ACP server.", cause)),
    );

  const methods: ReadonlyArray<ProviderAuthMethod> = [
    {
      id: DEVIN_ACP_AUTH_METHOD_ID,
      name: "Devin account",
      description: "Sign in to Devin through your browser.",
      type: "agent",
    },
    ...(Option.isSome(pty)
      ? [
          {
            id: DEVIN_LOGIN_METHOD_ID,
            name: "Run `devin auth login`",
            description:
              "Sign in to Devin interactively in a terminal on this environment. On remote or SSH environments pass `--force-manual-token-flow` to paste a token instead.",
            type: "terminal" as const,
          },
        ]
      : []),
  ];

  /** Streams `devin auth login` through the sign-in terminal interaction. */
  const runLoginTerminal = Effect.fnUntraced(function* (
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty)) {
      return yield* failure(
        "start",
        "Interactive provider login is unavailable on this environment.",
      );
    }
    const command = nonEmptyTrimmed(options.settings.binaryPath) ?? DEVIN_CLI_BIN;
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: command,
        args: ["auth", "login"],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: options.environment,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not open the Devin sign-in terminal.", cause),
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
      return yield* failure("start", "The `devin auth login` command did not finish successfully.");
    }
  });

  const credentialCheck = devinCredentialFilePresent(options.environment).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const authenticate = Effect.fn("authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (!options.settings.enabled) {
      return yield* failure("start", "Enable this provider before signing in.");
    }
    if (methodId === DEVIN_LOGIN_METHOD_ID) {
      yield* runLoginTerminal(context).pipe(Effect.scoped);
      yield* context.verifying;
      // `devin auth login` writes credentials.toml itself; the file is the proof.
      if (!(yield* credentialCheck)) {
        return yield* failure(
          "verify",
          "`devin auth login` finished but no Devin credentials were found.",
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
                failure("start", "Could not initialize the Devin ACP server.", cause),
              ),
            );
          const method = initialized.authMethods?.find((entry) => entry.id === methodId);
          if (!method) {
            return yield* failure(
              "start",
              "The Devin ACP server did not advertise its browser sign-in method.",
            );
          }
          yield* (runtime.authenticate ?? (() => Effect.void))(methodId).pipe(
            Effect.mapError((cause) =>
              failure("start", "Devin could not complete the browser sign-in.", cause),
            ),
          );
          yield* context.verifying;
          // `session/new` succeeds without credentials, so it cannot be
          // the sign-in proof — the credentials file the browser flow just
          // wrote is.
          if (!(yield* credentialCheck)) {
            return yield* failure(
              "verify",
              "The Devin sign-in finished but no credentials were found.",
            );
          }
          yield* runtime
            .start()
            .pipe(
              Effect.mapError((cause) =>
                failure("verify", "Devin could not create a session after sign-in.", cause),
              ),
            );
        }),
      );
    }
    yield* options.onChanged(true);
  });

  const devinDataDir = yield* devinDataDirPath(options.environment).pipe(
    Effect.provideService(Path.Path, path),
  );

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // Every Devin instance on this environment reads the same credentials.toml.
    credentialBinding: { owner: "provider", key: `devin:${devinDataDir}` },
    methods: Effect.succeed(methods),
    authenticate,
    logout: Effect.gen(function* () {
      const command = nonEmptyTrimmed(options.settings.binaryPath) ?? DEVIN_CLI_BIN;
      const spawnCommand = yield* resolveSpawnCommand(command, ["auth", "logout"], {
        env: options.environment,
      }).pipe(
        Effect.mapError((cause) =>
          failure("logout", "Could not resolve the Devin CLI for sign-out.", cause),
        ),
      );
      const result = yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: options.environment,
          shell: spawnCommand.shell,
        }),
      ).pipe(
        Effect.timeoutOption(LOGOUT_TIMEOUT_MS),
        Effect.mapError((cause) => failure("logout", "Could not run `devin auth logout`.", cause)),
      );
      if (Option.isNone(result)) {
        return yield* failure("logout", "`devin auth logout` timed out.");
      }
      if (result.value.code !== 0) {
        return yield* failure(
          "logout",
          `Devin sign-out failed: ${nonEmptyTrimmed(result.value.stderr) ?? `exit code ${result.value.code}`}`,
        );
      }
      yield* options.onChanged(false);
      return "Signed out of Devin.";
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Path.Path, path),
    ),
  });
});
