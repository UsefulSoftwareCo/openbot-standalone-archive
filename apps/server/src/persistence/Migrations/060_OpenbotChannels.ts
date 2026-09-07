import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One channel owns exactly one Orchestrator v2 thread. The thread carries
  // the conversation; this table only records the app-level mapping.
  yield* sql`
    CREATE TABLE IF NOT EXISTS openbot_channels (
      channel_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      model_selection_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Explicit user-visible deliveries recorded by the agent through the
  // openbot MCP tools. Keyed by run so each incoming message's outcome can be
  // derived from what was delivered while its run was active.
  yield* sql`
    CREATE TABLE IF NOT EXISTS openbot_deliveries (
      delivery_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_openbot_deliveries_channel
    ON openbot_deliveries(channel_id, created_at, delivery_id)
  `;
});
