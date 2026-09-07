import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Existing tasks retain auto delivery. OpenBot imports opt into queue delivery.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'auto' CHECK (delivery_mode IN ('auto', 'queue'))`;
});
