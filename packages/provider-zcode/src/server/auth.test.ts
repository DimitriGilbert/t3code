import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { ZcodeSettings } from "../settings.ts";
import { makeZcodeAuth, ZCODE_LOGIN_METHOD_ID } from "./auth.ts";
import { ZCODE_ACP_AUTH_METHOD_ID } from "./zcodeAcp.ts";

const settings = Schema.decodeSync(ZcodeSettings);

/**
 * Answers `initialize`, `authenticate`, and `session/new` so the auth
 * controller's agent-method path (initialize → authenticate → verify via
 * start) runs end to end without a PTY. Records every agent-bound method in
 * the log file named by `ZCODE_FAKE_LOG`.
 */
const fakeBridgeSource = `
import { appendFileSync } from "node:fs";
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  const message = JSON.parse(line);
  if (typeof message.method !== "string" || message.id === undefined || message.id === null) return;
  appendFileSync(process.env.ZCODE_FAKE_LOG, message.method + "\\n");
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: 1,
          agentInfo: { name: "zcode-acp-server", title: "ZCode", version: "0.72.0" },
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
          },
          authMethods: [
            {
              id: "zcode-credentials",
              name: "ZCode built-in credentials",
              description: "Reads ~/.zcode credentials.",
            },
          ],
        }
      : message.method === "authenticate"
        ? {}
        : message.method === "session/new"
          ? { sessionId: "auth-probe-session" }
          : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

const makeAuth = (
  directory: string,
  overrides: { enabled?: boolean } = {},
  environment: NodeJS.ProcessEnv = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const zcodeHome = path.join(directory, "zcode-home");
    const bridgeLog = path.join(directory, "bridge.log");
    const bridge = writeFakeCli({
      directory,
      name: "zcode-acp-server",
      source: fakeBridgeSource,
      env: { ZCODE_FAKE_LOG: bridgeLog },
    });
    let changed: boolean | undefined;
    const controller = yield* makeZcodeAuth({
      instanceId: ProviderInstanceId.make("zcode"),
      settings: settings({
        enabled: overrides.enabled ?? true,
        binaryPath: bridge,
        zcodeBinaryPath: "",
      }),
      cwd: directory,
      environment: { ...environment, ZCODE_HOME: zcodeHome },
      onChanged: (authenticated) => Effect.sync(() => (changed = authenticated)),
    });
    return { controller, zcodeHome, bridgeLog, isChanged: () => changed };
  });

const awaitPhase = (
  controller: Pick<ProviderAuthController, "subscribe">,
  phase: ProviderAuthState["phase"],
) =>
  controller.subscribe("owner").pipe(
    Stream.filter((state) => state.phase === phase),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.layer(NodeServices.layer)("Zcode auth", (it) => {
  it.effect("advertises only the credentials agent method and binds to the zcode home", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-auth-" });
        const { controller, zcodeHome } = yield* makeAuth(directory);
        expect(controller.credentialBinding).toEqual({
          owner: "provider",
          key: `zcode:${zcodeHome}`,
        });
        yield* controller.refreshMethods ?? Effect.void;
        const state = yield* controller.subscribe("owner").pipe(
          Stream.filter((current) => current.methods !== undefined),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        // No PtyAdapter is provided, so the terminal login method stays hidden.
        expect(state.methods?.map((method) => method.id)).toEqual([ZCODE_ACP_AUTH_METHOD_ID]);
        expect(state.methods?.[0]?.type).toBe("agent");
        expect(state.methods?.some((method) => method.id === ZCODE_LOGIN_METHOD_ID)).toBe(false);
      }),
    ),
  );

  it.effect("verifies the bridge's zcode-credentials method and reports onChanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-auth-" });
        const { controller, bridgeLog, isChanged } = yield* makeAuth(directory);
        yield* controller.start("owner");
        const done = yield* awaitPhase(controller, "succeeded");
        expect(done.message).toBe("Sign-in complete.");
        expect(isChanged()).toBe(true);
        // initialize → authenticate (agent method) → session/new verification.
        const calls = (yield* fs.readFileString(bridgeLog)).trim().split("\n");
        expect(calls).toEqual(["initialize", "authenticate", "session/new"]);
      }),
    ),
  );

  it.effect("rejects sign-in while the provider is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-auth-" });
        const { controller, isChanged } = yield* makeAuth(directory, { enabled: false });
        yield* controller.start("owner");
        const done = yield* awaitPhase(controller, "failed");
        expect(done.message).toContain("Enable this provider before signing in.");
        expect(isChanged()).toBeUndefined();
      }),
    ),
  );

  it.effect("logout fails with a pointer at the ZCode credential files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "zcode-auth-" });
        const { controller, zcodeHome } = yield* makeAuth(directory);
        const failure = yield* Effect.flip(controller.logout(Effect.void));
        expect(failure.operation).toBe("logout");
        expect(failure.detail).toContain("no remote sign-out");
        expect(failure.detail).toContain(`${zcodeHome}/v2`);
      }),
    ),
  );
});
