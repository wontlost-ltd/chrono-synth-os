import { defineMigration, type Migration } from '../../index.js';

export const v032_migration: Migration = defineMigration({
  kind: 'schema',
  id: '032',
  aliases: { postgres: 'v032', 'sqlite-sql': 'v032' },
  description: "Persona Core 2.0：核心人格、钱包、市场、治理与成长事件",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "persona_core",
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
          name: "owner_user_id",
          type: "text",
          nullable: false,
          references: {
            table: "users",
            column: "id"
          }
        },
        {
          name: "display_name",
          type: "text",
          nullable: false
        },
        {
          name: "profile_json",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('active', 'restricted', 'deceased', 'transferred')"
        },
        {
          name: "visibility",
          type: "text",
          nullable: false,
          default: "private",
          check: "visibility IN ('private', 'shared', 'marketplace')"
        },
        {
          name: "growth_index",
          type: "real",
          nullable: false,
          default: 0,
          check: "growth_index >= 0"
        },
        {
          name: "reputation",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "training_investment",
          type: "real",
          nullable: false,
          default: 0
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
        },
        {
          name: "deceased_at",
          type: "bigint"
        },
        {
          name: "transferred_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_persona_core_owner",
      table: "persona_core",
      columns: [
        "tenant_id",
        "owner_user_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_persona_core_status",
      table: "persona_core",
      columns: [
        "tenant_id",
        "status"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "persona_wallets",
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
          name: "persona_id",
          type: "text",
          unique: true,
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "wallet_address",
          type: "text",
          unique: true,
          nullable: false
        },
        {
          name: "balance",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "token_balance",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "last_settled_at",
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
      name: "idx_persona_wallets_persona",
      table: "persona_wallets",
      columns: [
        "tenant_id",
        "persona_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "persona_forks",
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
          name: "persona_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "label",
          type: "text",
          nullable: false
        },
        {
          name: "fork_type",
          type: "text",
          nullable: false,
          check: "fork_type IN ('experimental', 'task', 'social', 'research', 'operations')"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          default: "active",
          check: "status IN ('active', 'recycled', 'archived')"
        },
        {
          name: "sync_mode",
          type: "text",
          nullable: false,
          default: "core",
          check: "sync_mode IN ('core', 'isolated')"
        },
        {
          name: "experience_factor",
          type: "real",
          nullable: false,
          default: 1,
          check: "experience_factor >= 0 AND experience_factor <= 2"
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
        },
        {
          name: "recycled_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_persona_forks_persona",
      table: "persona_forks",
      columns: [
        "tenant_id",
        "persona_id",
        "status"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "persona_memories",
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
          name: "persona_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "fork_id",
          type: "text",
          references: {
            table: "persona_forks",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "kind",
          type: "text",
          nullable: false,
          check: "kind IN ('interaction', 'task', 'training', 'knowledge', 'governance')"
        },
        {
          name: "summary",
          type: "text",
          nullable: false
        },
        {
          name: "content_json",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "importance",
          type: "real",
          nullable: false,
          default: 0.5,
          check: "importance >= 0 AND importance <= 1"
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
      name: "idx_persona_memories_persona",
      table: "persona_memories",
      columns: [
        "tenant_id",
        "persona_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "persona_knowledge_items",
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
          name: "persona_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "title",
          type: "text",
          nullable: false
        },
        {
          name: "content",
          type: "text",
          nullable: false
        },
        {
          name: "source",
          type: "text",
          nullable: false,
          default: "manual"
        },
        {
          name: "tags_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "confidence",
          type: "real",
          nullable: false,
          default: 0.5,
          check: "confidence >= 0 AND confidence <= 1"
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
      name: "idx_persona_knowledge_persona",
      table: "persona_knowledge_items",
      columns: [
        "tenant_id",
        "persona_id",
        "updated_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "marketplace_tasks",
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
          name: "publisher_user_id",
          type: "text",
          nullable: false,
          references: {
            table: "users",
            column: "id"
          }
        },
        {
          name: "assignee_persona_id",
          type: "text",
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "assignee_fork_id",
          type: "text",
          references: {
            table: "persona_forks",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "title",
          type: "text",
          nullable: false
        },
        {
          name: "description",
          type: "text",
          nullable: false
        },
        {
          name: "category",
          type: "text",
          nullable: false,
          check: "category IN ('writing', 'coding', 'research', 'operations', 'general')"
        },
        {
          name: "reward",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "currency",
          type: "text",
          nullable: false,
          default: "CRED"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('open', 'accepted', 'completed', 'cancelled')"
        },
        {
          name: "quality_score",
          type: "real"
        },
        {
          name: "growth_delta",
          type: "real"
        },
        {
          name: "published_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "accepted_at",
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
      name: "idx_marketplace_tasks_status",
      table: "marketplace_tasks",
      columns: [
        "tenant_id",
        "status",
        "updated_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_marketplace_tasks_assignee",
      table: "marketplace_tasks",
      columns: [
        "tenant_id",
        "assignee_persona_id",
        "updated_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "persona_growth_events",
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
          name: "persona_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "task_id",
          type: "text",
          references: {
            table: "marketplace_tasks",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "event_type",
          type: "text",
          nullable: false,
          check: "event_type IN ('task_completed', 'training', 'knowledge_sync', 'governance')"
        },
        {
          name: "growth_delta",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "reputation_delta",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "training_delta",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "payload_json",
          type: "text",
          nullable: false,
          default: "{}"
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
      name: "idx_persona_growth_events_persona",
      table: "persona_growth_events",
      columns: [
        "tenant_id",
        "persona_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "persona_governance_events",
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
          name: "persona_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "event_type",
          type: "text",
          nullable: false,
          check: "event_type IN ('warning', 'reward', 'restriction', 'review', 'transfer', 'death')"
        },
        {
          name: "severity",
          type: "integer",
          nullable: false,
          check: "severity >= 1 AND severity <= 5"
        },
        {
          name: "summary",
          type: "text",
          nullable: false
        },
        {
          name: "payload_json",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "actor_user_id",
          type: "text",
          references: {
            table: "users",
            column: "id",
            onDelete: "SET NULL"
          }
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
      name: "idx_persona_governance_events_persona",
      table: "persona_governance_events",
      columns: [
        "tenant_id",
        "persona_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
