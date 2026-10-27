import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ZCodeError from "../errors.ts";

export const ZCodeProtocolRequestId = Schema.Union([Schema.Number, Schema.String]);

const ZCodeProtocolErrorObject = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
});

// A response must carry result or error; upstream drops a bare {id} frame.
export const ZCodeProtocolResponseEnvelope = Schema.Union([
  Schema.Struct({ id: ZCodeProtocolRequestId, result: Schema.Unknown }),
  Schema.Struct({ id: ZCodeProtocolRequestId, error: ZCodeProtocolErrorObject }),
]);

export const decodeOptionalPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  raw: unknown,
): Effect.Effect<A, ZCodeError.ZCodeAppServerRequestError> => {
  if (!schema) {
    if (raw === undefined) {
      return Effect.sync(() => undefined as A);
    }
    return Effect.fail(
      ZCodeError.ZCodeAppServerRequestError.unexpectedPayload(method, "decode-payload", raw),
    );
  }

  return Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError((error) =>
      ZCodeError.ZCodeAppServerRequestError.invalidPayload(method, "decode-payload", error),
    ),
  );
};

export const encodeOptionalPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  payload: A,
): Effect.Effect<I | undefined, ZCodeError.ZCodeAppServerRequestError> => {
  if (!schema) {
    if (payload === undefined) {
      return Effect.undefined;
    }
    return Effect.fail(
      ZCodeError.ZCodeAppServerRequestError.unexpectedPayload(method, "encode-payload", payload),
    );
  }

  return Schema.encodeEffect(schema)(payload).pipe(
    Effect.mapError((error) =>
      ZCodeError.ZCodeAppServerRequestError.invalidPayload(method, "encode-payload", error),
    ),
  );
};

export const decodeNotificationPayload = <A, I>(
  method: string,
  schema: Schema.Codec<A, I> | undefined,
  raw: unknown,
): Effect.Effect<A, ZCodeError.ZCodeAppServerProtocolParseError> =>
  decodeOptionalPayload(method, schema, raw).pipe(
    Effect.mapError((error) =>
      ZCodeError.ZCodeAppServerProtocolParseError.fromRequestError(
        "decode-notification-payload",
        method,
        error,
      ),
    ),
  );

export const runHandler = Effect.fnUntraced(function* <A, B>(
  handler: ((payload: A) => Effect.Effect<B, ZCodeError.ZCodeAppServerError>) | undefined,
  payload: A,
  method: string,
) {
  if (!handler) {
    return yield* ZCodeError.ZCodeAppServerRequestError.methodNotFound(method);
  }

  return yield* handler(payload).pipe(
    Effect.mapError((error) =>
      ZCodeError.ZCodeAppServerRequestError.fromAppServerError(error, method),
    ),
  );
});
