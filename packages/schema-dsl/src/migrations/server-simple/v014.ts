import { defineMigration, type Migration } from '../../index.js';

export const v014_migration: Migration = defineMigration({
  kind: 'schema',
  id: '014',
  aliases: { postgres: 'v014', 'sqlite-sql': 'v014' },
  description: "订阅与用量记录",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "subscriptions",
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
          name: "stripe_customer_id",
          type: "text"
        },
        {
          name: "stripe_subscription_id",
          type: "text"
        },
        {
          name: "plan_id",
          type: "text",
          nullable: false,
          default: "free"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          default: "active",
          check: "status IN ('active', 'past_due', 'canceled', 'trialing')"
        },
        {
          name: "current_period_start",
          type: "bigint",
          nullable: false
        },
        {
          name: "current_period_end",
          type: "bigint",
          nullable: false
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
      name: "idx_subscriptions_tenant",
      table: "subscriptions",
      columns: [
        "tenant_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_subscriptions_stripe_customer",
      table: "subscriptions",
      columns: [
        "stripe_customer_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "usage_records",
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
          name: "quantity",
          type: "integer",
          nullable: false,
          default: 1
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
      name: "idx_usage_records_tenant_resource",
      table: "usage_records",
      columns: [
        "tenant_id",
        "resource",
        "recorded_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
