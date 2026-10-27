import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ZCodeError from "./errors.ts";
import * as ZCodeProtocol from "./protocol.ts";
import * as ZCodeRpc from "./rpc.ts";
import * as ZCodeSchema from "./schema.ts";
import {
  decodeNotificationPayload,
  decodeOptionalPayload,
  encodeOptionalPayload,
  runHandler,
} from "./_internal/shared.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";

export interface ZCodeAppServerClientOptions {
  // Gate requests until the first legal startup/storageState frame arrives;
  // zcode's own client only waits once a non-terminal phase lands unless
  // requireStorageStartup is set. T3 spawns app-server directly, so require.
  readonly requireStorageStartup?: boolean;
  // zcode defaults to 30s before the first storage status must arrive.
  readonly storageStartupFirstStatusTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (
    event: ZCodeProtocol.ZCodeAppServerProtocolLogEvent,
  ) => Effect.Effect<void, never>;
}

interface ZCodeAppServerClientRaw {
  readonly notifications: ZCodeProtocol.ZCodeAppServerProtocol["incomingNotifications"];
  readonly requests: ZCodeProtocol.ZCodeAppServerProtocol["incomingRequests"];
  readonly request: ZCodeProtocol.ZCodeAppServerProtocol["request"];
  readonly notify: ZCodeProtocol.ZCodeAppServerProtocol["notify"];
  readonly respond: ZCodeProtocol.ZCodeAppServerProtocol["respond"];
  readonly respondError: ZCodeProtocol.ZCodeAppServerProtocol["respondError"];
}

export class ZCodeAppServerClient extends Context.Service<
  ZCodeAppServerClient,
  {
    readonly raw: ZCodeAppServerClientRaw;
    readonly storageStartupState: Ref.Ref<Option.Option<ZCodeSchema.ZCodeStorageStartupState>>;
    readonly request: <M extends ZCodeRpc.ClientRequestMethod>(
      method: M,
      payload: ZCodeRpc.ClientRequestParamsByMethod[M],
    ) => Effect.Effect<ZCodeRpc.ClientRequestResponsesByMethod[M], ZCodeError.ZCodeAppServerError>;
    readonly notify: (
      method: string,
      payload?: unknown,
    ) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>;
    readonly handleServerRequest: <M extends ZCodeRpc.ServerRequestMethod>(
      method: M,
      handler: (
        payload: ZCodeRpc.ServerRequestParamsByMethod[M],
      ) => Effect.Effect<
        ZCodeRpc.ServerRequestResponsesByMethod[M],
        ZCodeError.ZCodeAppServerError
      >,
    ) => Effect.Effect<void>;
    /**
     * Handlers run on dedicated fibers off the read loop (like upstream's
     * unawaited listeners), so they may yield client.request/notify safely.
     * Handler failures are swallowed, matching upstream's fire-and-forget.
     */
    readonly handleServerNotification: <M extends ZCodeRpc.ServerNotificationMethod>(
      method: M,
      handler: (
        payload: ZCodeRpc.ServerNotificationParamsByMethod[M],
      ) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerRequest: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerNotification: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/effect-zcode-protocol/client/ZCodeAppServerClient") {}

type ServerRequestHandler = (
  payload: unknown,
) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>;
type ServerNotificationHandler = (
  payload: unknown,
) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>;

const FIRST_STATUS_TIMEOUT_MS = 30_000;
const isStorageState = Schema.is(ZCodeSchema.ZCodeStorageStartupState);
const isStorageErrorCode = Schema.is(ZCodeError.ZCodeStorageStartupErrorCode);

type StorageGatePhase = "open" | "waiting" | "ready" | "failed";

// Port of zcode's ZCodeStorageStartupGate: accept only the first legal frame
// of an (attemptId, databaseId) pair with a strictly increasing sequence;
// ready unblocks, failed poisons the gate permanently.
const makeStorageGate = Effect.fnUntraced(function* (required: boolean) {
  const current = yield* Ref.make(Option.none<ZCodeSchema.ZCodeStorageStartupState>());
  const state = yield* Ref.make<StorageGatePhase>(required ? "waiting" : "open");
  const ready = yield* Deferred.make<void, ZCodeError.ZCodeAppServerStorageStartupError>();
  // Separate from `ready`: succeeds/fails only on terminal failure so in-flight
  // requests can race it even after the gate opened.
  const failed = yield* Deferred.make<void, ZCodeError.ZCodeAppServerStorageStartupError>();
  const terminalError = yield* Ref.make(
    Option.none<ZCodeError.ZCodeAppServerStorageStartupError>(),
  );

  const fail = (error: ZCodeError.ZCodeAppServerStorageStartupError) =>
    Ref.get(state).pipe(
      Effect.flatMap((phase) =>
        phase === "failed"
          ? Effect.void
          : Ref.set(state, "failed").pipe(
              Effect.andThen(Ref.set(terminalError, Option.some(error))),
              Effect.andThen(Deferred.fail(ready, error)),
              Effect.andThen(Deferred.fail(failed, error)),
            ),
      ),
      Effect.asVoid,
    );

  const accept = Effect.fn("ZCodeAppServerClient.storageGate.accept")(function* (params: unknown) {
    if (!isStorageState(params)) return false;
    const phase = yield* Ref.get(state);
    if (phase === "ready" || phase === "failed") return false;
    const existing = yield* Ref.get(current);
    if (
      Option.isSome(existing) &&
      (existing.value.attemptId !== params.attemptId ||
        existing.value.databaseId !== params.databaseId ||
        params.sequence <= existing.value.sequence)
    ) {
      return false;
    }
    yield* Ref.set(current, Option.some(params));
    if (params.phase === "ready") {
      yield* Ref.set(state, "ready");
      yield* Deferred.succeed(ready, undefined);
    } else if (params.phase === "failed") {
      const code = isStorageErrorCode(params.errorCode) ? params.errorCode : "sql_failed";
      yield* fail(
        new ZCodeError.ZCodeAppServerStorageStartupError({
          errorCode: code,
          attemptId: params.attemptId,
          databaseId: params.databaseId,
        }),
      );
    } else {
      yield* Ref.set(state, "waiting");
    }
    return true;
  });

  const isWaiting = Ref.get(state).pipe(Effect.map((phase) => phase === "waiting"));

  const awaitReady: Effect.Effect<void, ZCodeError.ZCodeAppServerStorageStartupError> = Effect.gen(
    function* () {
      const phase = yield* Ref.get(state);
      if (phase === "open" || phase === "ready") return;
      if (phase === "failed") {
        const error = yield* Ref.get(terminalError);
        return yield* Option.getOrElse(
          error,
          () =>
            new ZCodeError.ZCodeAppServerStorageStartupError({
              errorCode: "transport_closed",
            }),
        );
      }
      yield* Deferred.await(ready);
    },
  );

  const close = (error: ZCodeError.ZCodeAppServerError) =>
    isWaiting.pipe(
      Effect.flatMap((wasWaiting) =>
        wasWaiting
          ? fail(
              new ZCodeError.ZCodeAppServerStorageStartupError({
                errorCode: "transport_closed",
                cause: error,
              }),
            )
          : Effect.void,
      ),
    );

  return {
    accept,
    isWaiting,
    awaitReady,
    awaitFailed: Deferred.await(failed),
    close,
    current,
    fail,
  };
});

export const make = Effect.fn("effect-zcode-protocol/ZCodeAppServerClient.make")(function* (
  stdio: Stdio.Stdio,
  options: ZCodeAppServerClientOptions = {},
  terminationError?: Effect.Effect<ZCodeError.ZCodeAppServerError>,
): Effect.fn.Return<ZCodeAppServerClient["Service"], never, Scope.Scope> {
  const requestHandlers = new Map<string, ServerRequestHandler>();
  const notificationHandlers = new Map<string, Array<ServerNotificationHandler>>();
  let unknownRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, ZCodeError.ZCodeAppServerError>)
    | undefined;
  let unknownNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, ZCodeError.ZCodeAppServerError>)
    | undefined;

  const clientScope = yield* Scope.Scope;
  const gate = yield* makeStorageGate(options.requireStorageStartup ?? true);
  // Notifications dispatch on one drain fiber fed by the read loop, so handlers
  // apply frames in wire order. Upstream's fire-and-forget listeners reorder
  // per-frame work; topic state (revisions, row windows) is order-sensitive.
  const notificationQueue =
    yield* Queue.unbounded<ZCodeProtocol.ZCodeAppServerIncomingNotification>();

  // First-status watchdog only applies while the gate requires storage.
  // Upstream cancels it on the first ACCEPTED startup frame, so only a missing
  // first frame (gate.current still empty) can trip startup_status_timeout.
  if (options.requireStorageStartup ?? true) {
    const timeout = options.storageStartupFirstStatusTimeoutMs ?? FIRST_STATUS_TIMEOUT_MS;
    yield* Effect.sleep(timeout).pipe(
      Effect.andThen(
        Ref.get(gate.current).pipe(
          Effect.flatMap((current) =>
            Option.isNone(current)
              ? gate.fail(
                  new ZCodeError.ZCodeAppServerStorageStartupError({
                    errorCode: "startup_status_timeout",
                  }),
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }

  const getSchema = <M extends string>(
    table: Record<string, Schema.Codec<unknown, unknown> | undefined>,
    method: M,
  ) => table[method] as Schema.Codec<unknown, unknown> | undefined;

  const dispatchNotification = (
    notification: ZCodeProtocol.ZCodeAppServerIncomingNotification,
  ): Effect.Effect<void, never> => {
    if (notification.method === "startup/storageState") {
      return gate
        .accept(notification.params)
        .pipe(Effect.andThen(Queue.offer(notificationQueue, notification)), Effect.ignore);
    }
    return Queue.offer(notificationQueue, notification).pipe(Effect.asVoid);
  };

  // Notification handlers run on the drain fiber off the read loop, like
  // upstream's unawaited emitter listeners: a handler may call
  // client.request/notify without deadlocking the read loop. The storage gate
  // stays on the read fiber so startup frames are always accepted in wire order.
  const dispatchQueuedNotification = (
    notification: ZCodeProtocol.ZCodeAppServerIncomingNotification,
  ): Effect.Effect<void, never> => {
    const schema = getSchema(ZCodeRpc.SERVER_NOTIFICATION_PARAMS, notification.method);
    const handlers = notificationHandlers.get(notification.method) ?? [];

    return schema
      ? decodeNotificationPayload(notification.method, schema, notification.params).pipe(
          Effect.flatMap((decoded) =>
            Effect.forEach(handlers, (handler) => handler(decoded), { discard: true }),
          ),
          Effect.ignore,
        )
      : unknownNotificationHandler
        ? unknownNotificationHandler(notification.method, notification.params).pipe(Effect.ignore)
        : Effect.void;
  };

  yield* Queue.take(notificationQueue).pipe(
    Effect.andThen(dispatchQueuedNotification),
    Effect.forever,
    Effect.forkIn(clientScope),
  );

  const dispatchRequest = (
    request: ZCodeProtocol.ZCodeAppServerIncomingRequest,
  ): Effect.Effect<unknown, ZCodeError.ZCodeAppServerError> => {
    if (request.method in ZCodeRpc.SERVER_REQUEST_PARAMS) {
      const method = request.method as ZCodeRpc.ServerRequestMethod;
      const payloadSchema = getSchema(ZCodeRpc.SERVER_REQUEST_PARAMS, method);
      const responseSchema = getSchema(ZCodeRpc.SERVER_REQUEST_RESPONSES, method);
      const handler = requestHandlers.get(method);

      return decodeOptionalPayload(method, payloadSchema, request.params).pipe(
        Effect.flatMap((decoded) => runHandler(handler, decoded, method)),
        Effect.flatMap((result) => encodeOptionalPayload(method, responseSchema, result)),
      );
    }

    return unknownRequestHandler
      ? unknownRequestHandler(request.method, request.params)
      : Effect.fail(ZCodeError.ZCodeAppServerRequestError.methodNotFound(request.method));
  };

  const transport = yield* ZCodeProtocol.makeZCodeAppServerProtocol({
    stdio,
    ...(terminationError ? { terminationError } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: dispatchNotification,
    onRequest: dispatchRequest,
    onTermination: (error) => gate.close(error),
  });

  const request = <M extends ZCodeRpc.ClientRequestMethod>(
    method: M,
    payload: ZCodeRpc.ClientRequestParamsByMethod[M],
  ): Effect.Effect<ZCodeRpc.ClientRequestResponsesByMethod[M], ZCodeError.ZCodeAppServerError> =>
    Effect.gen(function* () {
      // Storage gate: requests wait once a non-terminal frame landed (or
      // immediately when required); a failed phase rejects everything —
      // including sends already in flight, raced against the gate failure.
      yield* gate.awaitReady;
      const encoded = yield* encodeOptionalPayload(
        method,
        getSchema(ZCodeRpc.CLIENT_REQUEST_PARAMS, method),
        payload,
      );
      const raw = yield* transport
        .request(method, encoded)
        .pipe(Effect.raceFirst(gate.awaitFailed));
      return yield* decodeOptionalPayload(
        method,
        getSchema(ZCodeRpc.CLIENT_REQUEST_RESPONSES, method),
        raw,
      );
    }) as Effect.Effect<ZCodeRpc.ClientRequestResponsesByMethod[M], ZCodeError.ZCodeAppServerError>;

  // Notifies are not storage-gated: control frames (e.g. connection/flow) must
  // flow while storage is still starting, same as upstream's send path.
  const notify = (method: string, payload?: unknown) => transport.notify(method, payload);

  return ZCodeAppServerClient.of({
    raw: {
      notifications: transport.incomingNotifications,
      requests: transport.incomingRequests,
      request: transport.request,
      notify: transport.notify,
      respond: transport.respond,
      respondError: transport.respondError,
    },
    storageStartupState: gate.current,
    request,
    notify,
    handleServerRequest: Effect.fn("ZCodeAppServerClient.handleServerRequest")(
      function (method, handler) {
        return Effect.sync(() => {
          requestHandlers.set(method, handler as ServerRequestHandler);
        });
      },
    ),
    handleServerNotification: Effect.fn("ZCodeAppServerClient.handleServerNotification")(
      function (method, handler) {
        return Effect.sync(() => {
          const current = notificationHandlers.get(method) ?? [];
          current.push(handler as ServerNotificationHandler);
          notificationHandlers.set(method, current);
        });
      },
    ),
    handleUnknownServerRequest: Effect.fn("ZCodeAppServerClient.handleUnknownServerRequest")(
      function (handler) {
        return Effect.sync(() => {
          unknownRequestHandler = handler;
        });
      },
    ),
    handleUnknownServerNotification: Effect.fn(
      "ZCodeAppServerClient.handleUnknownServerNotification",
    )(function (handler) {
      return Effect.sync(() => {
        unknownNotificationHandler = handler;
      });
    }),
  });
});

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: ZCodeAppServerClientOptions = {},
): Layer.Layer<ZCodeAppServerClient> =>
  Layer.effect(ZCodeAppServerClient, makeChildProcessClient(handle, options));

const makeChildProcessClient = Effect.fn(
  "effect-zcode-protocol/ZCodeAppServerClient.makeChildProcessClient",
)(function* (handle: ChildProcessSpawner.ChildProcessHandle, options: ZCodeAppServerClientOptions) {
  // stderr is diagnostics-only; log chunks at debug, matching logProtocol's level.
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.logDebug("ZCode app-server stderr").pipe(Effect.annotateLogs({ stderr: chunk })),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  return yield* make(makeChildStdio(handle), options, makeTerminationError(handle));
});
