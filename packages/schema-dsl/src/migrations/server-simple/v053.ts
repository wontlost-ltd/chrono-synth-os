import { defineMigration, type Migration } from '../../index.js';

export const v053_migration: Migration = defineMigration({
  kind: 'schema',
  id: '053',
  aliases: { postgres: 'v053', 'sqlite-sql': 'v053' },
  description: "persona_core 双写发件箱：暂存待追加至 event_ledger 的事件",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "persona_core_ledger_outbox",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "stream_id",
          type: "text",
          nullable: false
        },
        {
          name: "payload_json",
          type: "text",
          nullable: false
        },
        {
          name: "event_type",
          type: "text",
          nullable: false
        },
        {
          name: "command_id",
          type: "text",
          nullable: false
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "attempts",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "last_attempted_at",
          type: "bigint"
        },
        {
          name: "error",
          type: "text"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_persona_outbox_pending",
      table: "persona_core_ledger_outbox",
      columns: [
        "tenant_id",
        "created_at"
      ],
      unique: false,
      ifNotExists: true,
      where: "attempts < 3"
    }
  }
],
});
