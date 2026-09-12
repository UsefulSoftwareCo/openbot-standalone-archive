import {
  type OpenbotThreadContext,
  ModelSelection,
  OpenbotChannel,
  OpenbotChannelId,
  OpenbotDelivery,
  OpenbotDeliveryId,
  OpenbotDeliveryKind,
  type OpenbotKnowledge,
  OpenbotKnowledgeId,
  OpenbotProject,
  OpenbotProjectIcon,
  OpenbotProjectId,
  OpenbotProjectWorkspace,
  OpenbotReplyTarget,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * SQL-only persistence for OpenBot chats, projects, knowledge, and deliveries.
 * Kept separate from the service so the provider-turn instruction hook can
 * resolve a thread's chat, project, and knowledge without depending on
 * orchestration services.
 */
interface ChannelRow {
  readonly channel_id: string;
  readonly name: string;
  readonly avatar: string;
  readonly description: string;
  readonly revision: number;
  readonly project_id: string;
  readonly thread_id: string;
  readonly model_selection_json: string;
  readonly parent_channel_id: string | null;
  readonly openbot_project_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly channel_id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly text: string;
  readonly reply_to_json: string | null;
  readonly created_at: string;
}

interface ProjectRow {
  readonly project_id: string;
  readonly name: string;
  readonly icon_json: string;
  readonly instructions: string;
  readonly revision: number;
  readonly t3_project_id: string;
  readonly main_channel_id: string;
  readonly workspace_kind: string;
  readonly workspace_path: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface KnowledgeRow {
  readonly knowledge_id: string;
  readonly title: string;
  readonly body: string;
  readonly owner_project_id: string | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const encodeModelSelection = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const decodeDeliveryKind = Schema.decodeUnknownEffect(OpenbotDeliveryKind);
const decodeReplyTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenbotReplyTarget));
const encodeReplyTarget = Schema.encodeEffect(Schema.fromJsonString(OpenbotReplyTarget));
const decodeProjectIcon = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenbotProjectIcon));
const encodeProjectIcon = Schema.encodeEffect(Schema.fromJsonString(OpenbotProjectIcon));
const decodeWorkspaceKind = Schema.decodeUnknownEffect(
  Schema.Literals(["managed", "attached"] as const),
);

export type OpenbotChannelStoreError = SqlError | Schema.SchemaError;

/** Patch semantics: an omitted field keeps its saved value. */
export interface OpenbotProjectPatch {
  readonly projectId: OpenbotProjectId;
  readonly expectedRevision: number;
  readonly name?: string | undefined;
  readonly icon?: OpenbotProjectIcon | undefined;
  readonly instructions?: string | undefined;
  readonly updatedAt: string;
}

export interface OpenbotKnowledgePatch {
  readonly knowledgeId: OpenbotKnowledgeId;
  readonly expectedRevision: number;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly ownerProjectId?: OpenbotProjectId | null | undefined;
  readonly updatedAt: string;
}

export interface OpenbotChannelStoreShape {
  readonly update: (
    channel: OpenbotChannel,
  ) => Effect.Effect<OpenbotChannel | undefined, OpenbotChannelStoreError>;
  /** Model changes follow the v2 thread selection; they are not a profile edit. */
  readonly setModelSelection: (input: {
    readonly channelId: OpenbotChannelId;
    readonly modelSelection: ModelSelection;
    readonly updatedAt: string;
  }) => Effect.Effect<OpenbotChannel | undefined, OpenbotChannelStoreError>;
  readonly getContext: (
    threadId: ThreadId,
  ) => Effect.Effect<OpenbotThreadContext, OpenbotChannelStoreError>;
  readonly updateContext: (
    context: OpenbotThreadContext,
  ) => Effect.Effect<OpenbotThreadContext | undefined, OpenbotChannelStoreError>;
  readonly list: Effect.Effect<ReadonlyArray<OpenbotChannel>, OpenbotChannelStoreError>;
  readonly getById: (
    channelId: OpenbotChannelId,
  ) => Effect.Effect<OpenbotChannel | undefined, OpenbotChannelStoreError>;
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<OpenbotChannel | undefined, OpenbotChannelStoreError>;
  /**
   * True when the row exists but every read hides it. The reads above cannot
   * tell "never created" from "deleted", and a deterministic create id needs
   * that distinction so a replay refuses instead of rebuilding a deleted chat.
   */
  readonly isChannelDeleted: (
    channelId: OpenbotChannelId,
  ) => Effect.Effect<boolean, OpenbotChannelStoreError>;
  readonly insert: (channel: OpenbotChannel) => Effect.Effect<void, OpenbotChannelStoreError>;
  readonly listDeliveries: (
    channelId: OpenbotChannelId,
  ) => Effect.Effect<ReadonlyArray<OpenbotDelivery>, OpenbotChannelStoreError>;
  readonly countDeliveriesForRun: (runId: RunId) => Effect.Effect<number, OpenbotChannelStoreError>;
  readonly insertDelivery: (
    delivery: OpenbotDelivery,
  ) => Effect.Effect<void, OpenbotChannelStoreError>;
  // --- Projects -------------------------------------------------------------
  readonly listProjects: Effect.Effect<ReadonlyArray<OpenbotProject>, OpenbotChannelStoreError>;
  readonly getProject: (
    projectId: OpenbotProjectId,
  ) => Effect.Effect<OpenbotProject | undefined, OpenbotChannelStoreError>;
  readonly insertProject: (
    project: OpenbotProject,
  ) => Effect.Effect<void, OpenbotChannelStoreError>;
  readonly updateProject: (
    patch: OpenbotProjectPatch,
  ) => Effect.Effect<OpenbotProject | undefined, OpenbotChannelStoreError>;
  /** Includes deleted projects because the stored T3 workspace identity is unique. */
  readonly projectWorkspaceInUse: (
    workspacePath: string,
  ) => Effect.Effect<boolean, OpenbotChannelStoreError>;
  /** True when the project row exists and carries a tombstone. */
  readonly isProjectDeleted: (
    projectId: OpenbotProjectId,
  ) => Effect.Effect<boolean, OpenbotChannelStoreError>;
  /** Tombstones a live project. False when it was already deleted or missing. */
  readonly deleteProject: (input: {
    readonly projectId: OpenbotProjectId;
    readonly deletedAt: string;
  }) => Effect.Effect<boolean, OpenbotChannelStoreError>;
  // --- Knowledge ------------------------------------------------------------
  readonly listKnowledge: (input: {
    readonly projectId?: OpenbotProjectId | undefined;
  }) => Effect.Effect<ReadonlyArray<OpenbotKnowledge>, OpenbotChannelStoreError>;
  readonly getKnowledge: (
    knowledgeId: OpenbotKnowledgeId,
  ) => Effect.Effect<OpenbotKnowledge | undefined, OpenbotChannelStoreError>;
  readonly insertKnowledge: (
    entry: OpenbotKnowledge,
  ) => Effect.Effect<void, OpenbotChannelStoreError>;
  /**
   * Compare-and-swap. `projectIds` replaces the whole link set when given; the
   * link rewrite runs in the same transaction as the revision bump, so a losing
   * writer changes nothing.
   */
  readonly updateKnowledge: (
    patch: OpenbotKnowledgePatch & { readonly projectIds?: ReadonlyArray<OpenbotProjectId> },
  ) => Effect.Effect<OpenbotKnowledge | undefined, OpenbotChannelStoreError>;
  readonly deleteKnowledge: (input: {
    readonly knowledgeId: OpenbotKnowledgeId;
    readonly expectedRevision: number;
    readonly deletedAt: string;
  }) => Effect.Effect<boolean, OpenbotChannelStoreError>;
}

export class OpenbotChannelStore extends Context.Service<
  OpenbotChannelStore,
  OpenbotChannelStoreShape
>()("t3/openbot/OpenbotChannelStore") {}

const rowToChannel = (row: ChannelRow) =>
  decodeModelSelection(row.model_selection_json).pipe(
    Effect.map((modelSelection): OpenbotChannel => ({
      id: OpenbotChannelId.make(row.channel_id),
      name: row.name,
      avatar: row.avatar,
      description: row.description,
      revision: row.revision,
      projectId: ProjectId.make(row.project_id),
      threadId: ThreadId.make(row.thread_id),
      modelSelection,
      parentChannelId:
        row.parent_channel_id === null ? null : OpenbotChannelId.make(row.parent_channel_id),
      openbotProjectId:
        row.openbot_project_id === null ? null : OpenbotProjectId.make(row.openbot_project_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  );

const rowToDelivery = (row: DeliveryRow) =>
  Effect.all({
    kind: decodeDeliveryKind(row.kind),
    replyTo:
      row.reply_to_json === null ? Effect.succeed(null) : decodeReplyTarget(row.reply_to_json),
  }).pipe(
    Effect.map(({ kind, replyTo }): OpenbotDelivery => ({
      id: OpenbotDeliveryId.make(row.delivery_id),
      channelId: OpenbotChannelId.make(row.channel_id),
      runId: RunId.make(row.run_id),
      kind,
      text: row.text,
      replyTo,
      createdAt: row.created_at,
    })),
  );

// A stored icon is decoded strictly. Names are validated against the catalog
// on every write, so a read failure is real corruption and must surface
// rather than be papered over with the default glyph.
const rowToProject = (row: ProjectRow) =>
  Effect.all({
    icon: decodeProjectIcon(row.icon_json),
    kind: decodeWorkspaceKind(row.workspace_kind),
  }).pipe(
    Effect.map(({ icon, kind }): OpenbotProject => ({
      id: OpenbotProjectId.make(row.project_id),
      name: row.name,
      icon,
      instructions: row.instructions,
      revision: row.revision,
      t3ProjectId: ProjectId.make(row.t3_project_id),
      mainChannelId: OpenbotChannelId.make(row.main_channel_id),
      workspace: { kind, path: row.workspace_path } as OpenbotProjectWorkspace,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  );

const rowToKnowledge = (
  row: KnowledgeRow,
  projectIds: ReadonlyArray<OpenbotProjectId>,
): OpenbotKnowledge => ({
  id: OpenbotKnowledgeId.make(row.knowledge_id),
  title: row.title,
  body: row.body,
  ownerProjectId:
    row.owner_project_id === null ? null : OpenbotProjectId.make(row.owner_project_id),
  projectIds,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Project deletion removes its threads before tombstoning the project.
  // Only the thread decides channel liveness: a later OpenBot project may
  // reuse the same T3 workspace, and must not inherit an old deletion.
  const notDeleted = sql`NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_threads t
      WHERE t.thread_id = c.thread_id AND t.deleted_at IS NOT NULL
    )`;

  // A chat's OpenBot project is derived from its T3 project rather than stored
  // on the chat, so a project's main chat and its children always agree.
  const selectChannels = (where: ReturnType<typeof sql.and> | undefined) => sql<ChannelRow>`
    SELECT c.channel_id, c.name, c.avatar, c.description, c.revision, c.project_id, c.thread_id,
      c.model_selection_json, c.parent_channel_id, c.created_at, c.updated_at,
      (
        SELECT p.project_id FROM openbot_projects p
        WHERE p.t3_project_id = c.project_id AND p.deleted_at IS NULL
        LIMIT 1
      ) AS openbot_project_id
    FROM openbot_channels c
    WHERE ${notDeleted}${where === undefined ? sql`` : sql` AND ${where}`}
    ORDER BY c.created_at ASC, c.rowid ASC
  `;

  const list: OpenbotChannelStoreShape["list"] = selectChannels(undefined).pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, rowToChannel)),
  );

  const getById: OpenbotChannelStoreShape["getById"] = (channelId) =>
    selectChannels(sql.and([sql`c.channel_id = ${channelId}`])).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, rowToChannel)),
      Effect.map((channels) => channels[0]),
    );

  const getByThreadId: OpenbotChannelStoreShape["getByThreadId"] = (threadId) =>
    selectChannels(sql.and([sql`c.thread_id = ${threadId}`])).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, rowToChannel)),
      Effect.map((channels) => channels[0]),
    );

  const isChannelDeleted: OpenbotChannelStoreShape["isChannelDeleted"] = (channelId) =>
    sql<{ readonly channel_id: string }>`
      SELECT c.channel_id FROM openbot_channels c
      WHERE c.channel_id = ${channelId} AND NOT (${notDeleted})
    `.pipe(Effect.map((rows) => rows[0] !== undefined));

  const insert: OpenbotChannelStoreShape["insert"] = (channel) =>
    encodeModelSelection(channel.modelSelection).pipe(
      Effect.flatMap(
        (modelSelectionJson) => sql`
          INSERT INTO openbot_channels (
            channel_id, name, avatar, description, revision, project_id, thread_id,
            model_selection_json, parent_channel_id, created_at, updated_at
          )
          VALUES (
            ${channel.id}, ${channel.name}, ${channel.avatar}, ${channel.description}, ${channel.revision},
            ${channel.projectId}, ${channel.threadId}, ${modelSelectionJson}, ${channel.parentChannelId},
            ${channel.createdAt}, ${channel.updatedAt}
          )
        `,
      ),
      Effect.asVoid,
    );

  const listDeliveries: OpenbotChannelStoreShape["listDeliveries"] = (channelId) =>
    sql<DeliveryRow>`
      SELECT delivery_id, channel_id, run_id, kind, text, reply_to_json, created_at
      FROM openbot_deliveries
      WHERE channel_id = ${channelId}
      ORDER BY created_at ASC, delivery_id ASC
    `.pipe(Effect.flatMap((rows) => Effect.forEach(rows, rowToDelivery)));

  const countDeliveriesForRun: OpenbotChannelStoreShape["countDeliveriesForRun"] = (runId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM openbot_deliveries WHERE run_id = ${runId}
    `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

  const insertDelivery: OpenbotChannelStoreShape["insertDelivery"] = (delivery) => {
    const replyToJson: Effect.Effect<string | null, Schema.SchemaError> =
      delivery.replyTo === null ? Effect.succeed(null) : encodeReplyTarget(delivery.replyTo);
    return replyToJson.pipe(
      Effect.flatMap(
        (replyToJson) => sql`
          INSERT INTO openbot_deliveries (
            delivery_id, channel_id, run_id, kind, text, reply_to_json, created_at
          )
          VALUES (
            ${delivery.id}, ${delivery.channelId}, ${delivery.runId}, ${delivery.kind},
            ${delivery.text}, ${replyToJson}, ${delivery.createdAt}
          )
        `,
      ),
      Effect.asVoid,
    );
  };

  const getContext: OpenbotChannelStoreShape["getContext"] = Effect.fn(function* (threadId) {
    const rows = yield* sql<{
      readonly instructions: string;
      readonly knowledge: string;
      readonly revision: number;
    }>`
      SELECT instructions, knowledge, revision FROM openbot_thread_context WHERE thread_id = ${threadId}
    `;
    const row = rows[0];
    return row === undefined
      ? { threadId, instructions: "", knowledge: "", revision: 0 }
      : { threadId, ...row };
  });

  const updateContext: OpenbotChannelStoreShape["updateContext"] = Effect.fn(function* (context) {
    // One atomic statement for both first-write and compare-and-swap updates.
    const rows = yield* sql<{
      readonly instructions: string;
      readonly knowledge: string;
      readonly revision: number;
    }>`
      INSERT INTO openbot_thread_context (thread_id, instructions, knowledge, revision)
      SELECT ${context.threadId}, ${context.instructions}, ${context.knowledge}, 1
      WHERE ${context.revision} = 0 OR EXISTS (
        SELECT 1 FROM openbot_thread_context WHERE thread_id = ${context.threadId}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        instructions = excluded.instructions, knowledge = excluded.knowledge,
        revision = openbot_thread_context.revision + 1
      WHERE openbot_thread_context.revision = ${context.revision}
      RETURNING instructions, knowledge, revision
    `;
    return rows[0] === undefined ? undefined : { threadId: context.threadId, ...rows[0] };
  });

  const update: OpenbotChannelStoreShape["update"] = Effect.fn(function* (channel) {
    const model = yield* encodeModelSelection(channel.modelSelection);
    const rows = yield* sql<{ readonly channel_id: string }>`
      UPDATE openbot_channels SET
        name = ${channel.name}, avatar = ${channel.avatar}, description = ${channel.description},
        model_selection_json = ${model}, revision = revision + 1, updated_at = ${channel.updatedAt}
      WHERE channel_id = ${channel.id} AND revision = ${channel.revision}
      RETURNING channel_id
    `;
    return rows[0] === undefined ? undefined : yield* getById(channel.id);
  });

  const setModelSelection: OpenbotChannelStoreShape["setModelSelection"] = Effect.fn(
    function* (input) {
      const model = yield* encodeModelSelection(input.modelSelection);
      yield* sql`
      UPDATE openbot_channels SET model_selection_json = ${model}, updated_at = ${input.updatedAt}
      WHERE channel_id = ${input.channelId}
    `;
      return yield* getById(input.channelId);
    },
  );

  const selectProjects = (where: ReturnType<typeof sql.and> | undefined) => sql<ProjectRow>`
    SELECT project_id, name, icon_json, instructions, revision, t3_project_id, main_channel_id,
      workspace_kind, workspace_path, created_at, updated_at
    FROM openbot_projects
    WHERE deleted_at IS NULL ${where === undefined ? sql`` : sql`AND ${where}`}
    ORDER BY created_at ASC, rowid ASC
  `;

  const listProjects: OpenbotChannelStoreShape["listProjects"] = selectProjects(undefined).pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, rowToProject)),
  );

  const getProject: OpenbotChannelStoreShape["getProject"] = (projectId) =>
    selectProjects(sql.and([sql`project_id = ${projectId}`])).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, rowToProject)),
      Effect.map((entries) => entries[0]),
    );

  const insertProject: OpenbotChannelStoreShape["insertProject"] = (project) =>
    encodeProjectIcon(project.icon).pipe(
      Effect.flatMap(
        (iconJson) => sql`
          INSERT INTO openbot_projects (
            project_id, name, icon_json, instructions, revision, t3_project_id, main_channel_id,
            workspace_kind, workspace_path, created_at, updated_at
          )
          VALUES (
            ${project.id}, ${project.name}, ${iconJson}, ${project.instructions}, ${project.revision},
            ${project.t3ProjectId}, ${project.mainChannelId}, ${project.workspace.kind},
            ${project.workspace.path}, ${project.createdAt}, ${project.updatedAt}
          )
        `,
      ),
      Effect.asVoid,
    );

  // Read then compare-and-swap: the revision guard on the write is what makes
  // a stale patch fail, so reading the current row first is safe and keeps the
  // "omitted field keeps its value" rule out of the SQL.
  const updateProject: OpenbotChannelStoreShape["updateProject"] = Effect.fn(function* (patch) {
    const current = yield* getProject(patch.projectId);
    if (current === undefined) return undefined;
    const iconJson = yield* encodeProjectIcon(patch.icon ?? current.icon);
    const rows = yield* sql<{ readonly project_id: string }>`
      UPDATE openbot_projects SET
        name = ${patch.name ?? current.name},
        icon_json = ${iconJson},
        instructions = ${patch.instructions ?? current.instructions},
        revision = revision + 1,
        updated_at = ${patch.updatedAt}
      WHERE project_id = ${patch.projectId} AND deleted_at IS NULL
        AND revision = ${patch.expectedRevision}
      RETURNING project_id
    `;
    return rows[0] === undefined ? undefined : yield* getProject(patch.projectId);
  });

  const projectWorkspaceInUse: OpenbotChannelStoreShape["projectWorkspaceInUse"] = (
    workspacePath,
  ) =>
    sql<{ readonly project_id: string }>`
      SELECT project_id FROM openbot_projects WHERE workspace_path = ${workspacePath}
    `.pipe(Effect.map((rows) => rows.length > 0));

  const isProjectDeleted: OpenbotChannelStoreShape["isProjectDeleted"] = (projectId) =>
    sql<{ readonly project_id: string }>`
      SELECT project_id FROM openbot_projects
      WHERE project_id = ${projectId} AND deleted_at IS NOT NULL
    `.pipe(Effect.map((rows) => rows[0] !== undefined));

  const deleteProject: OpenbotChannelStoreShape["deleteProject"] = (input) =>
    sql<{ readonly project_id: string }>`
      UPDATE openbot_projects SET deleted_at = ${input.deletedAt}, revision = revision + 1
      WHERE project_id = ${input.projectId} AND deleted_at IS NULL
      RETURNING project_id
    `.pipe(Effect.map((rows) => rows[0] !== undefined));

  const knowledgeProjectIds = (knowledgeId: OpenbotKnowledgeId) =>
    sql<{ readonly project_id: string }>`
      SELECT project_id FROM openbot_knowledge_projects
      WHERE knowledge_id = ${knowledgeId}
      ORDER BY project_id ASC
    `.pipe(Effect.map((rows) => rows.map((row) => OpenbotProjectId.make(row.project_id))));

  const withLinks = (rows: ReadonlyArray<KnowledgeRow>) =>
    Effect.forEach(rows, (row) =>
      knowledgeProjectIds(OpenbotKnowledgeId.make(row.knowledge_id)).pipe(
        Effect.map((projectIds) => rowToKnowledge(row, projectIds)),
      ),
    );

  const listKnowledge: OpenbotChannelStoreShape["listKnowledge"] = (input) =>
    (input.projectId === undefined
      ? sql<KnowledgeRow>`
          SELECT knowledge_id, title, body, owner_project_id, revision, created_at, updated_at
          FROM openbot_knowledge
          WHERE deleted_at IS NULL
          ORDER BY created_at ASC, rowid ASC
        `
      : sql<KnowledgeRow>`
          SELECT k.knowledge_id, k.title, k.body, k.owner_project_id, k.revision, k.created_at, k.updated_at
          FROM openbot_knowledge k
          JOIN openbot_knowledge_projects l ON l.knowledge_id = k.knowledge_id
          WHERE k.deleted_at IS NULL AND l.project_id = ${input.projectId}
          ORDER BY k.created_at ASC, k.rowid ASC
        `
    ).pipe(Effect.flatMap(withLinks));

  const getKnowledge: OpenbotChannelStoreShape["getKnowledge"] = (knowledgeId) =>
    sql<KnowledgeRow>`
      SELECT knowledge_id, title, body, owner_project_id, revision, created_at, updated_at
      FROM openbot_knowledge
      WHERE knowledge_id = ${knowledgeId} AND deleted_at IS NULL
    `.pipe(
      Effect.flatMap(withLinks),
      Effect.map((entries) => entries[0]),
    );

  const replaceLinks = (
    knowledgeId: OpenbotKnowledgeId,
    projectIds: ReadonlyArray<OpenbotProjectId>,
  ) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM openbot_knowledge_projects WHERE knowledge_id = ${knowledgeId}`;
      yield* Effect.forEach(
        projectIds,
        (projectId) =>
          sql`
            INSERT OR IGNORE INTO openbot_knowledge_projects (knowledge_id, project_id)
            VALUES (${knowledgeId}, ${projectId})
          `,
        { discard: true },
      );
    });

  const insertKnowledge: OpenbotChannelStoreShape["insertKnowledge"] = (entry) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO openbot_knowledge (
          knowledge_id, title, body, owner_project_id, revision, created_at, updated_at
        )
        VALUES (
          ${entry.id}, ${entry.title}, ${entry.body}, ${entry.ownerProjectId}, ${entry.revision},
          ${entry.createdAt}, ${entry.updatedAt}
        )
      `;
      yield* replaceLinks(entry.id, entry.projectIds);
    }).pipe(sql.withTransaction);

  const updateKnowledge: OpenbotChannelStoreShape["updateKnowledge"] = (patch) =>
    Effect.gen(function* () {
      const current = yield* getKnowledge(patch.knowledgeId);
      if (current === undefined) return undefined;
      const rows = yield* sql<{ readonly knowledge_id: string }>`
        UPDATE openbot_knowledge SET
          title = ${patch.title ?? current.title},
          body = ${patch.body ?? current.body},
          owner_project_id = ${patch.ownerProjectId === undefined ? current.ownerProjectId : patch.ownerProjectId},
          revision = revision + 1,
          updated_at = ${patch.updatedAt}
        WHERE knowledge_id = ${patch.knowledgeId} AND deleted_at IS NULL
          AND revision = ${patch.expectedRevision}
        RETURNING knowledge_id
      `;
      if (rows[0] === undefined) return undefined;
      if (patch.projectIds !== undefined) {
        yield* replaceLinks(patch.knowledgeId, patch.projectIds);
      }
      return yield* getKnowledge(patch.knowledgeId);
    }).pipe(sql.withTransaction);

  const deleteKnowledge: OpenbotChannelStoreShape["deleteKnowledge"] = (input) =>
    sql<{ readonly knowledge_id: string }>`
      UPDATE openbot_knowledge SET deleted_at = ${input.deletedAt}, revision = revision + 1
      WHERE knowledge_id = ${input.knowledgeId} AND deleted_at IS NULL
        AND revision = ${input.expectedRevision}
      RETURNING knowledge_id
    `.pipe(Effect.map((rows) => rows[0] !== undefined));

  return OpenbotChannelStore.of({
    update,
    setModelSelection,
    getContext,
    updateContext,
    list,
    getById,
    getByThreadId,
    isChannelDeleted,
    insert,
    listDeliveries,
    countDeliveriesForRun,
    insertDelivery,
    listProjects,
    getProject,
    insertProject,
    updateProject,
    isProjectDeleted,
    projectWorkspaceInUse,
    deleteProject,
    listKnowledge,
    getKnowledge,
    insertKnowledge,
    updateKnowledge,
    deleteKnowledge,
  });
});

export const layer: Layer.Layer<OpenbotChannelStore, never, SqlClient.SqlClient> = Layer.effect(
  OpenbotChannelStore,
  make,
);
