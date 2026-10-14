import { WatchConnectorError, type WatchConnectorInstallRequestId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * The human-confirm gate for connector installs. `prepareInstallConfirm`
 * mints a token bound to `(requestId, manifestHash)`; `confirmInstall` /
 * `confirmUpgrade` consume it. Tokens are single-use, expire after five
 * minutes, live only in memory (a restart simply asks the UI to prepare
 * again), and are only ever minted by the prepare RPC — which is not in the
 * MCP toolkit, so an agent can never obtain one.
 */
export const CONFIRMATION_TOKEN_TTL_MILLIS = 5 * 60 * 1000;

interface PendingToken {
  readonly requestId: WatchConnectorInstallRequestId;
  readonly manifestHash: string;
  readonly expiresAtMillis: number;
}

const tokenError = (reason: "confirmationInvalid" | "confirmationExpired", message: string) =>
  new WatchConnectorError({ message, reason });

export class WatchConfirmationTokens extends Context.Service<
  WatchConfirmationTokens,
  {
    readonly mint: (input: {
      readonly requestId: WatchConnectorInstallRequestId;
      readonly manifestHash: string;
    }) => Effect.Effect<string, WatchConnectorError>;
    /**
     * Consumes `token`: the entry is deleted whether or not it validates, so a
     * leaked or replayed token is dead after first use. Binding to
     * `(requestId, manifestHash)` makes a token unusable against a different
     * request or a mutated manifest.
     */
    readonly consume: (input: {
      readonly token: string;
      readonly requestId: WatchConnectorInstallRequestId;
      readonly manifestHash: string;
    }) => Effect.Effect<void, WatchConnectorError>;
  }
>()("t3/watch/connectors/ConfirmationTokens/WatchConfirmationTokens") {}

export const layer = Layer.effect(
  WatchConfirmationTokens,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const tokens = yield* Ref.make(new Map<string, PendingToken>());

    const mint: WatchConfirmationTokens["Service"]["mint"] = ({ requestId, manifestHash }) =>
      Effect.gen(function* () {
        const bytes = yield* crypto.randomBytes(24).pipe(
          Effect.mapError(
            (cause) =>
              new WatchConnectorError({
                message: "Could not mint a confirmation token.",
                reason: "confirmationInvalid",
                cause,
              }),
          ),
        );
        const token = `watch-confirm:${Buffer.from(bytes).toString("hex")}`;
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(tokens, (map) => {
          const next = new Map(map);
          // Sweep on mint: expired entries are dead weight, and this is the
          // only write path so the map never grows past live tokens.
          for (const [key, entry] of next) {
            if (entry.expiresAtMillis <= now) next.delete(key);
          }
          next.set(token, {
            requestId,
            manifestHash,
            expiresAtMillis: now + CONFIRMATION_TOKEN_TTL_MILLIS,
          });
          return next;
        });
        return token;
      });

    const consume: WatchConfirmationTokens["Service"]["consume"] = ({
      token,
      requestId,
      manifestHash,
    }) =>
      Effect.gen(function* () {
        // Consume on first touch, atomically: wrong binding, expiry, and
        // reuse all burn it in the same step that reads it, so two racing
        // confirms can never both observe the token as live.
        const entry = yield* Ref.modify(tokens, (map) => {
          const found = map.get(token);
          const next = new Map(map);
          next.delete(token);
          return [found, next] as const;
        });
        if (entry === undefined) {
          return yield* tokenError(
            "confirmationInvalid",
            "Confirmation token is unknown or already used.",
          );
        }
        if ((yield* Clock.currentTimeMillis) > entry.expiresAtMillis) {
          return yield* tokenError(
            "confirmationExpired",
            "Confirmation token expired; prepare the install again.",
          );
        }
        if (entry.requestId !== requestId || entry.manifestHash !== manifestHash) {
          return yield* tokenError(
            "confirmationInvalid",
            "Confirmation token does not match this install request.",
          );
        }
      });

    return WatchConfirmationTokens.of({ mint, consume });
  }),
);
