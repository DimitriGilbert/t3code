// @effect-diagnostics nodeBuiltinImport:off - pack code is evaluated through
// node:vm so it gets no ambient Node globals (no require/process/fetch); the
// only capabilities it sees are the ones the runtime injects into the context.
import * as NodeVM from "node:vm";

import { WatchConnectorError, type WatchConnectorErrorReason } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * The pack code contract. A pack ships `connector.js`, evaluated server-side
 * in a fresh `node:vm` realm per run as a CommonJS-style module:
 *
 *   module.exports = {
 *     // http packs: fetch through ctx.fetch (egress-allowlisted)
 *     async fetch(ctx) { ... return rawData; },
 *     // optional; defaults to the raw fetch result / collected files
 *     async transform(raw, ctx) { ... return snapshot; },
 *     // optional; runs server-side when an upgrade/rollback re-pins an
 *     // instance: migrateConfig(fromVersion, toVersion, ctx) with
 *     // ctx.config = the instance's current config. Returns the new config.
 *     async migrateConfig(from, to, ctx) { ... return newConfig; },
 *   };
 *
 * There is no isolate in v1 — the vm realm only removes ambient power (no
 * `require`, `process`, `fetch`, or timers). The real mitigations are the
 * declared egress allowlist, declared secret keys, and human install confirm.
 */

/** File inside a pack bundle that carries the fetch/transform entry point. */
export const CONNECTOR_ENTRY_FILE = "connector.js";
/** Bounds synchronous module evaluation; async pack calls are untimed here. */
const EVAL_TIMEOUT_MS = 5_000;
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
}

/**
 * What pack code is allowed to see. `config` is the instance config the user
 * wrote; `fetch`/`files` are present per transport; `secrets` resolves only
 * manifest-declared keys.
 */
export interface ConnectorModuleContext {
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: ConnectorSecretsAccessor;
  /** http transport: the egress-allowlisted fetch. */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** file transport: matched file contents under the allowlisted roots. */
  readonly files?: Readonly<Record<string, string>>;
  /** Build the error to throw when upstream credentials are rejected. */
  readonly failAuthExpired: (message: string) => ConnectorAuthExpiredError;
}

export interface ConnectorModule {
  readonly fetch?: (ctx: ConnectorModuleContext) => unknown;
  readonly transform?: (raw: unknown, ctx: ConnectorModuleContext) => unknown;
  /**
   * Optional config migrator the versioned pack ships: invoked as
   * `migrateConfig(fromSchemaVersion, toSchemaVersion, ctx)` when a re-pin
   * (upgrade or rollback) lands. `ctx.config` is the instance's current
   * config; the return value replaces it after manifest re-validation.
   */
  readonly migrateConfig?: (from: number, to: number, ctx: ConnectorModuleContext) => unknown;
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
  };
};

/**
 * Evaluates a pack's `connector.js` in a fresh vm realm. The sandbox object
 * carries only `module`, `exports`, and `console` — there is deliberately no
 * `require`, `process`, `fetch`, or timer, so every capability the module uses
 * arrives through the context argument the poller builds.
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
  const exported = yield* Effect.try({
    try: () => {
      const moduleObject: { exports: unknown } = { exports: {} };
      const context = NodeVM.createContext({
        module: moduleObject,
        exports: moduleObject.exports,
        console,
      });
      new NodeVM.Script(source, { filename: CONNECTOR_ENTRY_FILE }).runInContext(context, {
        timeout: EVAL_TIMEOUT_MS,
      });
      return moduleObject.exports;
    },
    catch: (cause) =>
      connectorError("packCodeInvalid", `Connector ${CONNECTOR_ENTRY_FILE} failed to evaluate.`, {
        cause,
      }),
  });
  if (!Predicate.isObject(exported)) {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} must export an object.`,
    );
  }
  const candidate = exported as Record<string, unknown>;
  const fetchFn = candidate["fetch"];
  const transformFn = candidate["transform"];
  const migrateConfigFn = candidate["migrateConfig"];
  if (fetchFn !== undefined && typeof fetchFn !== "function") {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} export "fetch" is not a function.`,
    );
  }
  if (transformFn !== undefined && typeof transformFn !== "function") {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} export "transform" is not a function.`,
    );
  }
  if (migrateConfigFn !== undefined && typeof migrateConfigFn !== "function") {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} export "migrateConfig" is not a function.`,
    );
  }
  if (fetchFn === undefined && transformFn === undefined) {
    return yield* connectorError(
      "packCodeInvalid",
      `Connector ${CONNECTOR_ENTRY_FILE} must export a "fetch" or "transform" function.`,
    );
  }
  return {
    ...(fetchFn === undefined
      ? {}
      : { fetch: fetchFn as (ctx: ConnectorModuleContext) => unknown }),
    ...(transformFn === undefined
      ? {}
      : { transform: transformFn as (raw: unknown, ctx: ConnectorModuleContext) => unknown }),
    ...(migrateConfigFn === undefined
      ? {}
      : {
          migrateConfig: migrateConfigFn as (
            from: number,
            to: number,
            ctx: ConnectorModuleContext,
          ) => unknown,
        }),
  } satisfies ConnectorModule;
});

/**
 * Awaits a pack callback; its rejection lands as `Cause.UnknownError` with the
 * thrown value preserved on `cause` — the poller unwraps it to classify
 * auth-expired and secret-access markers.
 */
export const invokePackFunction = <A>(
  thunk: () => A | Promise<A>,
): Effect.Effect<A, Cause.UnknownError> => Effect.tryPromise(() => Promise.resolve().then(thunk));

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
