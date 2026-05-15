import { defineMigration, type Migration } from '../../index.js';

export const v056_migration: Migration = defineMigration({
  kind: 'schema',
  id: '056',
  aliases: { postgres: 'v056', 'sqlite-sql': 'v056' },
  description: "平台运维操作日志（控制平面事件）",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "platform_ops_log",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "event_type",
          type: "text",
          nullable: false
        },
        {
          name: "payload_json",
          type: "text",
          nullable: false
        },
        {
          name: "occurred_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_platform_ops_log_time",
      table: "platform_ops_log",
      columns: [
        "occurred_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
