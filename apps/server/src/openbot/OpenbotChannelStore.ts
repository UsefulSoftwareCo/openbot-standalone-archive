import {
  type OpenbotThreadContext,
  ModelSelection,
  OpenbotChannel,
  OpenbotChannelId,
  OpenbotDelivery,
  OpenbotDeliveryId,
  OpenbotDeliveryKind,
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
 * SQL-only persistence for OpenBot channels and deliveries. Kept separate from
 * the service so the provider-turn instruction hook can resolve a thread's
 * channel without depending on orchestration services.
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

const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const encodeModelSelection = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const decodeDeliveryKind = Schema.decodeUnknownEffect(OpenbotDeliveryKind);
const decodeReplyTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenbotReplyTarget));
const encodeReplyTarget = Schema.encodeEffect(Schema.fromJsonString(OpenbotReplyTarget));

export type OpenbotChannelStoreError = SqlError | Schema.SchemaError;

export interface OpenbotChannelStoreShape {
  readonly update: (
    channel: OpenbotChannel,
  ) => Effect.Effect<OpenbotChannel | undefined, OpenbotChannelStoreError>;
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
  readonly insert: (channel: OpenbotChannel) => Effect.Effect<void, OpenbotChannelStoreError>;
  readonly listDeliveries: (
    channelId: OpenbotChannelId,
  ) => Effect.Effect<ReadonlyArray<OpenbotDelivery>, OpenbotChannelStoreError>;
  readonly countDeliveriesForRun: (runId: RunId) => Effect.Effect<number, OpenbotChannelStoreError>;
  readonly insertDelivery: (
    delivery: OpenbotDelivery,
  ) => Effect.Effect<void, OpenbotChannelStoreError>;
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

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectChannels = (where: ReturnType<typeof sql.and> | undefined) => sql<ChannelRow>`
    SELECT channel_id, name, avatar, description, revision, project_id, thread_id, model_selection_json, created_at, updated_at
    FROM openbot_channels
    ${where === undefined ? sql`` : sql`WHERE ${where}`}
    ORDER BY created_at ASC, rowid ASC
  `;

  const list: OpenbotChannelStoreShape["list"] = selectChannels(undefined).pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, rowToChannel)),
  );

  const getById: OpenbotChannelStoreShape["getById"] = (channelId) =>
    selectChannels(sql.and([sql`channel_id = ${channelId}`])).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(undefined) : rowToChannel(rows[0]),
      ),
    );

  const getByThreadId: OpenbotChannelStoreShape["getByThreadId"] = (threadId) =>
    selectChannels(sql.and([sql`thread_id = ${threadId}`])).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(undefined) : rowToChannel(rows[0]),
      ),
    );

  const insert: OpenbotChannelStoreShape["insert"] = (channel) =>
    encodeModelSelection(channel.modelSelection).pipe(
      Effect.flatMap(
        (modelSelectionJson) => sql`
          INSERT INTO openbot_channels (
            channel_id, name, avatar, description, revision, project_id, thread_id, model_selection_json, created_at, updated_at
          )
          VALUES (
            ${channel.id}, ${channel.name}, ${channel.avatar}, ${channel.description}, ${channel.revision}, ${channel.projectId}, ${channel.threadId},
            ${modelSelectionJson}, ${channel.createdAt}, ${channel.updatedAt}
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
    const rows =
      yield* sql<ChannelRow>`UPDATE openbot_channels SET name = ${channel.name}, avatar = ${channel.avatar}, description = ${channel.description}, model_selection_json = ${model}, revision = revision + 1, updated_at = ${channel.updatedAt} WHERE channel_id = ${channel.id} AND revision = ${channel.revision} RETURNING *`;
    return rows[0] === undefined ? undefined : yield* rowToChannel(rows[0]);
  });
  return OpenbotChannelStore.of({
    update,
    getContext,
    updateContext,
    list,
    getById,
    getByThreadId,
    insert,
    listDeliveries,
    countDeliveriesForRun,
    insertDelivery,
  });
});

export const layer: Layer.Layer<OpenbotChannelStore, never, SqlClient.SqlClient> = Layer.effect(
  OpenbotChannelStore,
  make,
);
