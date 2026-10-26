// @effect-diagnostics nodeBuiltinImport:off - the pack boundary is a real
// worker thread; spawning it needs node:worker_threads.
import * as NodeWorkerThreads from "node:worker_threads";

import { WatchConnectorError, type WatchConnectorErrorReason } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The pack code contract. A pack ships `connector.js`, evaluated server-side
 * as a CommonJS-style module inside a dedicated worker thread:
 *   module.exports = {
 */

/** File inside a pack bundle that carries the fetch/transform entry point. */
const CONNECTOR_ENTRY_FILE = "connector.js";
/** Bounds module evaluation inside the worker (and the eval request round-trip). */
const EVAL_TIMEOUT_MS = 5_000;
/** Bounds one pack call — fetch, transform, or migrateConfig — end to end. */
const PACK_INVOCATION_TIMEOUT_MS = 60_000;
/** Serialized snapshot byte cap — oversize output is rejected, never truncated. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** Thrown by pack code (`ctx.failAuthExpired`) to mark credentials as dead. */
export class ConnectorAuthExpiredError extends Error {
  readonly _tag = "ConnectorAuthExpiredError";
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthExpiredError";
  }
}

/**
 * Thrown when pack code touches a secret key the manifest never declared.
 * Surfaces to widgets as `configMismatch`, not a generic failure.
 */
export class ConnectorSecretAccessError extends Error {
  readonly _tag = "ConnectorSecretAccessError";
  constructor(key: string) {
    super(`Secret key "${key}" is not declared by the pack manifest.`);
    this.name = "ConnectorSecretAccessError";
  }
}

export interface ConnectorSecretsAccessor {
  /** Declared key → value, or undefined when no value is configured. Undeclared keys throw. */
  readonly get: (key: string) => string | undefined;
  /**
   * Manifest-declared keys — the worker rebuilds `get` against this list so
   * undeclared access throws inside pack code exactly as it does host-side.
   */
  readonly declared: ReadonlyArray<string>;
  /**
   * Declared∩configured values resolved on the host — the only secret
   * material that ever crosses the boundary, as plain data.
   */
  readonly resolved: Readonly<Record<string, string>>;
}

/**
 * What pack code is allowed to see. `config` is the instance config the user
 * wrote; `fetch`/`files` are present per transport; `secrets` resolves only
 * manifest-declared keys and is absent for `migrateConfig`.
 */
export interface ConnectorModuleContext {
  readonly config: Readonly<Record<string, unknown>>;
  /** Omitted for migrateConfig — migration transforms config, never reads secrets. */
  readonly secrets?: ConnectorSecretsAccessor;
  /**
   * http transport: the egress-allowlisted fetch. Inside the worker this is a
   * MessagePort RPC — pack code may pass a URL string or a request-like
   * `{url, method?, headers?, body?}` object; only those serializable fields
   * cross (no Request/Response construction, no AbortSignal).
   */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** file transport: matched file contents under the allowlisted roots. */
  readonly files?: Readonly<Record<string, string>>;
  /** Build the error to throw when upstream credentials are rejected. */
  readonly failAuthExpired: (message: string) => ConnectorAuthExpiredError;
}

/** The error channel a pack invocation can fail with. */
export type PackWorkerError = WatchConnectorError | Cause.UnknownError | Cause.TimeoutError;

export interface ConnectorModule {
  readonly fetch?: (ctx: ConnectorModuleContext) => Effect.Effect<unknown, PackWorkerError>;
  readonly transform?: (
    raw: unknown,
    ctx: ConnectorModuleContext,
  ) => Effect.Effect<unknown, PackWorkerError>;
  /**
   * Optional config migrator the versioned pack ships: invoked as
   * `migrateConfig(fromSchemaVersion, toSchemaVersion, ctx)` when a re-pin
   * (upgrade or rollback) lands. `ctx.config` is the instance's current
   */
  readonly migrateConfig?: (
    from: number,
    to: number,
    ctx: ConnectorModuleContext,
  ) => Effect.Effect<unknown, PackWorkerError>;
}

const connectorError = (
  reason: WatchConnectorErrorReason,
  message: string,
  options?: { readonly cause?: unknown },
) =>
  new WatchConnectorError({
    message,
    reason,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

/** Only declared keys resolve — anything else throws before a value could leak. */
export const makeSecretsAccessor = (
  declaredKeys: ReadonlyArray<string>,
  resolved: Readonly<Record<string, string>>,
): ConnectorSecretsAccessor => {
  const declared = new Set(declaredKeys);
  return {
    get: (key) => {
      if (!declared.has(key)) throw new ConnectorSecretAccessError(key);
      return resolved[key];
    },
    declared: declaredKeys,
    resolved,
  };
};

// ── Worker wire protocol ─────────────────────────────────────────────────

/** The ctx shape that actually crosses into the worker — data only. */
interface PackWorkerCtxMessage {
  readonly config: unknown;
  readonly files?: Record<string, string>;
  readonly secrets?: {
    readonly declared: ReadonlyArray<string>;
    readonly resolved: Record<string, string>;
  };
  /** Whether the worker should build a `ctx.fetch` RPC stub. */
  readonly fetch: boolean;
}

type PackWorkerRequest =
  | { readonly kind: "eval"; readonly source: string }
  | {
      readonly kind: "invoke";
      readonly source: string;
      readonly export: "fetch" | "transform" | "migrateConfig";
      readonly args: ReadonlyArray<unknown>;
      readonly ctx: PackWorkerCtxMessage;
    };

/** Serialized form of a value thrown by pack code (or a fetch-RPC failure). */
type PackWorkerThrown =
  | { readonly tag: "authExpired"; readonly message: string }
  | { readonly tag: "secretAccess"; readonly key: string; readonly message: string }
  | {
      readonly tag: "connectorError";
      readonly reason: string;
      readonly message: string;
      readonly field?: string;
    }
  | { readonly tag: "error"; readonly name: string; readonly message: string };

type PackWorkerMessage =
  | {
      readonly kind: "evalResult";
      readonly ok: true;
      readonly moduleIsObject: boolean;
      readonly exports: {
        readonly fetch?: string;
        readonly transform?: string;
        readonly migrateConfig?: string;
      };
    }
  | { readonly kind: "evalResult"; readonly ok: false; readonly error: PackWorkerThrown }
  | { readonly kind: "invokeResult"; readonly ok: true; readonly value: unknown }
  | { readonly kind: "invokeResult"; readonly ok: false; readonly error: PackWorkerThrown }
  | {
      readonly kind: "fetch";
      readonly id: number;
      readonly request: {
        readonly url: string;
        readonly method?: string;
        readonly headers?: Record<string, string>;
        readonly body?: string | ArrayBuffer;
      };
    };

type PackWorkerFetchOutcome =
  | {
      readonly ok: true;
      readonly response: {
        readonly status: number;
        readonly statusText: string;
        readonly headers: Record<string, string>;
        readonly body: ArrayBuffer | null;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly reason?: string;
        readonly field?: string;
      };
    };

type PackWorkerFetchReply = {
  readonly kind: "fetchResult";
  readonly id: number;
} & PackWorkerFetchOutcome;

/**
 * The worker bootstrap, evaluated inside each pack worker
 * (`new Worker(source, { eval: true })`) — inline so bundled/SEA builds ship
 * nothing extra. Plain CommonJS JavaScript; keep it free of backticks and
 * `${` (this file's template literal would interpolate them).
 */
const PACK_WORKER_SOURCE = `
"use strict";
const workerThreads = require("node:worker_threads");
const nodeModule = require("node:module");
const nodeVm = require("node:vm");
const parentPort = workerThreads.parentPort;
const workerData = workerThreads.workerData;

// Seal the realm before any pack source runs: module loading is closed for
// this thread, ambient host power is removed, the process was spawned with
// an empty environment, and the OS-level permission model denies
// filesystem/child-process/nested-worker operations outright.
nodeModule.registerHooks({
  resolve() { throw new Error("Pack workers cannot load modules."); },
  load() { throw new Error("Pack workers cannot load modules."); },
});
const ResponseCtor = globalThis.Response;
for (const key of [
  "process", "require", "module", "exports", "global", "__filename", "__dirname",
  "fetch", "Response", "Request", "Headers", "FormData", "XMLHttpRequest",
  "EventSource", "WebSocket", "BroadcastChannel", "Worker", "SharedArrayBuffer",
  "MessageChannel", "MessagePort", "navigator",
]) {
  try { delete globalThis[key]; } catch (_) {}
}

const EVAL_TIMEOUT_MS = ${EVAL_TIMEOUT_MS};

const serializeThrown = (thrown) => {
  if (thrown !== null && typeof thrown === "object") {
    const name = typeof thrown.name === "string" ? thrown.name : "Error";
    const message = typeof thrown.message === "string" ? thrown.message : String(thrown);
    if (name === "ConnectorAuthExpiredError") return { tag: "authExpired", message };
    if (name === "ConnectorSecretAccessError") {
      return {
        tag: "secretAccess",
        key: typeof thrown.key === "string" ? thrown.key : "",
        message,
      };
    }
    if (name === "WatchConnectorError" && typeof thrown.reason === "string") {
      return {
        tag: "connectorError",
        reason: thrown.reason,
        message,
        ...(typeof thrown.field === "string" ? { field: thrown.field } : {}),
      };
    }
    return { tag: "error", name, message };
  }
  return { tag: "error", name: "Error", message: String(thrown) };
};

const evalModule = (source) => {
  const moduleObject = { exports: {} };
  const sandbox = nodeVm.createContext({
    module: moduleObject,
    exports: moduleObject.exports,
    console,
  });
  new nodeVm.Script(source, { filename: "connector.js" }).runInContext(sandbox, {
    timeout: EVAL_TIMEOUT_MS,
  });
  return moduleObject.exports;
};

// ── ctx.fetch → host MessagePort RPC ──────────────────────────────────────

const pendingFetches = new Map();
let nextFetchId = 0;

const serializeHeaders = (headers) => {
  if (headers === null || headers === undefined) return undefined;
  const out = {};
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      out[String(key)] = String(value);
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
    }
    return out;
  }
  if (typeof headers === "object") {
    for (const key of Object.keys(headers)) out[key] = String(headers[key]);
    return out;
  }
  return undefined;
};

const serializeBody = (body) => {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    if (body[Symbol.toStringTag] === "ArrayBuffer") return body;
    if (ArrayBuffer.isView(body)) {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
  }
  throw new Error(
    "ctx.fetch bodies must be a string or ArrayBuffer. Other body types do not cross the pack boundary.",
  );
};

const serializeRequest = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input !== null && typeof input === "object" && typeof input.url === "string"
        ? input.url
        : undefined;
  if (url === undefined) {
    throw new Error("ctx.fetch input must be a URL string or a request-like {url} object.");
  }
  const request = { url };
  const method =
    (init !== null && init !== undefined && typeof init.method === "string" && init.method) ||
    (input !== null && typeof input === "object" && typeof input.method === "string"
      ? input.method
      : undefined);
  if (method !== undefined) request.method = String(method);
  const headers = serializeHeaders(
    init !== null && init !== undefined && init.headers !== undefined
      ? init.headers
      : input !== null && typeof input === "object"
        ? input.headers
        : undefined,
  );
  if (headers !== undefined) request.headers = headers;
  const body = serializeBody(
    init !== null && init !== undefined ? init.body : undefined,
  );
  if (body !== undefined) request.body = body;
  return request;
};

const fetchRpc = (input, init) =>
  new Promise((resolve, reject) => {
    let request;
    try {
      request = serializeRequest(input, init);
    } catch (error) {
      reject(error);
      return;
    }
    const id = ++nextFetchId;
    pendingFetches.set(id, { resolve, reject });
    parentPort.postMessage({ kind: "fetch", id, request });
  });

parentPort.on("message", (message) => {
  if (message === null || typeof message !== "object" || message.kind !== "fetchResult") return;
  const entry = pendingFetches.get(message.id);
  if (entry === undefined) return;
  pendingFetches.delete(message.id);
  if (message.ok) {
    const response = message.response;
    // 101/204/304 statuses may not carry a body.
    const statusAllowsBody =
      response.status !== 101 && response.status !== 204 && response.status !== 304;
    entry.resolve(
      new ResponseCtor(statusAllowsBody ? response.body : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    );
    return;
  }
  const error = new Error(message.error.message);
  error.name = message.error.name;
  if (typeof message.error.reason === "string") error.reason = message.error.reason;
  if (typeof message.error.field === "string") error.field = message.error.field;
  entry.reject(error);
});

// ── ctx assembly + dispatch ───────────────────────────────────────────────

const buildCtx = (data) => {
  const ctx = { config: data.config };
  if (data.files !== undefined) ctx.files = data.files;
  if (data.secrets !== undefined) {
    const declared = new Set(data.secrets.declared);
    const values = data.secrets.resolved;
    ctx.secrets = {
      get: (key) => {
        if (!declared.has(key)) {
          const error = new Error(
            'Secret key "' + String(key) + '" is not declared by the pack manifest.',
          );
          error.name = "ConnectorSecretAccessError";
          error.key = key;
          throw error;
        }
        return values[key];
      },
    };
  }
  if (data.fetch === true) ctx.fetch = fetchRpc;
  ctx.failAuthExpired = (message) => {
    const error = new Error(String(message));
    error.name = "ConnectorAuthExpiredError";
    return error;
  };
  return ctx;
};

const postResult = (message) => {
  try {
    parentPort.postMessage(message);
  } catch (error) {
    try {
      parentPort.postMessage({
        kind: "invokeResult",
        ok: false,
        error: {
          tag: "error",
          name: "Error",
          message:
            "Pack result could not cross the pack boundary (" +
            (error !== null && typeof error === "object" && typeof error.message === "string"
              ? error.message
              : String(error)) +
            ").",
        },
      });
    } catch (_) {}
  }
};

if (workerData !== null && typeof workerData === "object" && workerData.kind === "eval") {
  try {
    const exported = evalModule(workerData.source);
    const moduleIsObject = exported !== null && typeof exported === "object";
    const typeOf = (name) => {
      const kind = moduleIsObject ? typeof exported[name] : "undefined";
      // Normalize the typeof string to a real undefined so the host compares
      // against absent-vs-non-function export kinds correctly.
      return kind === "undefined" ? undefined : kind;
    };
    postResult({
      kind: "evalResult",
      ok: true,
      moduleIsObject,
      exports: {
        fetch: typeOf("fetch"),
        transform: typeOf("transform"),
        migrateConfig: typeOf("migrateConfig"),
      },
    });
  } catch (error) {
    postResult({ kind: "evalResult", ok: false, error: serializeThrown(error) });
  }
} else if (
  workerData !== null &&
  typeof workerData === "object" &&
  workerData.kind === "invoke"
) {
  try {
    const exported = evalModule(workerData.source);
    const name = workerData.export;
    const fn = exported !== null && typeof exported === "object" ? exported[name] : undefined;
    if (typeof fn !== "function") {
      throw new Error('Pack module does not export a "' + String(name) + '" function.');
    }
    const ctx = buildCtx(workerData.ctx);
    Promise.resolve()
      .then(() => fn(...workerData.args, ctx))
      .then(
        (value) => postResult({ kind: "invokeResult", ok: true, value }),
        (error) => postResult({ kind: "invokeResult", ok: false, error: serializeThrown(error) }),
      );
  } catch (error) {
    postResult({ kind: "invokeResult", ok: false, error: serializeThrown(error) });
  }
}
`;

const marshalCtx = (ctx: ConnectorModuleContext): PackWorkerCtxMessage => ({
  config: ctx.config,
  ...(ctx.files === undefined ? {} : { files: { ...ctx.files } }),
  ...(ctx.secrets === undefined
    ? {}
    : {
        secrets: {
          declared: [...ctx.secrets.declared],
          resolved: { ...ctx.secrets.resolved },
        },
      }),
  fetch: ctx.fetch !== undefined,
});

const isConnectorError = Schema.is(WatchConnectorError);

const serializeFetchError = (
  cause: unknown,
): { name: string; message: string; reason?: string; field?: string } => {
  if (isConnectorError(cause)) {
    return {
      name: "WatchConnectorError",
      message: cause.message,
      ...(cause.reason === undefined ? {} : { reason: cause.reason }),
      ...(cause.field === undefined ? {} : { field: cause.field }),
    };
  }
  return {
    name: cause instanceof Error ? cause.name : "Error",
    message: cause instanceof Error ? cause.message : String(cause),
  };
};

/** Answers one `ctx.fetch` RPC from the worker through the host-side impl. */
const handleFetchRequest = (
  ctx: ConnectorModuleContext,
  message: Extract<PackWorkerMessage, { kind: "fetch" }>,
  post: (reply: PackWorkerFetchReply) => void,
) => {
  const reply = (outcome: PackWorkerFetchOutcome) =>
    post({ kind: "fetchResult", id: message.id, ...outcome });
  const impl = ctx.fetch;
  if (impl === undefined) {
    reply({
      ok: false,
      error: { name: "Error", message: "ctx.fetch is not available to this connector." },
    });
    return;
  }
  const init: RequestInit = {};
  if (message.request.method !== undefined) init.method = message.request.method;
  if (message.request.headers !== undefined) init.headers = message.request.headers;
  if (message.request.body !== undefined) init.body = message.request.body;
  impl(message.request.url, init).then(
    (response) =>
      response.arrayBuffer().then(
        (body) =>
          reply({
            ok: true,
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body,
            },
          }),
        (cause) => reply({ ok: false, error: serializeFetchError(cause) }),
      ),
    (cause) => reply({ ok: false, error: serializeFetchError(cause) }),
  );
};

/** Rebuilds a thrown value the worker serialized — pack-thrown markers keep their types. */
const rebuildThrown = (thrown: PackWorkerThrown): Cause.UnknownError => {
  switch (thrown.tag) {
    case "authExpired":
      return new Cause.UnknownError(new ConnectorAuthExpiredError(thrown.message));
    case "secretAccess":
      return new Cause.UnknownError(new ConnectorSecretAccessError(thrown.key));
    case "connectorError":
      return new Cause.UnknownError(
        new WatchConnectorError({
          message: thrown.message,
          reason: thrown.reason as WatchConnectorErrorReason,
          ...(thrown.field === undefined ? {} : { field: thrown.field }),
        }),
      );
    default: {
      const error = new Error(thrown.message);
      error.name = thrown.name;
      return new Cause.UnknownError(error);
    }
  }
};

/**
 * Spawns one pack worker, feeds it `request`, and resolves with the first
 * terminal result. On completion, failure, or interruption (including
 * timeout) the worker is terminated — a `while(1){}` or a wedged promise
 * dies with its deadline rather than leaking a thread.
 */
const runPackWorker = <A>(
  request: PackWorkerRequest,
  options: {
    readonly timeoutMs: number;
    readonly onMessage: (
      message: PackWorkerMessage,
      post: (reply: PackWorkerFetchReply) => void,
    ) => Effect.Effect<A, PackWorkerError> | null;
  },
): Effect.Effect<A, PackWorkerError> =>
  Effect.callback<A, PackWorkerError>((resume) => {
    let worker: NodeWorkerThreads.Worker;
    try {
      worker = new NodeWorkerThreads.Worker(PACK_WORKER_SOURCE, {
        eval: true,
        env: {},
        execArgv: ["--permission"],
        workerData: request,
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
    } catch (cause) {
      resume(
        Effect.fail(connectorError("packCodeInvalid", "Could not start a pack worker.", { cause })),
      );
      return;
    }
    const terminate = () => {
      void worker.terminate().catch(() => undefined);
    };
    const done = (effect: Effect.Effect<A, PackWorkerError>) => {
      terminate();
      resume(effect);
    };
    worker.on("message", (message: PackWorkerMessage) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads.postMessage takes no targetOrigin; the rule is DOM-shaped.
      const out = options.onMessage(message, (reply) => worker.postMessage(reply));
      if (out !== null) done(out);
    });
    worker.once("error", (cause) =>
      done(Effect.fail(connectorError("packCodeInvalid", "Pack worker failed.", { cause }))),
    );
    worker.once("exit", (code) =>
      done(
        Effect.fail(
          connectorError(
            "packCodeInvalid",
            code === 0
              ? "Pack worker exited without a result."
              : `Pack worker exited with code ${code}.`,
          ),
        ),
      ),
    );
    return Effect.sync(terminate);
  }).pipe(Effect.timeout(options.timeoutMs));

/** Evaluates `connector.js` inside a fresh worker and reports the export map. */
const evalPackModule = (source: string) =>
  runPackWorker<Extract<PackWorkerMessage, { kind: "evalResult"; ok: true }>>(
    { kind: "eval", source },
    {
      timeoutMs: EVAL_TIMEOUT_MS,
      onMessage: (message) => {
        if (message.kind !== "evalResult") return null;
        if (!message.ok) {
          return Effect.fail(
            connectorError(
              "packCodeInvalid",
              `Connector ${CONNECTOR_ENTRY_FILE} failed to evaluate.`,
              { cause: rebuildThrown(message.error) },
            ),
          );
        }
        return Effect.succeed(message);
      },
    },
  );

/** One export call in one worker: eval the module, invoke, serialize the result back. */
const invokePackExport = (
  source: string,
  name: "fetch" | "transform" | "migrateConfig",
  args: ReadonlyArray<unknown>,
  ctx: ConnectorModuleContext,
): Effect.Effect<unknown, PackWorkerError> =>
  runPackWorker<unknown>(
    { kind: "invoke", source, export: name, args, ctx: marshalCtx(ctx) },
    {
      timeoutMs: PACK_INVOCATION_TIMEOUT_MS,
      onMessage: (message, post) => {
        if (message.kind === "fetch") {
          handleFetchRequest(ctx, message, post);
          return null;
        }
        if (message.kind !== "invokeResult") return null;
        return message.ok
          ? Effect.succeed(message.value)
          : Effect.fail(rebuildThrown(message.error));
      },
    },
  );

/**
 * Evaluates a pack's `connector.js` inside a worker to inspect its exports —
 * the sandbox carries only `module`, `exports`, and `console`, so every
 * capability the module uses arrives through the ctx argument at call time.
 * The returned methods each spawn a fresh worker for their invocation.
 */
export const evalConnectorModule = Effect.fn("ConnectorPackModule.eval")(function* (
  files: Readonly<Record<string, string>>,
) {
  const source = files[CONNECTOR_ENTRY_FILE];
  if (source === undefined) {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector pack has no ${CONNECTOR_ENTRY_FILE} entry file.`,
    );
  }
  const evaluated = yield* evalPackModule(source);
  if (!evaluated.moduleIsObject) {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} must export an object.`,
    );
  }
  const fetchKind = evaluated.exports.fetch;
  const transformKind = evaluated.exports.transform;
  const migrateConfigKind = evaluated.exports.migrateConfig;
  if (fetchKind !== undefined && fetchKind !== "function") {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} export "fetch" is not a function.`,
    );
  }
  if (transformKind !== undefined && transformKind !== "function") {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} export "transform" is not a function.`,
    );
  }
  if (migrateConfigKind !== undefined && migrateConfigKind !== "function") {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} export "migrateConfig" is not a function.`,
    );
  }
  if (fetchKind !== "function" && transformKind !== "function") {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} must export a "fetch" or "transform" function.`,
    );
  }
  return {
    ...(fetchKind === "function"
      ? {
          fetch: (ctx: ConnectorModuleContext) => invokePackExport(source, "fetch", [], ctx),
        }
      : {}),
    ...(transformKind === "function"
      ? {
          transform: (raw: unknown, ctx: ConnectorModuleContext) =>
            invokePackExport(source, "transform", [raw], ctx),
        }
      : {}),
    ...(migrateConfigKind === "function"
      ? {
          migrateConfig: (from: number, to: number, ctx: ConnectorModuleContext) =>
            invokePackExport(source, "migrateConfig", [from, to], ctx),
        }
      : {}),
  } satisfies ConnectorModule;
});

/**
 * Awaits a pack call. The thunk may return a plain value, a Promise, or an
 * Effect — the pack module's methods return the invocation Effect, so an
 * interruption (timeout, cancellation) terminates the underlying worker
 */
export const invokePackFunction = <A, E = Cause.UnknownError>(
  thunk: () => A | Promise<A> | Effect.Effect<A, E>,
): Effect.Effect<Awaited<A>, E | Cause.UnknownError> =>
  Effect.suspend((): Effect.Effect<Awaited<A>, E | Cause.UnknownError> => {
    let out: A | Promise<A> | Effect.Effect<A, E>;
    try {
      out = thunk();
    } catch (cause) {
      return Effect.fail(new Cause.UnknownError(cause));
    }
    if (Effect.isEffect(out)) {
      return out as Effect.Effect<Awaited<A>, E>;
    }
    return Effect.tryPromise(() => Promise.resolve(out) as Promise<Awaited<A>>);
  });

const unknownJson = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(unknownJson);

/**
 * Serializes transform output and enforces the snapshot size cap. A result
 * over `MAX_SNAPSHOT_BYTES` is rejected with `snapshotTooLarge` — it is never
 * truncated onto the wire.
 */
export const serializeSnapshot = Effect.fn("ConnectorPackModule.serializeSnapshot")(function* (
  value: unknown,
) {
  const json = yield* Effect.try({
    try: () => encodeJson(value),
    catch: (cause) =>
      connectorError("packCodeInvalid", "Connector transform output is not JSON-serializable.", {
        cause,
      }),
  });
  if (Buffer.byteLength(json, "utf8") > MAX_SNAPSHOT_BYTES) {
    return yield* connectorError(
      "snapshotTooLarge",
      `Connector snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte limit.`,
    );
  }
  return json;
});
