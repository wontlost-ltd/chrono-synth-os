import { defineMigration, type Migration } from '../../index.js';

export const v031_migration: Migration = defineMigration({
  kind: 'schema',
  id: '031',
  aliases: { postgres: 'v031', 'sqlite-sql': 'v031' },
  description: "补充 audit_log、subscriptions、pending_updates 等表的查询索引",
  operations: [
  {
    kind: "create-index",
    index: {
      name: "idx_audit_log_tenant_timestamp",
      table: "audit_log",
      columns: [
        "tenant_id",
        "timestamp"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_subscriptions_tenant_status",
      table: "subscriptions",
      columns: [
        "tenant_id",
        "status"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_pending_updates_status",
      table: "pending_updates",
      columns: [
        "status",
        "created_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_conflicts_resolved",
      table: "conflicts",
      columns: [
        "resolved_at",
        "detected_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_working_memory_score",
      table: "working_memory",
      columns: [
        "score DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_autorun_config_next_run",
      table: "avatar_autorun_config",
      columns: [
        "enabled",
        "next_run_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_autorun_runlog_tenant_avatar",
      table: "avatar_autorun_runlog",
      columns: [
        "tenant_id",
        "avatar_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
