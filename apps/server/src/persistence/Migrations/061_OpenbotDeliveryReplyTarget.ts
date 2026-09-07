import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Additive: a delivery may reply to one specific message in its channel.
  // NULL (every existing row) means a general channel message, so older
  // rows and older servers read the table unchanged.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(openbot_deliveries)
  `;
  if (!columns.some((column) => column.name === "reply_to_json")) {
    yield* sql`
      ALTER TABLE openbot_deliveries
      ADD COLUMN reply_to_json TEXT
    `;
  }
});
