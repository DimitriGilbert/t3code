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
  effect: Effect.Effect<A, WatchConnectorError>,
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

it.effect("evaluates the entry module and invokes fetch/transform through the context", () =>
  Effect.gen(function* () {
    const mod = yield* PackModule.evalConnectorModule(
      connector(`module.exports = {
        fetch: (ctx) => ({ raw: ctx.config["repo"], echoed: ctx.files["dir/a.json"] }),
        transform: (raw, ctx) => ({ repo: raw.raw, echoed: raw.echoed, key: ctx.secrets.get("apiKey") }),
      };`),
    );
    const ctx = {
      config: { repo: "t3" },
      secrets: PackModule.makeSecretsAccessor(["apiKey"], { apiKey: "s3cr3t" }),
      files: { "dir/a.json": "{}" },
      failAuthExpired: (message: string) => new PackModule.ConnectorAuthExpiredError(message),
    } satisfies PackModule.ConnectorModuleContext;
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
    const ctx = {
      config: {},
      secrets: PackModule.makeSecretsAccessor([], {}),
      failAuthExpired: (message: string) => new PackModule.ConnectorAuthExpiredError(message),
    } satisfies PackModule.ConnectorModuleContext;
    const raw = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx));
    assert.deepEqual(raw, { hasRequire: false, hasProcess: false, hasFetch: false });
  }),
);

it.effect("rejects an entry exporting neither fetch nor transform", () =>
  expectConnectorError(
    "packCodeInvalid",
    PackModule.evalConnectorModule(connector(`module.exports = { notIt: 1 };`)),
  ),
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
    const ctx = {
      config: {},
      secrets: PackModule.makeSecretsAccessor([], {}),
      failAuthExpired: (message: string) => new PackModule.ConnectorAuthExpiredError(message),
    } satisfies PackModule.ConnectorModuleContext;
    const result = yield* PackModule.invokePackFunction(() => mod.fetch?.(ctx)).pipe(Effect.result);
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
