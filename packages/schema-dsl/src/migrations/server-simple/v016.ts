import { defineMigration, type Migration } from '../../index.js';

export const v016_migration: Migration = defineMigration({
  kind: 'schema',
  id: '016',
  aliases: { postgres: 'v016', 'sqlite-sql': 'v016' },
  description: "Webhook 事件去重表与 LLM 用量持久化表",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "webhook_events",
      ifNotExists: true,
      columns: [
        {
          name: "event_id",
          type: "text",
          primaryKey: true
        },
        {
          name: "event_type",
          type: "text",
          nullable: false
        },
        {
          name: "processed_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-table",
    table: {
      name: "llm_usage",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "bigint",
          primaryKey: true,
          autoIncrement: true
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "provider",
          type: "text",
          nullable: false
        },
        {
          name: "model",
          type: "text",
          nullable: false
        },
        {
          name: "input_tokens",
          type: "integer",
          nullable: false
        },
        {
          name: "output_tokens",
          type: "integer",
          nullable: false
        },
        {
          name: "total_tokens",
          type: "integer",
          nullable: false
        },
        {
          name: "estimated_cost_usd",
          type: "real",
          nullable: false
        },
        {
          name: "recorded_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_llm_usage_tenant",
      table: "llm_usage",
      columns: [
        "tenant_id",
        "recorded_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
