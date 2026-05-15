import { defineMigration, type Migration } from '../../index.js';

export const v044_migration: Migration = defineMigration({
  kind: 'schema',
  id: '044',
  aliases: { postgres: 'v044', 'sqlite-sql': 'v044' },
  description: "企业商用：billing catalog、invoice、usage meter",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "billing_plans",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "name",
          type: "text",
          nullable: false
        },
        {
          name: "stripe_price_id",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "price_minor",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "currency",
          type: "text",
          nullable: false,
          default: "USD"
        },
        {
          name: "billing_interval",
          type: "text",
          nullable: false,
          default: "month"
        },
        {
          name: "limits_json",
          type: "text",
          nullable: false
        },
        {
          name: "is_active",
          type: "integer",
          nullable: false,
          default: 1
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
      name: "idx_billing_plans_active",
      table: "billing_plans",
      columns: [
        "is_active",
        "id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "billing_invoices",
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
          name: "subscription_id",
          type: "text",
          nullable: false,
          references: {
            table: "subscriptions",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "plan_id",
          type: "text",
          nullable: false,
          references: {
            table: "billing_plans",
            column: "id"
          }
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('draft', 'open', 'paid', 'void')"
        },
        {
          name: "amount_minor",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "currency",
          type: "text",
          nullable: false,
          default: "USD"
        },
        {
          name: "billing_interval",
          type: "text",
          nullable: false,
          default: "month"
        },
        {
          name: "period_start",
          type: "bigint",
          nullable: false
        },
        {
          name: "period_end",
          type: "bigint",
          nullable: false
        },
        {
          name: "wallet_settlement_count",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "wallet_settlement_total_minor",
          type: "bigint",
          nullable: false,
          default: 0
        },
        {
          name: "reconciliation_status",
          type: "text",
          nullable: false,
          default: "balanced",
          check: "reconciliation_status IN ('balanced', 'mismatch', 'repair_required')"
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
          name: "paid_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_billing_invoices_period",
      table: "billing_invoices",
      columns: [
        "tenant_id",
        "subscription_id",
        "period_start"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_billing_invoices_tenant",
      table: "billing_invoices",
      columns: [
        "tenant_id",
        "status",
        "period_start DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "usage_meters",
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
          name: "resource",
          type: "text",
          nullable: false
        },
        {
          name: "period_start",
          type: "bigint",
          nullable: false
        },
        {
          name: "period_end",
          type: "bigint",
          nullable: false
        },
        {
          name: "total_quantity",
          type: "integer",
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
  },
  {
    kind: "create-index",
    index: {
      name: "idx_usage_meters_period",
      table: "usage_meters",
      columns: [
        "tenant_id",
        "resource",
        "period_start",
        "period_end"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_usage_meters_tenant",
      table: "usage_meters",
      columns: [
        "tenant_id",
        "period_start DESC",
        "resource"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
