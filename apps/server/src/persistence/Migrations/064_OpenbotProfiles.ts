import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Add profile fields without rewriting conversation, context, or routine data. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE openbot_channels ADD COLUMN avatar TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE openbot_channels ADD COLUMN description TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE openbot_channels ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)`;
});
