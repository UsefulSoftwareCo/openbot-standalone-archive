import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive only. Existing channels start with empty context at revision zero.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS openbot_thread_context (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES openbot_channels(thread_id),
    instructions TEXT NOT NULL,
    knowledge TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0)
  )`;
});
