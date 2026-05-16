import { defineMigration, type Migration } from '../../index.js';

export const v071_migration: Migration = defineMigration({
  kind: 'schema',
  id: '071',
  aliases: { postgres: 'v073', 'sqlite-sql': 'v071' },
  description: "EP-3.5 devices.is_invalid_at column for push token invalidation",
  operations: [
  {
    kind: "add-column",
    table: "devices",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "is_invalid_at",
      type: "bigint"
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_devices_invalid",
      table: "devices",
      columns: [
        "is_invalid_at"
      ],
      unique: false,
      ifNotExists: true,
      where: "is_invalid_at IS NOT NULL"
    }
  }
],
});
