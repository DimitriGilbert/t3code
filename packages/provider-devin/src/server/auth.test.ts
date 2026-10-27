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
import { DevinSettings } from "../settings.ts";
import { DEVIN_LOGIN_METHOD_ID, makeDevinAuth } from "./auth.ts";
import { DEVIN_ACP_AUTH_METHOD_ID } from "./devinAcp.ts";

const settings = Schema.decodeSync(DevinSettings);

/**
 * Answers `initialize`, `authenticate`, and `session/new` over stdio so the
 * agent-method sign-in path runs end to end without a PTY. `authenticate`
 * writes the fake credentials file named by `DEVIN_FAKE_CRED_FILE`; calls
 * land in the `DEVIN_FAKE_LOG` log.
 */
const fakeDevinSource = `
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "logout") {
  try { unlinkSync(process.env.DEVIN_FAKE_CRED_FILE); } catch {}
  appendFileSync(process.env.DEVIN_FAKE_LOG, "cli:auth logout\\n");
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  const message = JSON.parse(line);
  if (typeof message.method !== "string" || message.id === undefined || message.id === null) return;
  appendFileSync(process.env.DEVIN_FAKE_LOG, message.method + "\\n");
  if (message.method === "authenticate") {
    writeFileSync(process.env.DEVIN_FAKE_CRED_FILE, 'token = "fake"\\n');
  }
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: 1,
          agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-dev" },
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
          },
          authMethods: [
            {
              id: "devin-browser",
              name: "Log in with browser",
              description: "Sign in via your browser",
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
    const xdgDataHome = path.join(directory, "xdg-data");
    const credFile = path.join(xdgDataHome, "devin", "credentials.toml");
    const bridgeLog = path.join(directory, "devin.log");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(credFile), { recursive: true });
    const binary = writeFakeCli({
      directory,
      name: "devin",
      source: fakeDevinSource,
      env: { DEVIN_FAKE_LOG: bridgeLog, DEVIN_FAKE_CRED_FILE: credFile },
    });
    let changed: boolean | undefined;
    const controller = yield* makeDevinAuth({
      instanceId: ProviderInstanceId.make("devin"),
      settings: settings({
        enabled: overrides.enabled ?? true,
        binaryPath: binary,
      }),
      cwd: directory,
      environment: { ...environment, XDG_DATA_HOME: xdgDataHome },
      onChanged: (authenticated) => Effect.sync(() => (changed = authenticated)),
    });
    return { controller, xdgDataHome, credFile, bridgeLog, isChanged: () => changed };
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

it.layer(NodeServices.layer)("Devin auth", (it) => {
  it.effect("advertises only the browser agent method and binds to the Devin data dir", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-auth-" });
        const { controller, xdgDataHome } = yield* makeAuth(directory);
        expect(controller.credentialBinding).toEqual({
          owner: "provider",
          key: `devin:${path.join(xdgDataHome, "devin")}`,
        });
        yield* controller.refreshMethods ?? Effect.void;
        const state = yield* controller.subscribe("owner").pipe(
          Stream.filter((current) => current.methods !== undefined),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        // No PtyAdapter is provided, so the terminal login method stays hidden.
        expect(state.methods?.map((method) => method.id)).toEqual([DEVIN_ACP_AUTH_METHOD_ID]);
        expect(state.methods?.[0]?.type).toBe("agent");
        expect(state.methods?.some((method) => method.id === DEVIN_LOGIN_METHOD_ID)).toBe(false);
      }),
    ),
  );

  it.effect("verifies the devin-browser method against the credentials file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-auth-" });
        const { controller, bridgeLog, credFile, isChanged } = yield* makeAuth(directory);
        yield* controller.start("owner");
        const done = yield* awaitPhase(controller, "succeeded");
        expect(done.message).toBe("Sign-in complete.");
        expect(isChanged()).toBe(true);
        expect(yield* fs.exists(credFile)).toBe(true);
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
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-auth-" });
        const { controller, isChanged } = yield* makeAuth(directory, { enabled: false });
        yield* controller.start("owner");
        const done = yield* awaitPhase(controller, "failed");
        expect(done.message).toContain("Enable this provider before signing in.");
        expect(isChanged()).toBeUndefined();
      }),
    ),
  );

  it.effect("logs out through `devin auth logout` and removes credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "devin-auth-" });
        const { controller, bridgeLog, credFile, isChanged } = yield* makeAuth(directory);
        yield* fs.writeFileString(credFile, 'token = "stale"\n');
        const state = yield* controller.logout(Effect.void);
        expect(state.phase).toBe("idle");
        expect(state.message).toBe("Signed out of Devin.");
        expect(yield* fs.exists(credFile)).toBe(false);
        expect(isChanged()).toBe(false);
        const calls = (yield* fs.readFileString(bridgeLog)).trim().split("\n");
        expect(calls).toEqual(["cli:auth logout"]);
      }),
    ),
  );
});
