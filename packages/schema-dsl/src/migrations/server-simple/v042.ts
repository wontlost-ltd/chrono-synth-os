import { defineMigration, type Migration } from '../../index.js';

export const v042_migration: Migration = defineMigration({
  kind: 'schema',
  id: '042',
  aliases: { postgres: 'v042', 'sqlite-sql': 'v042' },
  description: "企业可靠性：平台 DLQ 事件持久化与 replay",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "platform_dlq_events",
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
          name: "source_component",
          type: "text",
          nullable: false
        },
        {
          name: "source_topic",
          type: "text",
          nullable: false
        },
        {
          name: "dlq_topic",
          type: "text",
          nullable: false,
          check: "dlq_topic IN ('runtime.dlq', 'wallet.dlq', 'governance.dlq')"
        },
        {
          name: "event_type",
          type: "text",
          nullable: false
        },
        {
          name: "partition_key",
          type: "text"
        },
        {
          name: "payload_json",
          type: "text",
          nullable: false
        },
        {
          name: "error_message",
          type: "text",
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('pending', 'replayed')"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "replayed_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_platform_dlq_status",
      table: "platform_dlq_events",
      columns: [
        "status",
        "created_at ASC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_platform_dlq_tenant",
      table: "platform_dlq_events",
      columns: [
        "tenant_id",
        "status",
        "created_at ASC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_platform_dlq_topic",
      table: "platform_dlq_events",
      columns: [
        "dlq_topic",
        "status",
        "created_at ASC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
