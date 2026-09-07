import {
  ModelSelection,
  OpenbotChannel,
  OpenbotChannelId,
  OpenbotDelivery,
  OpenbotDeliveryId,
  OpenbotDeliveryKind,
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
  readonly created_at: string;
}

const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const encodeModelSelection = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const decodeDeliveryKind = Schema.decodeUnknownEffect(OpenbotDeliveryKind);

export type OpenbotChannelStoreError = SqlError | Schema.SchemaError;

export interface OpenbotChannelStoreShape {
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
      projectId: ProjectId.make(row.project_id),
      threadId: ThreadId.make(row.thread_id),
      modelSelection,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  );

const rowToDelivery = (row: DeliveryRow) =>
  decodeDeliveryKind(row.kind).pipe(
    Effect.map((kind): OpenbotDelivery => ({
      id: OpenbotDeliveryId.make(row.delivery_id),
      channelId: OpenbotChannelId.make(row.channel_id),
      runId: RunId.make(row.run_id),
      kind,
      text: row.text,
      createdAt: row.created_at,
    })),
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectChannels = (where: ReturnType<typeof sql.and> | undefined) => sql<ChannelRow>`
    SELECT channel_id, name, project_id, thread_id, model_selection_json, created_at, updated_at
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
            channel_id, name, project_id, thread_id, model_selection_json, created_at, updated_at
          )
          VALUES (
            ${channel.id}, ${channel.name}, ${channel.projectId}, ${channel.threadId},
            ${modelSelectionJson}, ${channel.createdAt}, ${channel.updatedAt}
          )
        `,
      ),
      Effect.asVoid,
    );

  const listDeliveries: OpenbotChannelStoreShape["listDeliveries"] = (channelId) =>
    sql<DeliveryRow>`
      SELECT delivery_id, channel_id, run_id, kind, text, created_at
      FROM openbot_deliveries
      WHERE channel_id = ${channelId}
      ORDER BY created_at ASC, delivery_id ASC
    `.pipe(Effect.flatMap((rows) => Effect.forEach(rows, rowToDelivery)));

  const countDeliveriesForRun: OpenbotChannelStoreShape["countDeliveriesForRun"] = (runId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM openbot_deliveries WHERE run_id = ${runId}
    `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

  const insertDelivery: OpenbotChannelStoreShape["insertDelivery"] = (delivery) =>
    sql`
      INSERT INTO openbot_deliveries (delivery_id, channel_id, run_id, kind, text, created_at)
      VALUES (
        ${delivery.id}, ${delivery.channelId}, ${delivery.runId}, ${delivery.kind},
        ${delivery.text}, ${delivery.createdAt}
      )
    `.pipe(Effect.asVoid);

  return OpenbotChannelStore.of({
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
