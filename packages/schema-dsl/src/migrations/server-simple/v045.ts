import { defineMigration, type Migration } from '../../index.js';

export const v045_migration: Migration = defineMigration({
  kind: 'schema',
  id: '045',
  aliases: { postgres: 'v045', 'sqlite-sql': 'v045' },
  description: "企业财务：settlement reconciliation runs",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "settlement_reconciliation_runs",
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
          name: "checked_settlements",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "mismatched_settlements",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "repaired_settlements",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "deleted_transactions",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "inserted_transactions",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "orphan_transactions_removed",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "report_json",
          type: "text",
          nullable: false
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
      name: "idx_settlement_reconciliation_runs_tenant",
      table: "settlement_reconciliation_runs",
      columns: [
        "tenant_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
