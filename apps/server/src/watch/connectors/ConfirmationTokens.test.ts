import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  WatchConnectorError,
  WatchConnectorInstallRequestId,
  type WatchConnectorErrorReason,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ConfirmationTokens from "./ConfirmationTokens.ts";

const layerTest = ConfirmationTokens.layer.pipe(Layer.provideMerge(NodeCrypto.layer));
const layerTestClocked = Layer.merge(layerTest, TestClock.layer());

const requestId = WatchConnectorInstallRequestId.make("watch-connector-install-request:test");
const otherRequestId = WatchConnectorInstallRequestId.make("watch-connector-install-request:other");

const isConnectorError = Schema.is(WatchConnectorError);

const expectFailure = <A, R>(
  reason: WatchConnectorErrorReason,
  effect: Effect.Effect<A, WatchConnectorError, R>,
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

it.effect("a minted token consumes once and binds to (requestId, manifestHash)", () =>
  Effect.gen(function* () {
    const tokens = yield* ConfirmationTokens.WatchConfirmationTokens;
    const token = yield* tokens.mint({ requestId, manifestHash: "hash-a" });

    yield* tokens.consume({ token, requestId, manifestHash: "hash-a" });
    // Single-use: a second consume of the same token refuses.
    yield* expectFailure(
      "confirmationInvalid",
      tokens.consume({ token, requestId, manifestHash: "hash-a" }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a token refuses a different request or manifest hash — and burns itself", () =>
  Effect.gen(function* () {
    const tokens = yield* ConfirmationTokens.WatchConfirmationTokens;
    const wrongHash = yield* tokens.mint({ requestId, manifestHash: "hash-a" });
    yield* expectFailure(
      "confirmationInvalid",
      tokens.consume({ token: wrongHash, requestId, manifestHash: "hash-b" }),
    );
    // The failed attempt consumed it — the right binding no longer works.
    yield* expectFailure(
      "confirmationInvalid",
      tokens.consume({ token: wrongHash, requestId, manifestHash: "hash-a" }),
    );

    const wrongRequest = yield* tokens.mint({ requestId, manifestHash: "hash-a" });
    yield* expectFailure(
      "confirmationInvalid",
      tokens.consume({ token: wrongRequest, requestId: otherRequestId, manifestHash: "hash-a" }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an unknown token refuses", () =>
  Effect.gen(function* () {
    const tokens = yield* ConfirmationTokens.WatchConfirmationTokens;
    yield* expectFailure(
      "confirmationInvalid",
      tokens.consume({ token: "watch-confirm:bogus", requestId, manifestHash: "hash-a" }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a token expires after its TTL", () =>
  Effect.gen(function* () {
    const tokens = yield* ConfirmationTokens.WatchConfirmationTokens;
    const token = yield* tokens.mint({ requestId, manifestHash: "hash-a" });
    yield* TestClock.adjust(Duration.minutes(6));
    yield* expectFailure(
      "confirmationExpired",
      tokens.consume({ token, requestId, manifestHash: "hash-a" }),
    );
  }).pipe(Effect.provide(layerTestClocked)),
);

it.effect("minting sweeps expired tokens — a swept token reads as unknown, not expired", () =>
  Effect.gen(function* () {
    const tokens = yield* ConfirmationTokens.WatchConfirmationTokens;
    const stale = yield* tokens.mint({ requestId, manifestHash: "hash-a" });
    yield* TestClock.adjust(Duration.minutes(6));
    yield* tokens.mint({ requestId, manifestHash: "hash-b" });
    yield* expectFailure(
      "confirmationInvalid",
      tokens.consume({ token: stale, requestId, manifestHash: "hash-a" }),
    );
  }).pipe(Effect.provide(layerTestClocked)),
);
