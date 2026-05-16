import { defineMigration, type Migration } from '../../index.js';

export const v029_migration: Migration = defineMigration({
  kind: 'schema',
  id: '029',
  aliases: { postgres: 'v029', 'sqlite-sql': 'v029' },
  description: "Avatar 自动运行配置、运行日志、知识源表",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "avatar_autorun_config",
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
          name: "avatar_id",
          type: "text",
          nullable: false,
          references: {
            table: "avatars",
            column: "id"
          }
        },
        {
          name: "enabled",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "interval_ms",
          type: "bigint",
          nullable: false
        },
        {
          name: "next_run_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "knowledge_source_ids_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "drift_check_interval_ms",
          type: "bigint",
          nullable: false,
          default: 86400000
        },
        {
          name: "drift_threshold",
          type: "real",
          nullable: false,
          default: 0.3
        },
        {
          name: "review_required",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "last_run_at",
          type: "bigint"
        },
        {
          name: "last_drift_check_at",
          type: "bigint"
        },
        {
          name: "last_error",
          type: "text"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_autorun_config_avatar",
      table: "avatar_autorun_config",
      columns: [
        "tenant_id",
        "avatar_id"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_autorun_config_due",
      table: "avatar_autorun_config",
      columns: [
        "tenant_id",
        "enabled",
        "next_run_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "avatar_autorun_runlog",
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
          name: "avatar_id",
          type: "text",
          nullable: false
        },
        {
          name: "config_id",
          type: "text",
          nullable: false,
          references: {
            table: "avatar_autorun_config",
            column: "id"
          }
        },
        {
          name: "task_id",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('pending', 'running', 'completed', 'failed', 'skipped')"
        },
        {
          name: "metrics_json",
          type: "text"
        },
        {
          name: "error",
          type: "text"
        },
        {
          name: "started_at",
          type: "bigint"
        },
        {
          name: "completed_at",
          type: "bigint"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_autorun_runlog_avatar",
      table: "avatar_autorun_runlog",
      columns: [
        "tenant_id",
        "avatar_id",
        "started_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "knowledge_sources",
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
          name: "type",
          type: "text",
          nullable: false,
          check: "type IN ('rss', 'api', 'file', 'manual')"
        },
        {
          name: "name",
          type: "text",
          nullable: false
        },
        {
          name: "enabled",
          type: "integer",
          nullable: false,
          default: 1
        },
        {
          name: "config_json",
          type: "text",
          nullable: false
        },
        {
          name: "state_json",
          type: "text"
        },
        {
          name: "last_ingested_at",
          type: "bigint"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_knowledge_sources_tenant",
      table: "knowledge_sources",
      columns: [
        "tenant_id",
        "enabled",
        "type"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
