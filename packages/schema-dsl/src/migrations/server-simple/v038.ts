import { defineMigration, type Migration } from '../../index.js';

export const v038_migration: Migration = defineMigration({
  kind: 'schema',
  id: '038',
  aliases: { postgres: 'v038', 'sqlite-sql': 'v038' },
  description: "企业可观测性：异步观测发件箱与聚合滚动表",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "observability_outbox",
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
          name: "topic",
          type: "text",
          nullable: false
        },
        {
          name: "event_type",
          type: "text",
          nullable: false
        },
        {
          name: "partition_key",
          type: "text",
          nullable: false
        },
        {
          name: "payload_json",
          type: "text",
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('pending', 'processing', 'sent', 'failed')"
        },
        {
          name: "attempts",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "processed_at",
          type: "bigint"
        },
        {
          name: "last_error",
          type: "text"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_observability_outbox_status",
      table: "observability_outbox",
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
      name: "idx_observability_outbox_tenant",
      table: "observability_outbox",
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
      name: "idx_observability_outbox_topic",
      table: "observability_outbox",
      columns: [
        "topic",
        "partition_key",
        "created_at ASC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "observability_rollups",
      ifNotExists: true,
      columns: [
        {
          name: "tenant_id",
          type: "text",
          primaryKey: true
        },
        {
          name: "runtime_completed_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "runtime_duration_total_ms",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "task_terminal_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "task_success_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "task_rejected_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "task_disputed_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "wallet_settlement_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "wallet_settlement_total_amount_minor",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "wallet_settlement_latency_total_ms",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "governance_case_opened_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "governance_case_active_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "governance_action_applied_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "persona_growth_total",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "persona_growth_event_count",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "persona_reputation_delta_total",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  }
],
});
