import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Widget sources a pack registered at confirm time — each row is the
  // `agent:<source_id>` kind a pack-bundled TSX file transpiled into. The
  // registration joins `watch_connector_packs` for its archived state, so an
  // uninstalled pack's widget kinds degrade without touching this table.
  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_pack_widget_sources (
      pack_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      name TEXT NOT NULL,
      file TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (pack_id, schema_version, name)
    )
  `;
});
