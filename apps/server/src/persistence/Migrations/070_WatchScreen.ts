import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Mobile projection is per-widget columns guarded by the page's
  // mobile_revision, so it shares no fields or revision with desktop layout.
  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_pages (
      page_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_id TEXT,
      order_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      mobile_revision INTEGER NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_watch_pages_project
    ON watch_pages(project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS watch_widgets (
      widget_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      config_json TEXT NOT NULL,
      placement_x INTEGER NOT NULL,
      placement_y INTEGER NOT NULL,
      placement_w INTEGER NOT NULL,
      placement_h INTEGER NOT NULL,
      placement_min_cols INTEGER,
      revision INTEGER NOT NULL,
      mobile_order INTEGER NOT NULL,
      mobile_hidden INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_watch_widgets_page
    ON watch_widgets(page_id)
  `;
});
