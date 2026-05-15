import { defineMigration, type Migration } from '../../index.js';

export const v036_migration: Migration = defineMigration({
  kind: 'schema',
  id: '036',
  aliases: { postgres: 'v036', 'sqlite-sql': 'v036' },
  description: "Persona OS v1：钱包账本、提现请求与任务结算",
  operations: [
  {
    kind: "add-column",
    table: "persona_wallets",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "currency",
      type: "text",
      nullable: false,
      default: "CRED"
    }
  },
  {
    kind: "add-column",
    table: "persona_wallets",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "status",
      type: "text",
      nullable: false,
      default: "active"
    }
  },
  {
    kind: "create-table",
    table: {
      name: "wallet_transactions",
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
          name: "wallet_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_wallets",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "transaction_type",
          type: "text",
          nullable: false,
          check: "transaction_type IN ('task_payment', 'platform_fee', 'owner_payout', 'persona_reserve', 'refund')"
        },
        {
          name: "amount_minor",
          type: "bigint",
          nullable: false
        },
        {
          name: "currency",
          type: "text",
          nullable: false
        },
        {
          name: "reference_type",
          type: "text"
        },
        {
          name: "reference_id",
          type: "text"
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
      name: "idx_wallet_transactions_wallet",
      table: "wallet_transactions",
      columns: [
        "tenant_id",
        "wallet_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_wallet_transactions_reference",
      table: "wallet_transactions",
      columns: [
        "tenant_id",
        "reference_type",
        "reference_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "wallet_payout_requests",
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
          name: "wallet_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_wallets",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "amount_minor",
          type: "bigint",
          nullable: false,
          check: "amount_minor > 0"
        },
        {
          name: "currency",
          type: "text",
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('completed', 'rejected')"
        },
        {
          name: "requested_by_user_id",
          type: "text",
          nullable: false,
          references: {
            table: "users",
            column: "id"
          }
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "completed_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_wallet_payout_requests_wallet",
      table: "wallet_payout_requests",
      columns: [
        "tenant_id",
        "wallet_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "wallet_settlements",
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
          name: "wallet_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_wallets",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "task_id",
          type: "text",
          nullable: false,
          references: {
            table: "marketplace_tasks",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "assignment_id",
          type: "text",
          unique: true,
          nullable: false,
          references: {
            table: "task_assignments",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "total_amount_minor",
          type: "bigint",
          nullable: false,
          check: "total_amount_minor > 0"
        },
        {
          name: "currency",
          type: "text",
          nullable: false
        },
        {
          name: "owner_pct",
          type: "integer",
          nullable: false
        },
        {
          name: "persona_pct",
          type: "integer",
          nullable: false
        },
        {
          name: "platform_pct",
          type: "integer",
          nullable: false
        },
        {
          name: "owner_amount_minor",
          type: "bigint",
          nullable: false
        },
        {
          name: "persona_amount_minor",
          type: "bigint",
          nullable: false
        },
        {
          name: "platform_amount_minor",
          type: "bigint",
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('completed')"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "completed_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_wallet_settlements_wallet",
      table: "wallet_settlements",
      columns: [
        "tenant_id",
        "wallet_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_wallet_settlements_task",
      table: "wallet_settlements",
      columns: [
        "tenant_id",
        "task_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
