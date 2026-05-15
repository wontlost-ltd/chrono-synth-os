import { defineMigration, type Migration } from '../../index.js';

export const v020_migration: Migration = defineMigration({
  kind: 'schema',
  id: '020',
  aliases: { postgres: 'v020', 'sqlite-sql': 'v020' },
  description: "Stripe 计量发件箱 — 持久化重试",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "billing_outbox",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "integer",
          primaryKey: true,
          autoIncrement: true
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "customer_id",
          type: "text",
          nullable: false
        },
        {
          name: "event_name",
          type: "text",
          nullable: false
        },
        {
          name: "quantity",
          type: "integer",
          nullable: false
        },
        {
          name: "idempotency_key",
          type: "text",
          unique: true,
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          default: "pending"
        },
        {
          name: "attempts",
          type: "integer",
          nullable: false,
          default: 0
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
          name: "processed_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_billing_outbox_status",
      table: "billing_outbox",
      columns: [
        "status",
        "created_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
