import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as ZCodeError from "./errors.ts";
import { ZCodeProtocolRequestId, ZCodeProtocolResponseEnvelope } from "./_internal/shared.ts";
const isJsonRpcId = Schema.is(ZCodeProtocolRequestId);
const isResponseEnvelope = Schema.is(ZCodeProtocolResponseEnvelope);
const isZCodeAppServerError = Schema.is(ZCodeError.ZCodeAppServerError);
// zcode's own client defaults each request to a 3-minute timeout.
const DEFAULT_REQUEST_TIMEOUT_MS = 3 * 60_000;
const MAX_BUFFERED_RAW_MESSAGES = 32;
// Bound JSONL lines before joining and parsing; the LF delimiter is excluded.
const MAX_INCOMING_MESSAGE_BYTES = 128 * 1024 * 1024;
const EXIT_STATUS_GRACE = "250 millis";

export interface ZCodeAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface ZCodeAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface ZCodeAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface ZCodeAppServerProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<ZCodeError.ZCodeAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  // Per-request timeout; zcode's own client defaults to 3 minutes.
  readonly requestTimeoutMs?: number;
  // Test override; production uses MAX_INCOMING_MESSAGE_BYTES.
  readonly maxIncomingMessageBytes?: number;
  readonly logger?: (event: ZCodeAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: ZCodeAppServerIncomingNotification,
  ) => Effect.Effect<void, never>;
  readonly onRequest?: (
    request: ZCodeAppServerIncomingRequest,
  ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
  readonly onTermination?: (error: ZCodeError.ZCodeAppServerError) => Effect.Effect<void, never>;
}

export interface ZCodeAppServerProtocol {
  readonly incomingNotifications: Stream.Stream<ZCodeAppServerIncomingNotification>;
  readonly incomingRequests: Stream.Stream<ZCodeAppServerIncomingRequest>;
  readonly request: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: ZCodeError.ZCodeAppServerRequestError,
  ) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>;
}

interface ZCodeAppServerPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, ZCodeError.ZCodeAppServerError>;
  readonly method: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingRequest(value: unknown): value is ZCodeAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string") {
    return false;
  }
  return isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is ZCodeAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof ZCodeProtocolResponseEnvelope.Type {
  return isResponseEnvelope(value);
}

const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, ZCodeError.ZCodeAppServerProtocolParseError> =>
  encodeJsonString(message).pipe(
    Effect.map((encoded) => `${encoded}\n`),
    Effect.mapError((cause) => {
      const method = typeof message.method === "string" ? message.method : undefined;
      const requestId =
        typeof message.id === "string" || typeof message.id === "number"
          ? String(message.id)
          : undefined;
      return ZCodeError.ZCodeAppServerProtocolParseError.fromSchemaError(
        "encode-wire-message",
        cause,
        {
          ...(method === undefined ? {} : { method }),
          ...(requestId === undefined ? {} : { requestId }),
        },
      );
    }),
  );

const decodeWireMessage = (
  line: string,
): Effect.Effect<unknown, ZCodeError.ZCodeAppServerProtocolParseError> =>
  decodeJsonString(line).pipe(
    Effect.mapError((cause) =>
      ZCodeError.ZCodeAppServerProtocolParseError.fromSchemaError("decode-wire-message", cause),
    ),
  );

const normalizeIncomingError = (
  error: unknown,
  operation: ZCodeError.ZCodeAppServerTransportOperation,
): ZCodeError.ZCodeAppServerError =>
  isZCodeAppServerError(error)
    ? error
    : new ZCodeError.ZCodeAppServerTransportError({
        operation,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: ZCodeError.ZCodeAppServerProtocolErrorShape;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
});

export const makeZCodeAppServerProtocol = Effect.fn("makeZCodeAppServerProtocol")(function* (
  options: ZCodeAppServerProtocolOptions,
): Effect.fn.Return<ZCodeAppServerProtocol, never, Scope.Scope> {
  const protocolScope = yield* Scope.Scope;
  const requestHandlerScope = yield* Scope.fork(protocolScope, "parallel");
  const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
  const incomingNotifications =
    yield* Queue.sliding<ZCodeAppServerIncomingNotification>(MAX_BUFFERED_RAW_MESSAGES);
  const incomingRequests =
    yield* Queue.sliding<ZCodeAppServerIncomingRequest>(MAX_BUFFERED_RAW_MESSAGES);
  const pending = yield* Ref.make(new Map<string, ZCodeAppServerPendingRequest>());
  const nextRequestId = yield* Ref.make(1);
  const maxIncomingMessageBytes = options.maxIncomingMessageBytes ?? MAX_INCOMING_MESSAGE_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const remainder: Array<string> = [];
  let remainderBytes = 0;
  const terminationHandled = yield* Ref.make(false);
  const terminationFailure = yield* Ref.make(Option.none<ZCodeError.ZCodeAppServerError>());
  const terminationSignal = yield* Deferred.make<void>();
  const activeRequestHandlers = yield* Ref.make(0);

  const logProtocol = (event: ZCodeAppServerProtocolLogEvent) => {
    if (event.direction === "incoming" && !options.logIncoming) {
      return Effect.void;
    }
    if (event.direction === "outgoing" && !options.logOutgoing) {
      return Effect.void;
    }
    return (
      options.logger?.(event) ??
      Effect.logDebug("ZCode app-server protocol event").pipe(Effect.annotateLogs({ event }))
    );
  };

  const failAllPending = (error: ZCodeError.ZCodeAppServerError) =>
    Ref.get(pending).pipe(
      Effect.flatMap((current) =>
        Effect.forEach([...current.values()], ({ deferred }) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
      Effect.andThen(Ref.set(pending, new Map())),
    );

  const handleTermination = (classify: () => Effect.Effect<ZCodeError.ZCodeAppServerError>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          const error = yield* classify();
          yield* Ref.set(terminationFailure, Option.some(error));
          yield* failAllPending(error);
          yield* Queue.end(outgoing);
          yield* Deferred.succeed(terminationSignal, undefined);
          yield* Scope.close(requestHandlerScope, Exit.void).pipe(
            Effect.forkIn(protocolScope, { startImmediately: true }),
            Effect.asVoid,
          );
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const offerOutgoing =
    /* Every protocol write reaches this helper; request spans cover the operation. */
    Effect.fnUntraced(function* (message: Record<string, unknown>) {
      const failure = yield* Ref.get(terminationFailure);
      if (Option.isSome(failure)) return yield* failure.value;

      yield* logProtocol({
        direction: "outgoing",
        stage: "decoded",
        payload: message,
      });
      const encoded = yield* encodeWireMessage(message);
      yield* logProtocol({
        direction: "outgoing",
        stage: "raw",
        payload: encoded,
      });
      const accepted = yield* Queue.offer(outgoing, encoded);
      if (!accepted) {
        const closed = yield* Ref.get(terminationFailure);
        return yield* Option.getOrElse(
          closed,
          () => new ZCodeError.ZCodeAppServerInputStreamEndedError({}),
        );
      }
    });

  const removePending = (requestId: string) =>
    Ref.update(pending, (current) => {
      if (!current.has(requestId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(requestId);
      return next;
    });

  const resolvePending = (
    requestId: string,
    handler: (pendingRequest: ZCodeAppServerPendingRequest) => Effect.Effect<void>,
  ) =>
    Ref.modify(pending, (current) => {
      const pendingRequest = current.get(requestId);
      if (!pendingRequest) {
        return [Effect.void, current] as const;
      }
      const next = new Map(current);
      next.delete(requestId);
      return [handler(pendingRequest), next] as const;
    }).pipe(Effect.flatten);

  const respond = (requestId: string | number, result: unknown) =>
    offerOutgoing(toProtocolMessage(requestId, { result }));

  const respondError = (requestId: string | number, error: ZCodeError.ZCodeAppServerRequestError) =>
    offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));

  const handleResponse = (response: typeof ZCodeProtocolResponseEnvelope.Type) => {
    const requestId = String(response.id);
    if ("error" in response) {
      const protocolError = response.error;
      return resolvePending(requestId, ({ deferred, method }) =>
        Deferred.fail(
          deferred,
          ZCodeError.ZCodeAppServerRequestError.fromProtocolError(protocolError, method, requestId),
        ),
      );
    }
    return resolvePending(requestId, ({ deferred }) => Deferred.succeed(deferred, response.result));
  };

  const handleRequest = (request: ZCodeAppServerIncomingRequest) =>
    Queue.offer(incomingRequests, request).pipe(
      Effect.flatMap(() => {
        const handler = options.onRequest;
        if (!handler) return Effect.void;

        return Ref.modify(activeRequestHandlers, (count) =>
          count >= MAX_BUFFERED_RAW_MESSAGES ? [false, count] : [true, count + 1],
        ).pipe(
          Effect.flatMap((accepted) => {
            if (!accepted) {
              return respondError(
                request.id,
                ZCodeError.ZCodeAppServerRequestError.overloaded(
                  "Too many ZCode requests are already active.",
                ),
              );
            }

            return handler(request).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  respondError(
                    request.id,
                    ZCodeError.ZCodeAppServerRequestError.fromAppServerError(error, request.method),
                  ),
                onSuccess: (result) => respond(request.id, result),
              }),
              Effect.ensuring(Ref.update(activeRequestHandlers, (count) => Math.max(0, count - 1))),
              Effect.catch((error) =>
                handleTermination(() => Effect.succeed(error)).pipe(
                  Effect.forkIn(protocolScope),
                  Effect.asVoid,
                ),
              ),
              Effect.forkIn(requestHandlerScope, { startImmediately: true }),
              Effect.asVoid,
            );
          }),
        );
      }),
      Effect.asVoid,
    );

  const handleNotification = (notification: ZCodeAppServerIncomingNotification) =>
    Queue.offer(incomingNotifications, notification).pipe(
      Effect.andThen(options.onNotification ? options.onNotification(notification) : Effect.void),
      Effect.asVoid,
    );

  const routeMessage = Effect.fnUntraced(function* (message: unknown) {
    if (Option.isSome(yield* Ref.get(terminationFailure))) return;
    // Response first: upstream resolves {id, result}/{id, error} before the
    // request/notification checks, so a degenerate {id, method, result} frame
    // still settles the pending request.
    if (isIncomingResponse(message)) return yield* handleResponse(message);
    if (isIncomingRequest(message)) return yield* handleRequest(message);
    if (isIncomingNotification(message)) return yield* handleNotification(message);
    // Upstream silently drops id-bearing frames that match no class (e.g. a
    // bare {id}); anything else stays a typed routing failure.
    if (isObject(message) && "id" in message) return;
    return yield* ZCodeError.ZCodeAppServerProtocolParseError.fromUnroutableMessage(message);
  });

  const handleLine = (line: string): Effect.Effect<void, ZCodeError.ZCodeAppServerError> => {
    if (line.trim().length === 0) {
      return Effect.void;
    }
    return logProtocol({
      direction: "incoming",
      stage: "raw",
      payload: line,
    }).pipe(
      Effect.flatMap(() => decodeWireMessage(line)),
      Effect.tap((decoded) =>
        logProtocol({
          direction: "incoming",
          stage: "decoded",
          payload: decoded,
        }),
      ),
      Effect.tapErrorTag("ZCodeAppServerProtocolParseError", (error) =>
        logProtocol({
          direction: "incoming",
          stage: "decode_failed",
          payload: {
            operation: error.operation,
            ...(error.method === undefined ? {} : { method: error.method }),
            ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
            ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
            ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
            ...(error.maximumPathDepth === undefined
              ? {}
              : { maximumPathDepth: error.maximumPathDepth }),
          },
        }),
      ),
      Effect.flatMap(routeMessage),
    );
  };

  yield* options.stdio.stdin.pipe(
    Stream.interruptWhen(Deferred.await(terminationSignal)),
    Stream.decodeText(),
    Stream.runForEach(
      Effect.fnUntraced(function* (chunk) {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf("\n", start);
          const fragment = chunk.slice(start, newline === -1 ? chunk.length : newline);
          // decodeText holds back split UTF-8 sequences, so fragment byte sums are exact.
          remainderBytes += Buffer.byteLength(fragment, "utf8");
          if (remainderBytes > maxIncomingMessageBytes) {
            remainder.length = 0;
            return yield* new ZCodeError.ZCodeAppServerTransportError({
              operation: "read-input-stream",
              cause: new Error(`Incoming message exceeded ${maxIncomingMessageBytes} bytes.`),
            });
          }
          remainder.push(fragment);
          if (newline === -1) break;
          const line = remainder.join("").replace(/\r$/, "");
          remainder.length = 0;
          remainderBytes = 0;
          yield* handleLine(line);
          start = newline + 1;
        }
      }),
    ),
    Effect.matchEffect({
      onFailure: (error) =>
        handleTermination(() => Effect.succeed(normalizeIncomingError(error, "read-input-stream"))),
      onSuccess: () =>
        Effect.sync(() => {
          const line = remainder.join("");
          remainder.length = 0;
          return line;
        }).pipe(
          Effect.flatMap(handleLine),
          Effect.matchEffect({
            onFailure: (error) => handleTermination(() => Effect.succeed(error)),
            onSuccess: () =>
              handleTermination(() => {
                const ended = new ZCodeError.ZCodeAppServerInputStreamEndedError({});
                // stdout can close while the process keeps running; give the exit
                // status a brief grace before classifying termination.
                return options.terminationError === undefined
                  ? Effect.succeed(ended)
                  : options.terminationError.pipe(
                      Effect.timeoutOrElse({
                        duration: EXIT_STATUS_GRACE,
                        orElse: () => Effect.succeed(ended),
                      }),
                    );
              }),
          }),
        ),
    }),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);

  const request = Effect.fn("ZCodeAppServerProtocol.request")(function* (
    method: string,
    payload?: unknown,
  ) {
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1] as const,
    );
    const deferred = yield* Deferred.make<unknown, ZCodeError.ZCodeAppServerError>();
    yield* Ref.update(pending, (current) =>
      new Map(current).set(String(requestId), { deferred, method }),
    );
    yield* offerOutgoing({
      id: requestId,
      method,
      ...(payload !== undefined ? { params: payload } : {}),
    }).pipe(Effect.tapError(() => removePending(String(requestId))));
    const awaited = Deferred.await(deferred).pipe(
      Effect.onError(() => removePending(String(requestId))),
      Effect.onInterrupt(() => removePending(String(requestId))),
    );
    return yield* awaited.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(requestTimeoutMs),
        orElse: () =>
          Effect.fail(
            new ZCodeError.ZCodeAppServerRequestTimeoutError({
              method,
              requestId: String(requestId),
              timeoutMs: requestTimeoutMs,
            }),
          ),
      }),
    );
  });

  const notify = (method: string, payload?: unknown) =>
    offerOutgoing({
      method,
      ...(payload !== undefined ? { params: payload } : {}),
    });

  return {
    incomingNotifications: Stream.fromQueue(incomingNotifications),
    incomingRequests: Stream.fromQueue(incomingRequests),
    request,
    notify,
    respond,
    respondError,
  } satisfies ZCodeAppServerProtocol;
});
