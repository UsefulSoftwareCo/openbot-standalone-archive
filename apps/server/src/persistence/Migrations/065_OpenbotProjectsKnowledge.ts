import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * OpenBot projects, child chats, and durable knowledge entries.
 *
 * Additive only: every existing chat keeps a NULL parent and belongs to no
 * OpenBot project, so older rows and older servers read the tables unchanged.
 * A chat's OpenBot project is derived by joining `openbot_projects` on the T3
 * project id rather than stored twice, so the two can never disagree.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(openbot_channels)
  `;
  if (!columns.some((column) => column.name === "parent_channel_id")) {
    yield* sql`
      ALTER TABLE openbot_channels
      ADD COLUMN parent_channel_id TEXT NULL REFERENCES openbot_channels(channel_id)
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_openbot_channels_parent
    ON openbot_channels(parent_channel_id)
  `;

  // One OpenBot project owns one T3 project (its working directory) and one
  // main chat. Child chats belong to that chat, not to the project.
  yield* sql`
    CREATE TABLE IF NOT EXISTS openbot_projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon_json TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      t3_project_id TEXT NOT NULL UNIQUE,
      main_channel_id TEXT NOT NULL UNIQUE REFERENCES openbot_channels(channel_id),
      workspace_kind TEXT NOT NULL CHECK (workspace_kind IN ('managed','attached')),
      workspace_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS openbot_knowledge (
      knowledge_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      owner_project_id TEXT NULL REFERENCES openbot_projects(project_id),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT NULL
    )
  `;

  // Links guide retrieval; they never grant access.
  yield* sql`
    CREATE TABLE IF NOT EXISTS openbot_knowledge_projects (
      knowledge_id TEXT NOT NULL REFERENCES openbot_knowledge(knowledge_id),
      project_id TEXT NOT NULL REFERENCES openbot_projects(project_id),
      PRIMARY KEY (knowledge_id, project_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_openbot_knowledge_projects_project
    ON openbot_knowledge_projects(project_id)
  `;
});
