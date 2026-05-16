import { defineMigration, type Migration } from '../../index.js';

export const v070_migration: Migration = defineMigration({
  kind: 'schema',
  id: '070',
  aliases: { postgres: 'v070', 'sqlite-sql': 'v070' },
  description: "P2.7 health dashboard: core_values_snapshot daily history",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "core_values_snapshot",
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
          type: "text"
        },
        {
          name: "values_json",
          type: "text",
          nullable: false
        },
        {
          name: "snapshot_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_core_values_snapshot_tenant_ts",
      table: "core_values_snapshot",
      columns: [
        "tenant_id",
        "snapshot_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_core_values_snapshot_retention",
      table: "core_values_snapshot",
      columns: [
        "snapshot_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
