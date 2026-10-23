import {
  WatchConnectorError,
  type WatchConnectorErrorReason,
  WatchConnectorHealth,
  WatchConnectorInstallRequest,
  WatchConnectorInstallRequestId,
  WatchConnectorInstance,
  WatchConnectorInstanceId,
  WatchConnectorOrigin,
  WatchConnectorPack,
  WatchConnectorPackId,
  WatchConnectorPackManifest,
  WatchNotificationId,
  WatchPackWidgetSource,
  WatchWidgetSourceId,
  type WatchConnectorCancelInstallRequestInput,
  type WatchConnectorConfirmResult,
  type WatchConnectorConfirmInstallInput,
  type WatchConnectorConfirmUpgradeInput,
  type WatchConnectorCreateInstanceInput,
  type WatchConnectorDeleteInstanceInput,
  type WatchConnectorDeleteInstanceResult,
  type WatchConnectorInstallRequestResult,
  type WatchConnectorInstanceResult,
  type WatchConnectorPrepareInstallConfirmInput,
  type WatchConnectorPrepareInstallConfirmResult,
  type WatchConnectorPreparePurgeInput,
  type WatchConnectorPreparePurgeResult,
  type WatchConnectorPurgeInstanceDataInput,
  type WatchConnectorPurgeResult,
  type WatchConnectorRequestInstallInput,
  type WatchConnectorRequestUpgradeInput,
  type WatchConnectorRollbackInput,
  type WatchConnectorSetInstanceConfigInput,
  type WatchConnectorUninstallInput,
  type WatchConnectorUninstallResult,
  type WatchConnectorUpdateInstanceInput,
  type WatchConnectorsListInput,
  type WatchConnectorsListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { UserNotificationService } from "../../notifications/UserNotificationService.ts";
import * as WidgetTranspileService from "../WidgetTranspileService.ts";
import * as ConfirmationTokens from "./ConfirmationTokens.ts";
import * as PackModule from "./PackModule.ts";
import * as PackStore from "./PackStore.ts";

/**
 * Connector pack registry: pending install requests, human-confirmed
 * installs, and instance rows. The split that matters for security:
 *
 * - `requestInstall`/`requestUpgrade` are agent-reachable — they record a
 *   *pending* row, fetching the origin only when it is a local path or a
 *   public https URL. An https URL resolving to a loopback/link-local/
 *   private address is recorded unfetched (`local_url`): an agent can never
 *   trigger a private-range fetch, and a request-supplied `allowLocalUrl`
 *   flag is stripped before anything is stored or fetched.
 * - `prepareInstallConfirm` mints the single-use token bound to
 *   `(requestId, manifestHash)`. For `local_url` requests it also performs
 *   the deferred fetch, but only with an explicit `allowLocalUrl`
 *   acknowledgement on the call. It is a standard-scope RPC but absent from
 *   the MCP toolkit, so an agent can never mint one.
 * - `confirmInstall`/`confirmUpgrade`/`cancelInstallRequest` — the confirms
 *   sit behind `environment:maintain` + `CLIENT_GUARDED_RPC_SCOPES` and a
 *   valid token. Confirm re-fetches the origin and requires the bundle to
 *   hash to the pin recorded at request time, so the bytes a human approved
 *   are the bytes installed.
 */
export class ConnectorService extends Context.Service<
  ConnectorService,
  {
    readonly list: (
      input: WatchConnectorsListInput,
    ) => Effect.Effect<WatchConnectorsListResult, WatchConnectorError>;
    /** Emits the full connector list on subscribe and again after every change. */
    readonly subscribeList: (
      input: WatchConnectorsListInput,
    ) => Stream.Stream<WatchConnectorsListResult, WatchConnectorError>;
    readonly createInstance: (
      input: WatchConnectorCreateInstanceInput,
    ) => Effect.Effect<WatchConnectorInstanceResult, WatchConnectorError>;
    readonly updateInstance: (
      input: WatchConnectorUpdateInstanceInput,
    ) => Effect.Effect<WatchConnectorInstanceResult, WatchConnectorError>;
    readonly deleteInstance: (
      input: WatchConnectorDeleteInstanceInput,
    ) => Effect.Effect<WatchConnectorDeleteInstanceResult, WatchConnectorError>;
    /**
     * Replaces instance config (validated against the pinned manifest's auth
     * schema) and writes declared secret values into the secret store by key.
     * Secret values never reach the instance row or a client: config entries
     * keyed by a declared secret name are rejected, migrated config is
     * scrubbed of secret material before persist, and re-pins prune stored
     * keys the new manifest no longer declares.
     */
    readonly setInstanceConfig: (
      input: WatchConnectorSetInstanceConfigInput,
    ) => Effect.Effect<WatchConnectorInstanceResult, WatchConnectorError>;
    /**
     * Server-side only (never an RPC): the instance row, its pinned manifest,
     * and the resolved values of its manifest-declared configured secrets —
     * what a poll run needs. Archived or missing instances fail.
     */
    readonly loadRuntime: (
      instanceId: WatchConnectorInstanceId,
    ) => Effect.Effect<ConnectorRuntimeInfo, WatchConnectorError>;
    /**
     * Server-side only: health writes from the poller, rollback, and
     * confirm. `patch` is a delta merged onto the stored row inside a
     * transaction, so one writer's stale read never clobbers fields another
     * writer touched (`lastRollback` stays sticky because poller writes
     * never name it). `updated_at` is untouched so subscribers diffing
     * instance rows see health as health, not a config change.
     */
    readonly recordHealth: (
      instanceId: WatchConnectorInstanceId,
      patch: Partial<WatchConnectorHealth>,
    ) => Effect.Effect<void, WatchConnectorError>;
    readonly requestInstall: (
      input: WatchConnectorRequestInstallInput,
    ) => Effect.Effect<WatchConnectorInstallRequestResult, WatchConnectorError>;
    readonly requestUpgrade: (
      input: WatchConnectorRequestUpgradeInput,
    ) => Effect.Effect<WatchConnectorInstallRequestResult, WatchConnectorError>;
    readonly prepareInstallConfirm: (
      input: WatchConnectorPrepareInstallConfirmInput,
    ) => Effect.Effect<WatchConnectorPrepareInstallConfirmResult, WatchConnectorError>;
    readonly confirmInstall: (
      input: WatchConnectorConfirmInstallInput,
    ) => Effect.Effect<WatchConnectorConfirmResult, WatchConnectorError>;
    readonly confirmUpgrade: (
      input: WatchConnectorConfirmUpgradeInput,
    ) => Effect.Effect<WatchConnectorConfirmResult, WatchConnectorError>;
    readonly cancelInstallRequest: (
      input: WatchConnectorCancelInstallRequestInput,
    ) => Effect.Effect<WatchConnectorInstallRequestResult, WatchConnectorError>;
    /**
     * Re-pins an instance to a previously-approved pack version — no fetch:
     * the target's hash-pinned files are already on disk. Runs the target
     * pack's `migrateConfig` when it ships one; a failed migration keeps the
     * instance's config and flags it unhealthy so widgets render the typed
     * `configMismatch` state. Every rollback lands in notification history
     * and on `health.lastRollback` for the Connector status widget.
     */
    readonly rollback: (
      input: WatchConnectorRollbackInput,
    ) => Effect.Effect<WatchConnectorInstanceResult, WatchConnectorError>;
    /**
     * Soft-archives every version of a pack and all of its instances —
     * polling stops (subscribers get `connectorMissing`), config is
     * retained, and bound widgets degrade to the missing-connector
     * placeholder. Reinstalling an archived version revives its instances.
     */
    readonly uninstall: (
      input: WatchConnectorUninstallInput,
    ) => Effect.Effect<WatchConnectorUninstallResult, WatchConnectorError>;
    /**
     * Human-only (no MCP tool): describes what purging a fully-archived pack
     * destroys and mints a single-use token bound to that descriptor.
     */
    readonly preparePurge: (
      input: WatchConnectorPreparePurgeInput,
    ) => Effect.Effect<WatchConnectorPreparePurgeResult, WatchConnectorError>;
    /**
     * The destructive counterpart to soft-archive: deletes the pack's
     * archived instances, their stored secrets, the approved-version rows,
     * widget-source registrations, request history, and the pack files on
     * disk. Requires the token `preparePurge` minted.
     */
    readonly purgeInstanceData: (
      input: WatchConnectorPurgeInstanceDataInput,
    ) => Effect.Effect<WatchConnectorPurgeResult, WatchConnectorError>;
  }
>()("t3/watch/connectors/ConnectorService") {}

function connectorError(
  reason: WatchConnectorErrorReason,
  message: string,
  input?: {
    packId?: WatchConnectorPackId;
    instanceId?: WatchConnectorInstanceId;
    requestId?: WatchConnectorInstallRequestId;
    field?: string;
    cause?: unknown;
  },
) {
  return new WatchConnectorError({
    message,
    reason,
    ...(input?.packId === undefined ? {} : { packId: input.packId }),
    ...(input?.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    ...(input?.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input?.field === undefined ? {} : { field: input.field }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

// ── Rows ─────────────────────────────────────────────────────────────────

interface PackRow {
  readonly pack_id: string;
  readonly schema_version: number;
  readonly manifest_json: string;
  readonly manifest_hash: string;
  readonly origin_json: string;
  readonly content_hash: string;
  readonly approved_at: string;
  readonly archived_at: string | null;
}

interface InstanceRow {
  readonly instance_id: string;
  readonly pack_id: string;
  readonly schema_version: number;
  readonly name: string | null;
  readonly config_json: string;
  readonly secret_keys_json: string;
  readonly origin_json: string;
  readonly content_hash: string;
  readonly health_json: string;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RequestRow {
  readonly request_id: string;
  readonly kind: string;
  readonly status: string;
  readonly pack_id: string | null;
  readonly origin_json: string;
  readonly content_hash: string | null;
  readonly manifest_json: string | null;
  readonly manifest_hash: string | null;
  readonly local_url: number;
  readonly upgrade_from_schema_version: number | null;
  readonly upgrade_instance_id: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

const PACK_COLUMNS = `pack_id, schema_version, manifest_json, manifest_hash, origin_json, content_hash, approved_at, archived_at`;
const INSTANCE_COLUMNS = `instance_id, pack_id, schema_version, name, config_json, secret_keys_json, origin_json, content_hash, health_json, archived_at, created_at, updated_at`;
const REQUEST_COLUMNS = `request_id, kind, status, pack_id, origin_json, content_hash, manifest_json, manifest_hash, local_url, upgrade_from_schema_version, upgrade_instance_id, created_at, resolved_at`;

const OriginJson = Schema.fromJsonString(WatchConnectorOrigin);
const ManifestJson = Schema.fromJsonString(WatchConnectorPackManifest);
const ConfigJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const SecretKeysJson = Schema.fromJsonString(Schema.Array(Schema.String));
const HealthJson = Schema.fromJsonString(WatchConnectorHealth);
const decodeHealthJsonOption = Schema.decodeUnknownOption(HealthJson);
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodePack = Schema.decodeUnknownEffect(WatchConnectorPack);
const decodeInstance = Schema.decodeUnknownEffect(WatchConnectorInstance);
const decodeRequest = Schema.decodeUnknownEffect(WatchConnectorInstallRequest);
const isConnectorError = Schema.is(WatchConnectorError);

const decodeUnknownJson = Schema.decodeEffect(UnknownJson);
const parseJsonField = (text: string) =>
  decodeUnknownJson(text).pipe(
    Effect.mapError((cause) =>
      connectorError("fetchFailed", "Stored connector row JSON failed to parse.", { cause }),
    ),
  );
const decodeWidgetSource = Schema.decodeUnknownEffect(WatchPackWidgetSource);

const decodeManifestJson = Schema.decodeEffect(ManifestJson);
const decodeOriginJsonField = Schema.decodeEffect(OriginJson);
const decodeManifestFromJson = (text: string) =>
  decodeManifestJson(text).pipe(
    Effect.mapError((cause) =>
      connectorError("manifestInvalid", "Stored pack manifest failed to decode.", { cause }),
    ),
  );
const decodeOriginFromJson = (text: string) =>
  decodeOriginJsonField(text).pipe(
    Effect.mapError((cause) =>
      connectorError("fetchFailed", "Could not decode a stored connector origin.", { cause }),
    ),
  );
const encodeManifestJson = Schema.encodeSync(ManifestJson);
const encodeOriginJson = Schema.encodeSync(OriginJson);
const encodeConfigJson = Schema.encodeSync(ConfigJson);
const encodeSecretKeysJson = Schema.encodeSync(SecretKeysJson);
const encodeHealthJson = Schema.encodeSync(HealthJson);
const decodeSecretKeysJson = Schema.decodeEffect(SecretKeysJson);

const decodePackRow = (row: PackRow) =>
  Effect.gen(function* () {
    return yield* decodePack({
      packId: row.pack_id,
      schemaVersion: row.schema_version,
      manifest: yield* parseJsonField(row.manifest_json),
      origin: yield* parseJsonField(row.origin_json),
      contentHash: row.content_hash,
      approvedAt: row.approved_at,
      archivedAt: row.archived_at,
    });
  }).pipe(
    Effect.mapError((cause) =>
      isConnectorError(cause)
        ? cause
        : connectorError("fetchFailed", "Could not decode connector pack row.", {
            packId: WatchConnectorPackId.make(row.pack_id),
            cause,
          }),
    ),
  );

const decodeInstanceRow = (row: InstanceRow) =>
  Effect.gen(function* () {
    return yield* decodeInstance({
      id: row.instance_id,
      packId: row.pack_id,
      schemaVersion: row.schema_version,
      ...(row.name === null ? {} : { name: row.name }),
      config: yield* parseJsonField(row.config_json),
      configuredSecretKeys: yield* parseJsonField(row.secret_keys_json),
      origin: yield* parseJsonField(row.origin_json),
      contentHash: row.content_hash,
      health: yield* parseJsonField(row.health_json),
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }).pipe(
    Effect.mapError((cause) =>
      isConnectorError(cause)
        ? cause
        : connectorError("fetchFailed", "Could not decode connector instance row.", {
            instanceId: WatchConnectorInstanceId.make(row.instance_id),
            cause,
          }),
    ),
  );

const decodeRequestRow = (row: RequestRow) =>
  Effect.gen(function* () {
    return yield* decodeRequest({
      id: row.request_id,
      kind: row.kind,
      status: row.status,
      packId: row.pack_id,
      origin: yield* parseJsonField(row.origin_json),
      contentHash: row.content_hash,
      manifest: row.manifest_json === null ? null : yield* parseJsonField(row.manifest_json),
      localUrl: row.local_url === 1,
      ...(row.upgrade_from_schema_version === null
        ? {}
        : {
            upgrade: {
              fromSchemaVersion: row.upgrade_from_schema_version,
              ...(row.upgrade_instance_id === null ? {} : { instanceId: row.upgrade_instance_id }),
            },
          }),
      createdAt: row.created_at,
    });
  }).pipe(
    Effect.mapError((cause) =>
      isConnectorError(cause)
        ? cause
        : connectorError("fetchFailed", "Could not decode install request row.", {
            requestId: WatchConnectorInstallRequestId.make(row.request_id),
            cause,
          }),
    ),
  );

/** Secret values live in the file-backed secret store under a per-instance name. */
const secretStoreName = (instanceId: string, key: string) => {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `watch-connector.${safe(instanceId)}.${safe(key)}`;
};

const defaultHealth = {
  status: "unknown",
  lastError: null,
  lastFetchAt: null,
  consecutiveFailures: 0,
} satisfies WatchConnectorHealth;

/**
 * Pending install requests are durable rows any agent can mint — and each
 * mint may trigger an outbound fetch — so both the environment-wide and
 * per-pack totals are capped. Deferred (`pack_id IS NULL`) requests only
 * count toward the environment total; their pack is unknowable until
 * prepare resolves the manifest.
 */
const MAX_PENDING_REQUESTS = 50;
const MAX_PENDING_REQUESTS_PER_PACK = 10;

/** What the poller loads per run: instance, pinned manifest, resolved secrets. */
export interface ConnectorRuntimeInfo {
  readonly instance: WatchConnectorInstance;
  readonly manifest: WatchConnectorPackManifest;
  /**
   * Declared-and-configured secret values. Server-side only — never written
   * to a row, never sent to a client.
   */
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * The manifest's `authSchema` is a JSON-schema-lite record: `required` lists
 * fields instance config must carry; `properties` plus `additionalProperties:
 * false` closes the field set. Absent a schema, any config passes.
 */
export const validateConfigAgainstManifest = (
  manifest: WatchConnectorPackManifest,
  config: Readonly<Record<string, unknown>>,
): WatchConnectorError | null => {
  const authSchema = manifest.authSchema;
  if (authSchema === undefined) return null;
  const required = Array.isArray(authSchema["required"])
    ? authSchema["required"].filter((key): key is string => typeof key === "string")
    : [];
  for (const key of required) {
    if (!(key in config)) {
      return connectorError(
        "configInvalid",
        `Connector config is missing required field "${key}".`,
        { field: key },
      );
    }
  }
  const properties = authSchema["properties"];
  if (
    authSchema["additionalProperties"] === false &&
    typeof properties === "object" &&
    properties !== null
  ) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(properties, key)) {
        return connectorError(
          "configInvalid",
          `Connector config field "${key}" is not declared by the pack manifest.`,
          { field: key },
        );
      }
    }
  }
  return null;
};

/** Only manifest-declared secret keys may be written — anything else is refused. */
const undeclaredSecretKey = (
  manifest: WatchConnectorPackManifest,
  keys: Iterable<string>,
): WatchConnectorError | null => {
  const declared = new Set(manifest.secretKeys);
  for (const key of keys) {
    if (!declared.has(key)) {
      return connectorError(
        "secretKeyUndeclared",
        `Secret key "${key}" is not declared by the pack manifest.`,
      );
    }
  }
  return null;
};

/**
 * A config entry keyed by a declared secret name would land its value in
 * `config_json` — client-visible — so the write is refused. This inverts the
 * `undeclaredSecretKey` check: secret *values* must travel through the
 * `secrets` input, never through config.
 */
const secretKeyInConfig = (
  manifest: WatchConnectorPackManifest,
  config: Readonly<Record<string, unknown>>,
): WatchConnectorError | null => {
  const declared = new Set(manifest.secretKeys);
  for (const key of Object.keys(config)) {
    if (declared.has(key)) {
      return connectorError(
        "configInvalid",
        `Connector config field "${key}" is a declared secret key; set it via secrets, not config.`,
        { field: key },
      );
    }
  }
  return null;
};

/**
 * Keys that may be cleared: declared by the pinned manifest or still
 * configured on the instance. The configured half keeps stale keys revocable
 * — a key dropped from a newer manifest stays clearable until the re-pin
 * prune (or this clear) removes it.
 */
const unrevocableSecretKey = (
  manifest: WatchConnectorPackManifest,
  instance: WatchConnectorInstance,
  keys: Iterable<string>,
): WatchConnectorError | null => {
  const clearable = new Set([...manifest.secretKeys, ...instance.configuredSecretKeys]);
  for (const key of keys) {
    if (!clearable.has(key)) {
      return connectorError(
        "secretKeyUndeclared",
        `Secret key "${key}" is not declared by the pack manifest or configured on the instance.`,
      );
    }
  }
  return null;
};

/**
 * Belt-and-suspenders for pack-produced config: a `migrateConfig` return
 * value is arbitrary pack output, so before it is persisted into
 * `config_json` — and thereby broadcast to every client — drop entries keyed
 * by a declared secret name and entries whose string value equals a resolved
 * secret value. Shallow by design: the auth schema decides whether the
 * surviving shape is valid.
 */
const scrubSecretsFromConfig = (
  manifest: WatchConnectorPackManifest,
  config: Record<string, unknown>,
  resolvedSecrets: Readonly<Record<string, string>>,
): Record<string, unknown> => {
  const declared = new Set(manifest.secretKeys);
  const secretValues = new Set(Object.values(resolvedSecrets));
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (declared.has(key)) continue;
    if (typeof value === "string" && secretValues.has(value)) continue;
    clean[key] = value;
  }
  return clean;
};

/**
 * Splits configured keys into those the target manifest still declares (kept)
 * and those it dropped (pruned). Re-pins apply this so a stale value cannot
 * silently reactivate when a later manifest re-declares the key.
 */
const partitionSecretKeys = (
  manifest: WatchConnectorPackManifest,
  configuredKeys: ReadonlyArray<string>,
) => {
  const declared = new Set(manifest.secretKeys);
  const kept: Array<string> = [];
  const dropped: Array<string> = [];
  for (const key of configuredKeys) {
    (declared.has(key) ? kept : dropped).push(key);
  }
  return { kept: kept.sort(), dropped };
};

export const layer = Layer.effect(
  ConnectorService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const tokens = yield* ConfirmationTokens.WatchConfirmationTokens;
    const notifications = yield* UserNotificationService;
    const widgetTranspile = yield* WidgetTranspileService.WidgetTranspileService;
    // Pack fetch/storage need the ambient platform + config services; they are
    // captured here so callers see plain WatchConnectorError effects.
    const packRuntime = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, yield* FileSystem.FileSystem),
      Layer.succeed(Path.Path, yield* Path.Path),
      Layer.succeed(ServerConfig.ServerConfig, yield* ServerConfig.ServerConfig),
      Layer.succeed(PackStore.ConnectorPackFetch, yield* PackStore.ConnectorPackFetch),
    );
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const toConnectorError =
      (message: string) =>
      (cause: unknown): WatchConnectorError =>
        isConnectorError(cause) ? cause : connectorError("fetchFailed", message, { cause });

    const sha256Text = (text: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(
        Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
        Effect.mapError((cause) =>
          connectorError("fetchFailed", "Could not hash the declared manifest.", { cause }),
        ),
      );

    const fetchPackBundle = (origin: WatchConnectorOrigin) =>
      PackStore.fetchOrigin(origin).pipe(Effect.provide(packRuntime));
    const materializePackBundle = (bundle: PackStore.ConnectorPackBundle) =>
      PackStore.materializeBundle(bundle).pipe(Effect.provide(packRuntime));

    /**
     * An agent-supplied `allowLocalUrl` never authorizes anything: it is
     * stripped before an origin is fetched or stored, and set server-side
     * only after the human prepare step acknowledges it.
     */
    const stripLocalUrlAck = (origin: WatchConnectorOrigin): WatchConnectorOrigin =>
      origin.kind === "httpsUrl" ? { kind: "httpsUrl", url: origin.url } : origin;

    /** True when an https origin resolves private — such requests are recorded unfetched. */
    const isDeferredLocalOrigin = (origin: WatchConnectorOrigin) =>
      origin.kind === "httpsUrl"
        ? PackStore.urlResolvesLocal(origin.url).pipe(Effect.provide(packRuntime))
        : Effect.succeed(false);

    const newInstanceId = crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => WatchConnectorInstanceId.make(`watch-connector-instance:${uuid}`)),
      Effect.mapError((cause) =>
        connectorError("fetchFailed", "Could not generate connector instance id.", { cause }),
      ),
    );
    const newRequestId = crypto.randomUUIDv4().pipe(
      Effect.map((uuid) =>
        WatchConnectorInstallRequestId.make(`watch-connector-install-request:${uuid}`),
      ),
      Effect.mapError((cause) =>
        connectorError("fetchFailed", "Could not generate install request id.", { cause }),
      ),
    );

    const selectPackRows = (includeArchived: boolean) =>
      sql<PackRow>`
        SELECT ${sql.literal(PACK_COLUMNS)}
        FROM watch_connector_packs
        WHERE ${sql.and(includeArchived ? [] : [sql`archived_at IS NULL`])}
        ORDER BY pack_id ASC, schema_version ASC
      `;

    const selectInstanceRows = (includeArchived: boolean) =>
      sql<InstanceRow>`
        SELECT ${sql.literal(INSTANCE_COLUMNS)}
        FROM watch_connector_instances
        WHERE ${sql.and(includeArchived ? [] : [sql`archived_at IS NULL`])}
        ORDER BY created_at ASC, instance_id ASC
      `;

    const selectPendingRequestRows = () =>
      sql<RequestRow>`
        SELECT ${sql.literal(REQUEST_COLUMNS)}
        FROM watch_connector_install_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC, request_id ASC
      `;

    const loadRequestRow = (requestId: WatchConnectorInstallRequestId) =>
      sql<RequestRow>`
        SELECT ${sql.literal(REQUEST_COLUMNS)}
        FROM watch_connector_install_requests
        WHERE request_id = ${requestId}
      `;

    /** The newest approved, non-archived version of a pack — what new instances pin to. */
    const findCurrentPackRow = (packId: WatchConnectorPackId) =>
      sql<PackRow>`
        SELECT ${sql.literal(PACK_COLUMNS)}
        FROM watch_connector_packs
        WHERE pack_id = ${packId} AND archived_at IS NULL
        ORDER BY schema_version DESC
        LIMIT 1
      `;

    const findPackRow = (packId: WatchConnectorPackId, schemaVersion: number) =>
      sql<PackRow>`
        SELECT ${sql.literal(PACK_COLUMNS)}
        FROM watch_connector_packs
        WHERE pack_id = ${packId} AND schema_version = ${schemaVersion} AND archived_at IS NULL
      `;

    const loadInstanceRow = (instanceId: WatchConnectorInstanceId) =>
      sql<InstanceRow>`
        SELECT ${sql.literal(INSTANCE_COLUMNS)}
        FROM watch_connector_instances
        WHERE instance_id = ${instanceId}
      `;

    const findInstance = (instanceId: WatchConnectorInstanceId) =>
      loadInstanceRow(instanceId).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeInstanceRow(rows[0]),
        ),
        Effect.mapError(toConnectorError("Could not load connector instance.")),
      );

    const findRequest = (requestId: WatchConnectorInstallRequestId) =>
      loadRequestRow(requestId).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeRequestRow(rows[0]),
        ),
        Effect.mapError(toConnectorError("Could not load install request.")),
      );

    /** Write each secret value into the secret store; never the row, never a client. */
    const writeSecrets = (
      instanceId: WatchConnectorInstanceId,
      secretsInput: Readonly<Record<string, string>>,
    ) =>
      Effect.forEach(
        Object.entries(secretsInput),
        ([key, value]) =>
          secrets
            .set(secretStoreName(instanceId, key), new TextEncoder().encode(value))
            .pipe(Effect.mapError(toConnectorError("Could not store a connector secret."))),
        { concurrency: 1, discard: true },
      );

    const removeSecrets = (instanceId: WatchConnectorInstanceId, keys: ReadonlyArray<string>) =>
      Effect.forEach(
        keys,
        (key) =>
          secrets
            .remove(secretStoreName(instanceId, key))
            .pipe(Effect.mapError(toConnectorError("Could not remove a connector secret."))),
        { concurrency: 1, discard: true },
      );

    interface WidgetSourceRow {
      readonly pack_id: string;
      readonly schema_version: number;
      readonly name: string;
      readonly file: string;
      readonly source_id: string;
      readonly pack_archived_at: string | null;
    }

    /** A registered widget source's lifecycle follows its pack row's archived flag. */
    const selectWidgetSourceRows = (includeArchived: boolean) =>
      sql<WidgetSourceRow>`
        SELECT s.pack_id, s.schema_version, s.name, s.file, s.source_id,
               p.archived_at AS pack_archived_at
        FROM watch_pack_widget_sources s
        JOIN watch_connector_packs p
          ON p.pack_id = s.pack_id AND p.schema_version = s.schema_version
        WHERE ${sql.and(includeArchived ? [] : [sql`p.archived_at IS NULL`])}
        ORDER BY s.pack_id ASC, s.schema_version ASC, s.name ASC
      `;

    const decodeWidgetSourceRow = (row: WidgetSourceRow) =>
      decodeWidgetSource({
        packId: row.pack_id,
        schemaVersion: row.schema_version,
        sourceId: row.source_id,
        name: row.name,
        file: row.file,
        archivedAt: row.pack_archived_at,
      }).pipe(
        Effect.mapError((cause) =>
          connectorError("fetchFailed", "Could not decode a pack widget source row.", {
            packId: WatchConnectorPackId.make(row.pack_id),
            cause,
          }),
        ),
      );

    const list: ConnectorService["Service"]["list"] = (input) =>
      Effect.gen(function* () {
        const includeArchived = input.includeArchived === true;
        const [packRows, instanceRows, requestRows, widgetSourceRows] = yield* Effect.all(
          [
            selectPackRows(includeArchived),
            selectInstanceRows(includeArchived),
            selectPendingRequestRows(),
            selectWidgetSourceRows(includeArchived),
          ],
          { concurrency: 1 },
        );
        const packs = yield* Effect.forEach(packRows, decodePackRow, { concurrency: 1 });
        const instances = yield* Effect.forEach(instanceRows, decodeInstanceRow, {
          concurrency: 1,
        });
        const installRequests = yield* Effect.forEach(requestRows, decodeRequestRow, {
          concurrency: 1,
        });
        const widgetSources = yield* Effect.forEach(widgetSourceRows, decodeWidgetSourceRow, {
          concurrency: 1,
        });
        return { packs, instances, installRequests, widgetSources };
      }).pipe(Effect.mapError(toConnectorError("Could not list connectors.")));

    const subscribeList: ConnectorService["Service"]["subscribeList"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
          );
        }),
      );

    const createInstance: ConnectorService["Service"]["createInstance"] = (input) =>
      Effect.gen(function* () {
        const packRows = yield* findCurrentPackRow(input.packId);
        const packRow = packRows[0];
        if (packRow === undefined) {
          return yield* connectorError("packNotFound", "Connector pack is not installed.", {
            packId: input.packId,
          });
        }
        const manifest = yield* decodeManifestFromJson(packRow.manifest_json);
        const config = input.config ?? {};
        const configError = validateConfigAgainstManifest(manifest, config);
        if (configError !== null) return yield* configError;
        const secretFieldError = secretKeyInConfig(manifest, config);
        if (secretFieldError !== null) return yield* secretFieldError;
        const secretsInput = input.secrets ?? {};
        const secretError = undeclaredSecretKey(manifest, Object.keys(secretsInput));
        if (secretError !== null) return yield* secretError;

        const nowIso = iso(yield* localNow);
        const id = yield* newInstanceId;
        const configuredKeys = Object.keys(secretsInput).sort();
        // Secrets land first: a failed insert can leave an orphaned secret file
        // (inert, namespaced to this id) — the other order could leave a row
        // claiming configured keys that were never written.
        yield* writeSecrets(id, secretsInput);
        yield* sql`
          INSERT INTO watch_connector_instances ${sql.insert({
            instance_id: id,
            pack_id: input.packId,
            schema_version: packRow.schema_version,
            name: input.name ?? null,
            config_json: encodeConfigJson(config),
            secret_keys_json: encodeSecretKeysJson(configuredKeys),
            origin_json: packRow.origin_json,
            content_hash: packRow.content_hash,
            health_json: encodeHealthJson(defaultHealth),
            archived_at: null,
            created_at: nowIso,
            updated_at: nowIso,
          })}
        `;
        const instance = yield* findInstance(id);
        if (instance === null) {
          return yield* connectorError("instanceNotFound", "Instance missing after create.", {
            instanceId: id,
          });
        }
        yield* notifyChanged;
        return { instance };
      }).pipe(Effect.mapError(toConnectorError("Could not create connector instance.")));

    const updateInstance: ConnectorService["Service"]["updateInstance"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* findInstance(input.instanceId);
        if (existing === null || existing.archivedAt !== null) {
          return yield* connectorError(
            "instanceNotFound",
            "Connector instance not found or archived.",
            { instanceId: input.instanceId },
          );
        }
        const nowIso = iso(yield* localNow);
        yield* sql`
          UPDATE watch_connector_instances
          SET name = ${input.name}, updated_at = ${nowIso}
          WHERE instance_id = ${input.instanceId}
        `;
        const instance = yield* findInstance(input.instanceId);
        if (instance === null) {
          return yield* connectorError("instanceNotFound", "Instance missing after update.", {
            instanceId: input.instanceId,
          });
        }
        yield* notifyChanged;
        return { instance };
      }).pipe(Effect.mapError(toConnectorError("Could not update connector instance.")));

    const deleteInstance: ConnectorService["Service"]["deleteInstance"] = (input) =>
      Effect.gen(function* () {
        const instance = yield* findInstance(input.instanceId);
        if (instance === null) {
          return yield* connectorError("instanceNotFound", "Connector instance not found.", {
            instanceId: input.instanceId,
          });
        }
        yield* removeSecrets(input.instanceId, instance.configuredSecretKeys);
        yield* sql`
          DELETE FROM watch_connector_instances WHERE instance_id = ${input.instanceId}
        `;
        yield* notifyChanged;
        return { id: input.instanceId };
      }).pipe(Effect.mapError(toConnectorError("Could not delete connector instance.")));

    const setInstanceConfig: ConnectorService["Service"]["setInstanceConfig"] = (input) =>
      Effect.gen(function* () {
        const instance = yield* findInstance(input.instanceId);
        if (instance === null || instance.archivedAt !== null) {
          return yield* connectorError(
            "instanceNotFound",
            "Connector instance not found or archived.",
            { instanceId: input.instanceId },
          );
        }
        // Validation runs against the manifest at the instance's pinned
        // version, not the latest — a newer approved pack must not invalidate
        // config written for the pin.
        const packRows = yield* findPackRow(instance.packId, instance.schemaVersion);
        const packRow = packRows[0];
        if (packRow === undefined) {
          return yield* connectorError(
            "packNotFound",
            "The pack version this instance pins is not installed.",
            { packId: instance.packId, instanceId: input.instanceId },
          );
        }
        const manifest = yield* decodeManifestFromJson(packRow.manifest_json);
        const configError = validateConfigAgainstManifest(manifest, input.config);
        if (configError !== null) return yield* configError;
        const secretFieldError = secretKeyInConfig(manifest, input.config);
        if (secretFieldError !== null) return yield* secretFieldError;
        const secretsInput = input.secrets ?? {};
        const clearKeys = input.clearSecretKeys ?? [];
        // New values must stay declared; clears may also target keys that are
        // still configured even though the pinned manifest dropped them.
        const secretError =
          undeclaredSecretKey(manifest, Object.keys(secretsInput)) ??
          unrevocableSecretKey(manifest, instance, clearKeys);
        if (secretError !== null) return yield* secretError;

        yield* writeSecrets(input.instanceId, secretsInput);
        yield* removeSecrets(input.instanceId, clearKeys);
        const configuredKeys = [
          ...new Set([...instance.configuredSecretKeys, ...Object.keys(secretsInput)]),
        ]
          .filter((key) => !clearKeys.includes(key))
          .sort();
        const nowIso = iso(yield* localNow);
        yield* sql`
          UPDATE watch_connector_instances
          SET config_json = ${encodeConfigJson(input.config)},
              secret_keys_json = ${encodeSecretKeysJson(configuredKeys)},
              updated_at = ${nowIso}
          WHERE instance_id = ${input.instanceId}
        `;
        const updated = yield* findInstance(input.instanceId);
        if (updated === null) {
          return yield* connectorError("instanceNotFound", "Instance missing after config write.", {
            instanceId: input.instanceId,
          });
        }
        yield* notifyChanged;
        return { instance: updated };
      }).pipe(Effect.mapError(toConnectorError("Could not update connector instance config.")));

    /**
     * Values resolve only for keys that are both declared by the given
     * manifest and configured on the instance — the intersection, read fresh
     * from the secret store each call.
     */
    const resolveSecrets = (
      instance: WatchConnectorInstance,
      manifest: WatchConnectorPackManifest,
    ) =>
      Effect.gen(function* () {
        const declared = new Set(manifest.secretKeys);
        const secretPairs = yield* Effect.forEach(
          instance.configuredSecretKeys.filter((key) => declared.has(key)),
          (key) =>
            secrets.get(secretStoreName(instance.id, key)).pipe(
              Effect.map((value) =>
                Option.isSome(value)
                  ? ([key, new TextDecoder().decode(value.value)] as const)
                  : null,
              ),
              Effect.mapError(toConnectorError("Could not read a connector secret.")),
            ),
          { concurrency: 1 },
        );
        const resolved: Record<string, string> = {};
        for (const pair of secretPairs) {
          if (pair !== null) resolved[pair[0]] = pair[1];
        }
        return resolved;
      });

    const loadRuntime: ConnectorService["Service"]["loadRuntime"] = (instanceId) =>
      Effect.gen(function* () {
        const instance = yield* findInstance(instanceId);
        if (instance === null || instance.archivedAt !== null) {
          return yield* connectorError(
            "instanceNotFound",
            "Connector instance not found or archived.",
            { instanceId },
          );
        }
        const packRows = yield* findPackRow(instance.packId, instance.schemaVersion);
        const packRow = packRows[0];
        if (packRow === undefined) {
          return yield* connectorError(
            "packNotFound",
            "The pack version this instance pins is not installed.",
            { packId: instance.packId, instanceId },
          );
        }
        const manifest = yield* decodeManifestFromJson(packRow.manifest_json);
        const resolved = yield* resolveSecrets(instance, manifest);
        return { instance, manifest, secrets: resolved } satisfies ConnectorRuntimeInfo;
      }).pipe(Effect.mapError(toConnectorError("Could not load connector runtime.")));

    /**
     * `lastFetchAt` ticks on every poll run, so per-tick notify would
     * re-push the full list to every subscriber on every poll. But the
     * widget renders it as the instance's liveness label — a frozen
     * timestamp is a lie. Compromise: re-push when `lastFetchAt` crosses a
     * coarse bucket boundary, bounding staleness without the churn.
     */
    const LAST_FETCH_NOTIFY_BUCKET_MS = 15 * 60 * 1000;
    const lastFetchBucket = (value: string | null) =>
      value === null ? null : Math.floor(Date.parse(value) / LAST_FETCH_NOTIFY_BUCKET_MS);

    /**
     * Whether the stored health state differs from `next` in a way worth
     * broadcasting: any real field delta, or `lastFetchAt` crossing a
     * bucket boundary.
     */
    const healthChanged = (storedJson: string, next: WatchConnectorHealth) => {
      const previous = decodeHealthJsonOption(storedJson);
      if (Option.isNone(previous)) return true;
      return (
        previous.value.status !== next.status ||
        previous.value.lastError !== next.lastError ||
        previous.value.consecutiveFailures !== next.consecutiveFailures ||
        lastFetchBucket(previous.value.lastFetchAt) !== lastFetchBucket(next.lastFetchAt) ||
        JSON.stringify(previous.value.lastRollback ?? null) !==
          JSON.stringify(next.lastRollback ?? null)
      );
    };

    const recordHealth: ConnectorService["Service"]["recordHealth"] = (instanceId, patch) =>
      Effect.gen(function* () {
        // The poller, rollback, and confirm all write `health_json` — the
        // merge runs inside a transaction so the delta lands on the row's
        // current health, not on a snapshot the caller read earlier.
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const stored = yield* sql<{ health_json: string }>`
              SELECT health_json
              FROM watch_connector_instances
              WHERE instance_id = ${instanceId} AND archived_at IS NULL
            `;
            const row = stored[0];
            if (row === undefined) {
              return yield* connectorError(
                "instanceNotFound",
                "Connector instance not found or archived.",
                { instanceId },
              );
            }
            const previous = decodeHealthJsonOption(row.health_json);
            const base: WatchConnectorHealth = Option.isSome(previous)
              ? previous.value
              : defaultHealth;
            const lastRollback = patch.lastRollback ?? base.lastRollback;
            const merged: WatchConnectorHealth = {
              status: patch.status ?? base.status,
              lastError: patch.lastError === undefined ? base.lastError : patch.lastError,
              lastFetchAt: patch.lastFetchAt === undefined ? base.lastFetchAt : patch.lastFetchAt,
              consecutiveFailures: patch.consecutiveFailures ?? base.consecutiveFailures,
              ...(lastRollback === undefined ? {} : { lastRollback }),
            };
            yield* sql`
              UPDATE watch_connector_instances
              SET health_json = ${encodeHealthJson(merged)}
              WHERE instance_id = ${instanceId} AND archived_at IS NULL
            `;
            return healthChanged(row.health_json, merged);
          }),
        );
        if (changed) yield* notifyChanged;
      }).pipe(Effect.mapError(toConnectorError("Could not record connector health.")));

    /** Refuse a new request when the pending budget is already spent. */
    const checkPendingRequestBudget = (packId: WatchConnectorPackId | null) =>
      Effect.gen(function* () {
        const totals = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n
          FROM watch_connector_install_requests
          WHERE status = 'pending'
        `;
        if ((totals[0]?.n ?? 0) >= MAX_PENDING_REQUESTS) {
          return yield* connectorError(
            "watchLimitExceeded",
            `Too many pending connector install requests (cap ${MAX_PENDING_REQUESTS}).`,
          );
        }
        if (packId === null) return;
        const perPack = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n
          FROM watch_connector_install_requests
          WHERE status = 'pending' AND pack_id = ${packId}
        `;
        if ((perPack[0]?.n ?? 0) >= MAX_PENDING_REQUESTS_PER_PACK) {
          return yield* connectorError(
            "watchLimitExceeded",
            `Too many pending install requests for ${packId} (cap ${MAX_PENDING_REQUESTS_PER_PACK}).`,
            { packId },
          );
        }
      });

    const insertRequest = (request: {
      readonly id: WatchConnectorInstallRequestId;
      readonly kind: "install" | "upgrade";
      readonly packId: WatchConnectorPackId | null;
      readonly origin: WatchConnectorOrigin;
      readonly localUrl: boolean;
      readonly bundle?: PackStore.ConnectorPackBundle | undefined;
      readonly upgradeFromSchemaVersion?: number | undefined;
      readonly upgradeInstanceId?: WatchConnectorInstanceId | undefined;
      readonly nowIso: string;
    }) =>
      sql`
        INSERT INTO watch_connector_install_requests ${sql.insert({
          request_id: request.id,
          kind: request.kind,
          status: "pending",
          pack_id: request.packId,
          origin_json: encodeOriginJson(request.origin),
          content_hash: request.bundle?.contentHash ?? null,
          manifest_json:
            request.bundle === undefined ? null : encodeManifestJson(request.bundle.manifest),
          manifest_hash: request.bundle?.manifestHash ?? null,
          local_url: request.localUrl ? 1 : 0,
          upgrade_from_schema_version: request.upgradeFromSchemaVersion ?? null,
          upgrade_instance_id: request.upgradeInstanceId ?? null,
          created_at: request.nowIso,
          resolved_at: null,
        })}
      `;

    /**
     * Publishes a pack's declared widget sources through the trusted leg of
     * the transpile pipeline — same validation and content-hashed artifacts
     * as agent-published sources, but a human-approved bundle does not
     * consume (and is not rejected by) the agent-facing publish rate limit.
     * A declared file missing from the bundle is a manifest lie and fails
     * the confirm; a source that fails to build registers as a `failed`
     * record (the widget renders `transpileFailed`), never a call error.
     */
    const registerPackWidgets = Effect.fn("ConnectorService.registerPackWidgets")(function* (
      bundle: PackStore.ConnectorPackBundle,
    ) {
      const declared = bundle.manifest.widgets ?? [];
      const registrations: Array<{
        readonly name: string;
        readonly file: string;
        readonly sourceId: string;
      }> = [];
      for (const widget of declared) {
        const source = bundle.files[widget.file];
        if (source === undefined) {
          return yield* connectorError(
            "manifestInvalid",
            `Pack manifest declares widget "${widget.name}" at ${widget.file}, which is not in the bundle.`,
            { packId: bundle.manifest.id },
          );
        }
        const { source: record } = yield* widgetTranspile
          .publishTrusted({ source, manifest: widget.bridge })
          .pipe(
            Effect.mapError((cause) =>
              connectorError(
                "packCodeInvalid",
                `Pack widget "${widget.name}" could not be published: ${cause.message}`,
                { packId: bundle.manifest.id, cause },
              ),
            ),
          );
        registrations.push({ name: widget.name, file: widget.file, sourceId: record.sourceId });
      }
      return registrations;
    });

    /**
     * Runs the target pack's `migrateConfig(from, to, ctx)` when it ships
     * one — server-side under the same pack boundary as poll runs, with
     * `ctx.config` holding the instance's current config. Pack code gets no
     * secrets here: migration transforms config, it never reads credentials.
     * Returns:
     * - `migrated` — scrubbed of secret material, validated against the
     *   target manifest, written on re-pin;
     * - `failed` — the instance keeps its config and flags `configMismatch`;
     * - `absent` — no migrator shipped; poll-time validation decides.
     */
    const runConfigMigration = Effect.fn("ConnectorService.runConfigMigration")(function* (
      bundle: PackStore.ConnectorPackBundle,
      instance: WatchConnectorInstance,
      toSchemaVersion: number,
    ) {
      const mod = yield* PackModule.evalConnectorModule(bundle.files);
      const migrate = mod.migrateConfig;
      if (migrate === undefined) return { kind: "absent" as const };
      // Resolved host-side only — the values feed the output scrub, never
      // the pack's context.
      const resolvedSecrets = yield* resolveSecrets(instance, bundle.manifest);
      const ctx: PackModule.ConnectorModuleContext = {
        config: instance.config,
        failAuthExpired: (message: string) => new PackModule.ConnectorAuthExpiredError(message),
      };
      const migrated = yield* PackModule.invokePackFunction(() =>
        migrate(instance.schemaVersion, toSchemaVersion, ctx),
      ).pipe(Effect.result);
      if (Result.isFailure(migrated)) {
        const raw = Cause.isUnknownError(migrated.failure)
          ? migrated.failure.cause
          : migrated.failure;
        return {
          kind: "failed" as const,
          detail: raw instanceof Error ? raw.message : String(raw),
        };
      }
      const next = migrated.success;
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        return {
          kind: "failed" as const,
          detail: "Pack migrateConfig did not return a config object.",
        };
      }
      // Pack output is arbitrary: anything resembling a secret — by declared
      // key or by resolved value — is stripped before the config persists.
      const scrubbed = scrubSecretsFromConfig(
        bundle.manifest,
        next as Record<string, unknown>,
        resolvedSecrets,
      );
      const invalid = validateConfigAgainstManifest(bundle.manifest, scrubbed);
      if (invalid !== null) {
        return { kind: "failed" as const, detail: invalid.message };
      }
      return { kind: "migrated" as const, config: scrubbed };
    });

    const requestInstall: ConnectorService["Service"]["requestInstall"] = (input) =>
      Effect.gen(function* () {
        // The origin is fetched now unless it resolves private — an https
        // URL resolving to a loopback/link-local/private address is recorded
        // unfetched (`localUrl`), and the fetch waits for the human-acked
        // prepare step. An agent can never trigger a private-range fetch.
        const origin = stripLocalUrlAck(input.origin);
        // Environment cap runs before the fetch: request spam must not
        // amplify into outbound fetches.
        yield* checkPendingRequestBudget(null);
        const deferred = yield* isDeferredLocalOrigin(origin);
        const bundle = deferred ? null : yield* fetchPackBundle(origin);
        yield* checkPendingRequestBudget(bundle?.manifest.id ?? null);
        const id = yield* newRequestId;
        yield* insertRequest({
          id,
          kind: "install",
          packId: bundle?.manifest.id ?? null,
          origin,
          localUrl: deferred,
          bundle: bundle ?? undefined,
          nowIso: iso(yield* localNow),
        });
        const request = yield* findRequest(id);
        if (request === null) {
          return yield* connectorError("requestNotFound", "Install request missing after insert.", {
            requestId: id,
          });
        }
        yield* notifyChanged;
        return { request };
      }).pipe(Effect.mapError(toConnectorError("Could not record install request.")));

    const requestUpgrade: ConnectorService["Service"]["requestUpgrade"] = (input) =>
      Effect.gen(function* () {
        const packRows = yield* findCurrentPackRow(input.packId);
        const packRow = packRows[0];
        if (packRow === undefined) {
          return yield* connectorError("packNotFound", "Connector pack is not installed.", {
            packId: input.packId,
          });
        }
        if (input.instanceId !== undefined) {
          const instance = yield* findInstance(input.instanceId);
          if (instance === null || instance.archivedAt !== null) {
            return yield* connectorError("instanceNotFound", "Connector instance not found.", {
              instanceId: input.instanceId,
            });
          }
          if (instance.packId !== input.packId) {
            return yield* connectorError(
              "packIdMismatch",
              "The named instance does not belong to this pack.",
              { instanceId: input.instanceId, packId: input.packId },
            );
          }
        }
        // Same deferral as installs: a private-resolving https URL is
        // recorded unfetched; the manifest checks below then run at prepare.
        yield* checkPendingRequestBudget(input.packId);
        const origin = stripLocalUrlAck(input.origin);
        const deferred = yield* isDeferredLocalOrigin(origin);
        const bundle = deferred ? null : yield* fetchPackBundle(origin);
        if (bundle !== null) {
          if (bundle.manifest.id !== input.packId) {
            return yield* connectorError(
              "packIdMismatch",
              "Fetched manifest id does not match the pack being upgraded.",
              { packId: input.packId },
            );
          }
          if (bundle.manifest.schemaVersion <= packRow.schema_version) {
            return yield* connectorError(
              "downgradeRejected",
              `Upgrade must declare a schemaVersion above ${packRow.schema_version}.`,
              { packId: input.packId },
            );
          }
        }
        const id = yield* newRequestId;
        yield* insertRequest({
          id,
          kind: "upgrade",
          packId: input.packId,
          origin,
          localUrl: deferred,
          bundle: bundle ?? undefined,
          upgradeFromSchemaVersion: packRow.schema_version,
          upgradeInstanceId: input.instanceId,
          nowIso: iso(yield* localNow),
        });
        const request = yield* findRequest(id);
        if (request === null) {
          return yield* connectorError("requestNotFound", "Upgrade request missing after insert.", {
            requestId: id,
          });
        }
        yield* notifyChanged;
        return { request };
      }).pipe(Effect.mapError(toConnectorError("Could not record upgrade request.")));

    const pendingRequestRow = (requestId: WatchConnectorInstallRequestId) =>
      Effect.gen(function* () {
        const rows = yield* loadRequestRow(requestId);
        const row = rows[0];
        if (row === undefined) {
          return yield* connectorError("requestNotFound", "Install request not found.", {
            requestId,
          });
        }
        if (row.status !== "pending") {
          return yield* connectorError(
            "requestNotPending",
            `Install request is already ${row.status}.`,
            { requestId },
          );
        }
        return row;
      });

    const prepareInstallConfirm: ConnectorService["Service"]["prepareInstallConfirm"] = (input) =>
      Effect.gen(function* () {
        let row = yield* pendingRequestRow(input.requestId);
        let manifestHash = row.manifest_hash;
        if (manifestHash === null) {
          // A `localUrl` request was recorded without fetching: this is the
          // only leg allowed to fetch it, and only with the explicit human
          // acknowledgement — the request leg itself is agent-reachable.
          if (input.allowLocalUrl !== true) {
            return yield* connectorError(
              "urlBlocked",
              "This request's URL resolves to a loopback, link-local, or private address; preparing it requires allowLocalUrl.",
              { requestId: input.requestId },
            );
          }
          const origin = yield* decodeOriginFromJson(row.origin_json);
          const ackedOrigin: WatchConnectorOrigin =
            origin.kind === "httpsUrl"
              ? { kind: "httpsUrl", url: origin.url, allowLocalUrl: true }
              : origin;
          const bundle = yield* fetchPackBundle(ackedOrigin);
          if (row.kind === "upgrade") {
            if (row.pack_id === null || bundle.manifest.id !== row.pack_id) {
              return yield* connectorError(
                "packIdMismatch",
                "Fetched manifest id does not match the pack being upgraded.",
                { requestId: input.requestId },
              );
            }
            const currentRows = yield* findCurrentPackRow(WatchConnectorPackId.make(row.pack_id));
            const currentMax = currentRows[0]?.schema_version ?? 0;
            if (bundle.manifest.schemaVersion <= currentMax) {
              return yield* connectorError(
                "downgradeRejected",
                `Upgrade must declare a schemaVersion above ${currentMax}.`,
                {
                  requestId: input.requestId,
                  packId: WatchConnectorPackId.make(row.pack_id),
                },
              );
            }
          }
          const manifestJson = encodeManifestJson(bundle.manifest);
          const originJson = encodeOriginJson(ackedOrigin);
          const filled = yield* sql<{ readonly request_id: string }>`
            UPDATE watch_connector_install_requests
            SET pack_id = ${bundle.manifest.id},
                content_hash = ${bundle.contentHash},
                manifest_json = ${manifestJson},
                manifest_hash = ${bundle.manifestHash},
                origin_json = ${originJson}
            WHERE request_id = ${input.requestId} AND status = 'pending'
            RETURNING request_id
          `;
          if (filled.length === 0) {
            // A cancel landing during the deferred fetch wins — refuse
            // rather than mutating a resolved row or minting a token for it.
            return yield* connectorError(
              "requestNotPending",
              "Install request was resolved while it was being prepared.",
              { requestId: input.requestId },
            );
          }
          // The filled row is part of the pending list every client sees —
          // the localUrl ack flow depends on subscribers observing the
          // fetched manifest, so the update must be broadcast.
          yield* notifyChanged;
          row = {
            ...row,
            pack_id: bundle.manifest.id,
            content_hash: bundle.contentHash,
            manifest_json: manifestJson,
            manifest_hash: bundle.manifestHash,
            origin_json: originJson,
          };
          manifestHash = bundle.manifestHash;
        }
        // Upgrades surface a diff base: the currently-approved pack version
        // the pending manifest is compared against in the confirm dialog.
        let diffBase: WatchConnectorPack | null = null;
        if (row.kind === "upgrade" && row.pack_id !== null) {
          const currentRows = yield* findCurrentPackRow(WatchConnectorPackId.make(row.pack_id));
          const currentRow = currentRows[0];
          if (currentRow !== undefined) {
            diffBase = yield* decodePackRow(currentRow);
          }
        }
        const confirmationToken = yield* tokens.mint({
          requestId: input.requestId,
          manifestHash,
        });
        const request = yield* decodeRequestRow(row);
        return { request, diffBase, confirmationToken };
      }).pipe(Effect.mapError(toConnectorError("Could not prepare install confirmation.")));

    /**
     * Shared confirm leg: consume the hash-bound token, refetch the origin,
     * and install only bytes that hash to the recorded pin — the bundle the
     * human saw at request time is the bundle that lands on disk.
     */
    const confirmRequest = (
      requestId: WatchConnectorInstallRequestId,
      confirmationToken: string,
      expectedKind: "install" | "upgrade",
    ) =>
      Effect.gen(function* () {
        const row = yield* pendingRequestRow(requestId);
        if (row.kind !== expectedKind) {
          return yield* connectorError(
            "confirmationInvalid",
            `Install request is a ${row.kind}, not an ${expectedKind}.`,
            { requestId },
          );
        }
        // A `localUrl` request carries nulls until prepare fills them — and
        // no token can exist for an unprepared row, so this is only a guard
        // against direct calls skipping prepare.
        if (row.manifest_json === null || row.manifest_hash === null || row.pack_id === null) {
          return yield* connectorError(
            "confirmationInvalid",
            "Install request has not been prepared yet.",
            { requestId },
          );
        }
        const packId = WatchConnectorPackId.make(row.pack_id);
        // The token binds to the declared manifest as recorded at request
        // time; a row whose manifest no longer hashes to that pin is refused
        // before the token is touched.
        const declaredHash = yield* sha256Text(row.manifest_json);
        if (declaredHash !== row.manifest_hash) {
          return yield* connectorError(
            "hashMismatch",
            "The declared manifest changed since the request was recorded.",
            { requestId },
          );
        }
        yield* tokens.consume({
          token: confirmationToken,
          requestId,
          manifestHash: row.manifest_hash,
        });

        const origin = yield* decodeOriginFromJson(row.origin_json);
        const bundle = yield* fetchPackBundle(origin);
        if (bundle.manifest.id !== packId) {
          return yield* connectorError(
            "packIdMismatch",
            "Fetched manifest id does not match the requested pack.",
            { requestId, packId },
          );
        }
        if (bundle.contentHash !== row.content_hash) {
          return yield* connectorError(
            "hashMismatch",
            "Refetched pack content no longer matches the approved hash.",
            { requestId, packId },
          );
        }
        yield* materializePackBundle(bundle);
        // Pack-bundled widget sources publish through the transpile pipeline
        // before the write transaction — a publish rejection aborts the
        // confirm cleanly; the content-hashed cache makes a retry idempotent.
        const packWidgets = yield* registerPackWidgets(bundle);

        // A confirmed upgrade re-pinning an instance runs the new pack's
        // migrateConfig now, outside the write transaction — pack code can be
        // slow and the pin must not wait on it. A failed migration keeps the
        // stored config and surfaces through health + widget error state.
        let repinTarget: WatchConnectorInstance | null = null;
        let migratedConfig: Record<string, unknown> | null = null;
        let migrationFailure: string | null = null;
        let repinnedSecretKeysJson: string | null = null;
        if (expectedKind === "upgrade" && row.upgrade_instance_id !== null) {
          repinTarget = yield* findInstance(WatchConnectorInstanceId.make(row.upgrade_instance_id));
          if (repinTarget !== null && repinTarget.archivedAt === null) {
            const migration = yield* runConfigMigration(
              bundle,
              repinTarget,
              bundle.manifest.schemaVersion,
            );
            if (migration.kind === "migrated") migratedConfig = migration.config;
            if (migration.kind === "failed") migrationFailure = migration.detail;
            // Keys the target manifest no longer declares are pruned with
            // the re-pin so a stale value cannot silently reactivate later.
            // Off-DB first, like every secret write.
            const partitioned = partitionSecretKeys(
              bundle.manifest,
              repinTarget.configuredSecretKeys,
            );
            repinnedSecretKeysJson = encodeSecretKeysJson(partitioned.kept);
            yield* removeSecrets(repinTarget.id, partitioned.dropped);
          }
        }

        const nowIso = iso(yield* localNow);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Ordering is re-checked inside the write transaction: versions
            // approved between request and confirm must not let a stale
            // request re-pin an older version.
            if (expectedKind === "upgrade") {
              const approvedRows = yield* sql<{ readonly approved_max: number | null }>`
                SELECT MAX(schema_version) AS approved_max
                FROM watch_connector_packs
                WHERE pack_id = ${packId} AND archived_at IS NULL
              `;
              const approvedMax = approvedRows[0]?.approved_max ?? 0;
              if (bundle.manifest.schemaVersion <= approvedMax) {
                return yield* connectorError(
                  "downgradeRejected",
                  `Upgrade pins schemaVersion ${bundle.manifest.schemaVersion}, but version ${approvedMax} is already approved.`,
                  { requestId, packId },
                );
              }
            }
            // An approved (pack_id, schema_version) pin is immutable:
            // re-approving identical bytes is a no-op (or the intentional
            // archived-revive path), but writing different content over an
            // existing pin would silently retcon what every pinned instance
            // runs — new bytes require a new schemaVersion. The check covers
            // archived rows too: a revive must revive the same bundle.
            const approvedRows = yield* sql<{
              readonly content_hash: string;
              readonly manifest_hash: string;
            }>`
              SELECT content_hash, manifest_hash
              FROM watch_connector_packs
              WHERE pack_id = ${packId} AND schema_version = ${bundle.manifest.schemaVersion}
            `;
            const approved = approvedRows[0];
            if (
              approved !== undefined &&
              (approved.content_hash !== bundle.contentHash ||
                approved.manifest_hash !== bundle.manifestHash)
            ) {
              return yield* connectorError(
                "versionAlreadyApproved",
                `Connector pack ${packId} version ${bundle.manifest.schemaVersion} is already approved with different content; publish new bytes under a new schemaVersion.`,
                { requestId, packId },
              );
            }
            yield* sql`
              INSERT INTO watch_connector_packs ${sql.insert({
                pack_id: packId,
                schema_version: bundle.manifest.schemaVersion,
                manifest_json: encodeManifestJson(bundle.manifest),
                manifest_hash: bundle.manifestHash,
                origin_json: row.origin_json,
                content_hash: bundle.contentHash,
                approved_at: nowIso,
                archived_at: null,
              })}
              ON CONFLICT (pack_id, schema_version) DO UPDATE SET
                manifest_json = excluded.manifest_json,
                manifest_hash = excluded.manifest_hash,
                origin_json = excluded.origin_json,
                content_hash = excluded.content_hash,
                approved_at = excluded.approved_at,
                archived_at = NULL
            `;
            // A re-approval re-declares the version's widget set: replace the
            // registrations rather than accumulating stale entries.
            yield* sql`
              DELETE FROM watch_pack_widget_sources
              WHERE pack_id = ${packId} AND schema_version = ${bundle.manifest.schemaVersion}
            `;
            for (const widget of packWidgets) {
              yield* sql`
                INSERT INTO watch_pack_widget_sources ${sql.insert({
                  pack_id: packId,
                  schema_version: bundle.manifest.schemaVersion,
                  name: widget.name,
                  file: widget.file,
                  source_id: widget.sourceId,
                  created_at: nowIso,
                })}
              `;
            }
            if (expectedKind === "install") {
              // Soft-archive's way back: reinstalling an approved version
              // revives the instances pinned to it — config intact.
              yield* sql`
                UPDATE watch_connector_instances
                SET archived_at = NULL, updated_at = ${nowIso}
                WHERE pack_id = ${packId}
                  AND schema_version = ${bundle.manifest.schemaVersion}
                  AND archived_at IS NOT NULL
              `;
            }
            if (expectedKind === "upgrade" && row.upgrade_instance_id !== null) {
              const repinned = yield* sql<{ instance_id: string }>`
                UPDATE watch_connector_instances
                SET schema_version = ${bundle.manifest.schemaVersion},
                    content_hash = ${bundle.contentHash},
                    origin_json = ${row.origin_json},
                    config_json = COALESCE(${migratedConfig === null ? null : encodeConfigJson(migratedConfig)}, config_json),
                    secret_keys_json = COALESCE(${repinnedSecretKeysJson}, secret_keys_json),
                    updated_at = ${nowIso}
                WHERE instance_id = ${row.upgrade_instance_id}
                  AND pack_id = ${packId}
                  AND archived_at IS NULL
                RETURNING instance_id
              `;
              if (repinned.length === 0) {
                return yield* connectorError(
                  "instanceNotFound",
                  "The instance this upgrade would re-pin is missing or archived.",
                  { requestId, instanceId: WatchConnectorInstanceId.make(row.upgrade_instance_id) },
                );
              }
            }
            // The status flip is conditional: a cancel or uninstall landing
            // in the fetch/migration window must win over this confirm —
            // and the guard failing rolls the pack upsert back with it.
            const confirmed = yield* sql<{ readonly request_id: string }>`
              UPDATE watch_connector_install_requests
              SET status = 'confirmed', resolved_at = ${nowIso}
              WHERE request_id = ${requestId} AND status = 'pending'
              RETURNING request_id
            `;
            if (confirmed.length === 0) {
              return yield* connectorError(
                "requestNotPending",
                "Install request was resolved while the confirmation was in flight.",
                { requestId },
              );
            }
          }),
        );

        // The install committed above; this post-commit health write is
        // best-effort — a failure must not report a committed upgrade or
        // re-pin as a failed call.
        if (migrationFailure !== null && repinTarget !== null) {
          yield* recordHealth(repinTarget.id, {
            status: "unhealthy",
            lastError: `Pack migrateConfig(${repinTarget.schemaVersion} → ${bundle.manifest.schemaVersion}) failed: ${migrationFailure}. The previous config was kept; fix the instance configuration.`,
          }).pipe(Effect.ignore({ log: true }));
        }

        const packRows = yield* findPackRow(packId, bundle.manifest.schemaVersion);
        const packRow = packRows[0];
        if (packRow === undefined) {
          return yield* connectorError("packNotFound", "Pack missing after confirm.", {
            requestId,
            packId,
          });
        }
        const pack = yield* decodePackRow(packRow);
        yield* notifyChanged;
        return { pack };
      }).pipe(Effect.mapError(toConnectorError("Could not confirm install request.")));

    const confirmInstall: ConnectorService["Service"]["confirmInstall"] = (input) =>
      confirmRequest(input.requestId, input.confirmationToken, "install");

    const confirmUpgrade: ConnectorService["Service"]["confirmUpgrade"] = (input) =>
      confirmRequest(input.requestId, input.confirmationToken, "upgrade");

    const cancelInstallRequest: ConnectorService["Service"]["cancelInstallRequest"] = (input) =>
      Effect.gen(function* () {
        const nowIso = iso(yield* localNow);
        yield* sql`
          UPDATE watch_connector_install_requests
          SET status = 'cancelled', resolved_at = ${nowIso}
          WHERE request_id = ${input.requestId} AND status = 'pending'
        `;
        const request = yield* findRequest(input.requestId);
        if (request === null) {
          return yield* connectorError("requestNotFound", "Install request not found.", {
            requestId: input.requestId,
          });
        }
        if (request.status !== "cancelled") {
          return yield* connectorError(
            "requestNotPending",
            `Install request is already ${request.status}.`,
            { requestId: input.requestId },
          );
        }
        yield* notifyChanged;
        return { request };
      }).pipe(Effect.mapError(toConnectorError("Could not cancel install request.")));

    /**
     * Shared re-pin: run the target pack's migrateConfig and update the
     * instance row. A failed migration keeps the stored config; the caller
     * folds the failure into its post-commit health write, which surfaces as
     * `configMismatch` in widget fetches.
     */
    const repinInstance = Effect.fn("ConnectorService.repinInstance")(function* (params: {
      readonly instance: WatchConnectorInstance;
      readonly bundle: PackStore.ConnectorPackBundle;
      readonly toSchemaVersion: number;
      readonly originJson: string;
    }) {
      const { instance, bundle, toSchemaVersion, originJson } = params;
      const migration = yield* runConfigMigration(bundle, instance, toSchemaVersion);
      const migratedConfig = migration.kind === "migrated" ? migration.config : null;
      const migrationFailure = migration.kind === "failed" ? migration.detail : null;
      // Keys the target manifest no longer declares are pruned with the
      // re-pin so a stale value cannot silently reactivate later. Off-DB
      // first, like every secret write.
      const partitioned = partitionSecretKeys(bundle.manifest, instance.configuredSecretKeys);
      yield* removeSecrets(instance.id, partitioned.dropped);
      const nowIso = iso(yield* localNow);
      yield* sql`
        UPDATE watch_connector_instances
        SET schema_version = ${toSchemaVersion},
            content_hash = ${bundle.contentHash},
            origin_json = ${originJson},
            config_json = ${encodeConfigJson(migratedConfig ?? instance.config)},
            secret_keys_json = ${encodeSecretKeysJson(partitioned.kept)},
            updated_at = ${nowIso}
        WHERE instance_id = ${instance.id} AND archived_at IS NULL
      `;
      return { migrationFailure, nowIso };
    });

    const rollback: ConnectorService["Service"]["rollback"] = (input) =>
      Effect.gen(function* () {
        const instance = yield* findInstance(input.instanceId);
        if (instance === null || instance.archivedAt !== null) {
          return yield* connectorError(
            "instanceNotFound",
            "Connector instance not found or archived.",
            { instanceId: input.instanceId },
          );
        }
        const packId = instance.packId;
        // Rolling back to the pinned version is a no-op, not a rollback:
        // refuse it rather than emit a misleading from == to
        // `connector.rolledBack` and run migrateConfig across a meaningless
        // version pair.
        if (input.schemaVersion === instance.schemaVersion) {
          return yield* connectorError(
            "sameVersionRollback",
            `Instance already pins ${packId} version ${instance.schemaVersion} — rollback requires a different approved version.`,
            { instanceId: input.instanceId, packId },
          );
        }
        const packRows = yield* findPackRow(packId, input.schemaVersion);
        const packRow = packRows[0];
        // Rollback is pinned-version-only: the target row must exist as an
        // approved, non-archived install — `findPackRow` filters archived.
        if (packRow === undefined) {
          return yield* connectorError(
            "versionNotApproved",
            `Version ${input.schemaVersion} is not an approved, installed version of ${packId}.`,
            { instanceId: input.instanceId, packId },
          );
        }
        // No fetch: the bundle loads from the hash-pinned on-disk directory,
        // re-verified against the approved content hash by loadInstalled.
        const bundle = yield* PackStore.loadInstalled(packId, packRow.content_hash).pipe(
          Effect.provide(packRuntime),
          Effect.mapError(toConnectorError("Could not load the approved pack.")),
        );
        const { migrationFailure, nowIso } = yield* repinInstance({
          instance,
          bundle,
          toSchemaVersion: input.schemaVersion,
          originJson: packRow.origin_json,
        });
        // The re-pin is committed. The audit trail — health (migration
        // failure + lastRollback) and the notification — is best-effort: a
        // failure here must not surface as a failed rollback for a change
        // that already landed.
        yield* Effect.gen(function* () {
          yield* recordHealth(input.instanceId, {
            ...(migrationFailure === null
              ? {}
              : {
                  status: "unhealthy" as const,
                  lastError: `Pack migrateConfig(${instance.schemaVersion} → ${input.schemaVersion}) failed: ${migrationFailure}. The previous config was kept; fix the instance configuration.`,
                }),
            lastRollback: {
              fromSchemaVersion: instance.schemaVersion,
              toSchemaVersion: input.schemaVersion,
              at: nowIso,
            },
          });
          yield* notifications.emit({
            type: "connector.rolledBack",
            notificationId: WatchNotificationId.make(
              `watch-notification:connector.rolledBack:${input.instanceId}:${instance.schemaVersion}:${input.schemaVersion}:${nowIso}`,
            ),
            createdAt: nowIso,
            instanceId: input.instanceId,
            packId,
            fromSchemaVersion: instance.schemaVersion,
            toSchemaVersion: input.schemaVersion,
          });
        }).pipe(Effect.ignore({ log: true }));
        yield* notifyChanged;
        const fresh = yield* findInstance(input.instanceId);
        return { instance: fresh ?? instance };
      }).pipe(Effect.mapError(toConnectorError("Could not roll back the connector.")));

    const uninstall: ConnectorService["Service"]["uninstall"] = (input) =>
      Effect.gen(function* () {
        const installed = yield* sql<PackRow>`
          SELECT ${sql.literal(PACK_COLUMNS)}
          FROM watch_connector_packs
          WHERE pack_id = ${input.packId}
        `;
        if (installed.length === 0) {
          return yield* connectorError("packNotFound", "Connector pack is not installed.", {
            packId: input.packId,
          });
        }
        const nowIso = iso(yield* localNow);
        // Soft archive: rows stay, config stays, files stay — archived packs
        // and instances drop out of runtime polling and list responses, and
        // widget fetches degrade to `connectorMissing`.
        const archived = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE watch_connector_packs SET archived_at = ${nowIso}
              WHERE pack_id = ${input.packId} AND archived_at IS NULL
            `;
            const instances = yield* sql<{ instance_id: string }>`
              UPDATE watch_connector_instances SET archived_at = ${nowIso}, updated_at = ${nowIso}
              WHERE pack_id = ${input.packId} AND archived_at IS NULL
              RETURNING instance_id
            `;
            // Deferred rows carry pack_id IS NULL until prepare resolves
            // the manifest, so pack-scoped cancellation cannot see them.
            // The only attribution available without fetching is the
            // origin: a pending request to a URL this pack was approved
            // from could still resolve to it, so it shares the pack's fate.
            yield* sql`
              UPDATE watch_connector_install_requests
              SET status = 'cancelled', resolved_at = ${nowIso}
              WHERE status = 'pending' AND (
                pack_id = ${input.packId}
                OR (
                  pack_id IS NULL
                  AND json_extract(origin_json, '$.url') IN (
                    SELECT json_extract(origin_json, '$.url')
                    FROM watch_connector_packs
                    WHERE pack_id = ${input.packId}
                  )
                )
              )
            `;
            return instances.length;
          }),
        );
        yield* notifyChanged;
        return { packId: input.packId, archivedInstances: archived };
      }).pipe(Effect.mapError(toConnectorError("Could not uninstall the connector pack.")));

    /** What a purge of `packId` would destroy — the descriptor the token binds. */
    const purgeDescriptor = Effect.fn("ConnectorService.purgeDescriptor")(function* (
      packId: WatchConnectorPackId,
    ) {
      const packRows = yield* sql<PackRow>`
        SELECT ${sql.literal(PACK_COLUMNS)}
        FROM watch_connector_packs
        WHERE pack_id = ${packId}
        ORDER BY schema_version ASC
      `;
      if (packRows.length === 0) {
        return yield* connectorError("packNotFound", "Connector pack is not installed.", {
          packId,
        });
      }
      if (packRows.some((row) => row.archived_at === null)) {
        return yield* connectorError(
          "packNotArchived",
          "Purge requires a soft-archived pack — uninstall it first.",
          { packId },
        );
      }
      const instanceRows = yield* sql<InstanceRow>`
        SELECT ${sql.literal(INSTANCE_COLUMNS)}
        FROM watch_connector_instances
        WHERE pack_id = ${packId}
        ORDER BY instance_id ASC
      `;
      if (instanceRows.some((row) => row.archived_at === null)) {
        return yield* connectorError(
          "packNotArchived",
          "Purge requires every instance to be soft-archived — uninstall the pack first.",
          { packId },
        );
      }
      const widgetRows = yield* sql<{ readonly source_id: string }>`
        SELECT source_id FROM watch_pack_widget_sources
        WHERE pack_id = ${packId}
        ORDER BY source_id ASC
      `;
      const instances = instanceRows.map((row) => WatchConnectorInstanceId.make(row.instance_id));
      const schemaVersions = packRows.map((row) => row.schema_version);
      const widgetSources = widgetRows.map((row) => row.source_id);
      // The token binds to exactly this descriptor: if an instance or version
      // changes between prepare and purge, the token stops matching.
      const descriptor = `purge:${packId}:${schemaVersions.join(",")}:${instances.join(",")}:${widgetSources.join(",")}`;
      return { instances, instanceRows, schemaVersions, widgetSources, descriptor };
    });

    const preparePurge: ConnectorService["Service"]["preparePurge"] = (input) =>
      Effect.gen(function* () {
        const { instances, schemaVersions, widgetSources, descriptor } = yield* purgeDescriptor(
          input.packId,
        );
        const confirmationToken = yield* tokens.mint({
          requestId: WatchConnectorInstallRequestId.make(descriptor),
          manifestHash: descriptor,
        });
        return {
          packId: input.packId,
          instances,
          schemaVersions,
          widgetSources: widgetSources.map((id) => WatchWidgetSourceId.make(id)),
          confirmationToken,
        };
      }).pipe(Effect.mapError(toConnectorError("Could not prepare purge confirmation.")));

    const purgeInstanceData: ConnectorService["Service"]["purgeInstanceData"] = (input) =>
      Effect.gen(function* () {
        const { instances, instanceRows, widgetSources, descriptor } = yield* purgeDescriptor(
          input.packId,
        );
        // Decode each row's declared secret keys before anything is
        // destroyed: a corrupt row refuses the purge while its secrets are
        // still reachable — after the row delete it would orphan them.
        const instanceSecrets = yield* Effect.forEach(
          instanceRows,
          (row) =>
            decodeSecretKeysJson(row.secret_keys_json).pipe(
              Effect.map((keys) => ({
                instanceId: WatchConnectorInstanceId.make(row.instance_id),
                keys,
              })),
              Effect.mapError(toConnectorError("Could not decode stored secret keys.")),
            ),
          { concurrency: 1 },
        );
        yield* tokens.consume({
          token: input.confirmationToken,
          requestId: WatchConnectorInstallRequestId.make(descriptor),
          manifestHash: descriptor,
        });
        // Everything off-DB goes before the row-delete commit: a failure
        // aborts with every row still restorable, and each removal is
        // idempotent so a re-minted token retries cleanly. After the commit
        // nothing remains that can fail and orphan data.
        //
        // Secret values go too — purge is destructive. Keys are namespaced
        // by instance id, so no other pack's instance shares a slot.
        for (const { instanceId, keys } of instanceSecrets) {
          yield* removeSecrets(instanceId, keys);
        }
        // The pack's derived widget sources and their artifacts go too —
        // purge must leave no fetchable record behind.
        for (const sourceId of widgetSources) {
          yield* widgetTranspile
            .remove({ sourceId: WatchWidgetSourceId.make(sourceId) })
            .pipe(Effect.mapError(toConnectorError("Could not remove a pack widget artifact.")));
        }
        yield* PackStore.removeInstalled(input.packId).pipe(
          Effect.provide(packRuntime),
          Effect.mapError(toConnectorError("Could not remove the pack files.")),
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM watch_connector_instances WHERE pack_id = ${input.packId}
            `;
            yield* sql`
              DELETE FROM watch_pack_widget_sources WHERE pack_id = ${input.packId}
            `;
            // Same NULL pack_id gap as uninstall's cancel: deferred
            // requests whose origin could resolve to this pack go too —
            // purge's contract is that nothing fetchable survives. Runs
            // before the pack rows delete so the origin subquery resolves.
            yield* sql`
              DELETE FROM watch_connector_install_requests
              WHERE pack_id = ${input.packId}
                 OR (
                   pack_id IS NULL
                   AND json_extract(origin_json, '$.url') IN (
                     SELECT json_extract(origin_json, '$.url')
                     FROM watch_connector_packs
                     WHERE pack_id = ${input.packId}
                   )
                 )
            `;
            yield* sql`
              DELETE FROM watch_connector_packs WHERE pack_id = ${input.packId}
            `;
          }),
        );
        yield* notifyChanged;
        return { packId: input.packId, purgedInstances: instances.length };
      }).pipe(Effect.mapError(toConnectorError("Could not purge connector data.")));

    return ConnectorService.of({
      list,
      subscribeList,
      createInstance,
      updateInstance,
      deleteInstance,
      setInstanceConfig,
      loadRuntime,
      recordHealth,
      requestInstall,
      requestUpgrade,
      prepareInstallConfirm,
      confirmInstall,
      confirmUpgrade,
      cancelInstallRequest,
      rollback,
      uninstall,
      preparePurge,
      purgeInstanceData,
    });
  }),
);
