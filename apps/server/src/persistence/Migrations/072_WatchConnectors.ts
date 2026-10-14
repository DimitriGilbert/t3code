import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per approved pack version — the accumulated rows are the
  // approved-manifest history a rollback pins back to. Pack code itself lives
  // under <stateDir>/connectors/<pack_id>/<content_hash>/, not in this table.
  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_connector_packs (
      pack_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (pack_id, schema_version)
    )
  `;

  // Instance config never holds secret values; `secret_keys_json` only records
  // which manifest-declared keys have a value in the secret store.
  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_connector_instances (
      instance_id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      name TEXT,
      config_json TEXT NOT NULL,
      secret_keys_json TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      health_json TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_watch_connector_instances_pack
    ON watch_connector_instances(pack_id)
  `;

  // A pending install/upgrade a human rules on. `manifest_hash` pins what the
  // confirmation token binds to; `resolved_at` marks confirm/cancel.
  // `local_url` marks an https origin that resolved private at request time:
  // it is recorded without a fetch (pack_id/content_hash/manifest_* stay null)
  // and the human prepare step fills them after its `allowLocalUrl` ack.
  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_connector_install_requests (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      pack_id TEXT,
      origin_json TEXT NOT NULL,
      content_hash TEXT,
      manifest_json TEXT,
      manifest_hash TEXT,
      local_url INTEGER NOT NULL DEFAULT 0,
      upgrade_from_schema_version INTEGER,
      upgrade_instance_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_watch_connector_install_requests_status
    ON watch_connector_install_requests(status)
  `;
});
