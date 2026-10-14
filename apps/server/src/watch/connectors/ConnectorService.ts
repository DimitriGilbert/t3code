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
  type WatchConnectorRequestInstallInput,
  type WatchConnectorRequestUpgradeInput,
  type WatchConnectorSetInstanceConfigInput,
  type WatchConnectorUpdateInstanceInput,
  type WatchConnectorsListInput,
  type WatchConnectorsListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ConfirmationTokens from "./ConfirmationTokens.ts";
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
     * Secret values never reach the instance row or a client.
     */
    readonly setInstanceConfig: (
      input: WatchConnectorSetInstanceConfigInput,
    ) => Effect.Effect<WatchConnectorInstanceResult, WatchConnectorError>;
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
  }
>()("t3/watch/connectors/ConnectorService") {}

function connectorError(
  reason: WatchConnectorErrorReason,
  message: string,
  input?: {
    packId?: WatchConnectorPackId;
    instanceId?: WatchConnectorInstanceId;
    requestId?: WatchConnectorInstallRequestId;
    cause?: unknown;
  },
) {
  return new WatchConnectorError({
    message,
    reason,
    ...(input?.packId === undefined ? {} : { packId: input.packId }),
    ...(input?.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    ...(input?.requestId === undefined ? {} : { requestId: input.requestId }),
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
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodePack = Schema.decodeUnknownEffect(WatchConnectorPack);
const decodeInstance = Schema.decodeUnknownEffect(WatchConnectorInstance);
const decodeRequest = Schema.decodeUnknownEffect(WatchConnectorInstallRequest);
const isConnectorError = Schema.is(WatchConnectorError);

const parseJsonField = (text: string) =>
  Schema.decodeEffect(UnknownJson)(text).pipe(
    Effect.mapError((cause) =>
      connectorError("fetchFailed", "Stored connector row JSON failed to parse.", { cause }),
    ),
  );

const decodeManifestFromJson = (text: string) =>
  Schema.decodeEffect(ManifestJson)(text).pipe(
    Effect.mapError((cause) =>
      connectorError("manifestInvalid", "Stored pack manifest failed to decode.", { cause }),
    ),
  );
const decodeOriginFromJson = (text: string) =>
  Schema.decodeEffect(OriginJson)(text).pipe(
    Effect.mapError((cause) =>
      connectorError("fetchFailed", "Could not decode a stored connector origin.", { cause }),
    ),
  );
const encodeManifestJson = Schema.encodeSync(ManifestJson);
const encodeOriginJson = Schema.encodeSync(OriginJson);
const encodeConfigJson = Schema.encodeSync(ConfigJson);
const encodeSecretKeysJson = Schema.encodeSync(SecretKeysJson);
const encodeHealthJson = Schema.encodeSync(HealthJson);

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
 * The manifest's `authSchema` is a JSON-schema-lite record: `required` lists
 * fields instance config must carry; `properties` plus `additionalProperties:
 * false` closes the field set. Absent a schema, any config passes.
 */
const validateConfigAgainstManifest = (
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

export const layer = Layer.effect(
  ConnectorService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const tokens = yield* ConfirmationTokens.WatchConfirmationTokens;
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

    const newInstanceId = crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => WatchConnectorInstanceId.make(`watch-connector-instance:${uuid}`)),
      Effect.mapError((cause) =>
        connectorError("fetchFailed", "Could not generate connector instance id.", { cause }),
      ),
    );
    const newRequestId = crypto.randomUUIDv4.pipe(
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

    const list: ConnectorService["Service"]["list"] = (input) =>
      Effect.gen(function* () {
        const includeArchived = input.includeArchived === true;
        const [packRows, instanceRows, requestRows] = yield* Effect.all(
          [
            selectPackRows(includeArchived),
            selectInstanceRows(includeArchived),
            selectPendingRequestRows(),
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
        return { packs, instances, installRequests };
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
        const secretsInput = input.secrets ?? {};
        const clearKeys = input.clearSecretKeys ?? [];
        const secretError =
          undeclaredSecretKey(manifest, Object.keys(secretsInput)) ??
          undeclaredSecretKey(manifest, clearKeys);
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

    const requestInstall: ConnectorService["Service"]["requestInstall"] = (input) =>
      Effect.gen(function* () {
        // The origin is fetched now unless it resolves private — an https
        // URL resolving to a loopback/link-local/private address is recorded
        // unfetched (`localUrl`), and the fetch waits for the human-acked
        // prepare step. An agent can never trigger a private-range fetch.
        const origin = stripLocalUrlAck(input.origin);
        const deferred = yield* isDeferredLocalOrigin(origin);
        const bundle = deferred ? null : yield* fetchPackBundle(origin);
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
          yield* sql`
            UPDATE watch_connector_install_requests
            SET pack_id = ${bundle.manifest.id},
                content_hash = ${bundle.contentHash},
                manifest_json = ${manifestJson},
                manifest_hash = ${bundle.manifestHash},
                origin_json = ${originJson}
            WHERE request_id = ${input.requestId}
          `;
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
        const confirmationToken = yield* tokens.mint({
          requestId: input.requestId,
          manifestHash,
        });
        const request = yield* decodeRequestRow(row);
        return { request, confirmationToken };
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
            if (expectedKind === "upgrade" && row.upgrade_instance_id !== null) {
              const repinned = yield* sql<{ instance_id: string }>`
                UPDATE watch_connector_instances
                SET schema_version = ${bundle.manifest.schemaVersion},
                    content_hash = ${bundle.contentHash},
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
            yield* sql`
              UPDATE watch_connector_install_requests
              SET status = 'confirmed', resolved_at = ${nowIso}
              WHERE request_id = ${requestId}
            `;
          }),
        );

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

    return ConnectorService.of({
      list,
      subscribeList,
      createInstance,
      updateInstance,
      deleteInstance,
      setInstanceConfig,
      requestInstall,
      requestUpgrade,
      prepareInstallConfirm,
      confirmInstall,
      confirmUpgrade,
      cancelInstallRequest,
    });
  }),
);
