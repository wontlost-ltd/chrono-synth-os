import { defineMigration, type Migration } from '../../index.js';

export const v028_migration: Migration = defineMigration({
  kind: 'schema',
  id: '028',
  aliases: { postgres: 'v028', 'sqlite-sql': 'v028' },
  description: "记忆淘汰索引（salience + last_accessed_at）",
  operations: [
  {
    kind: "create-index",
    index: {
      name: "idx_memory_nodes_tenant_salience",
      table: "memory_nodes",
      columns: [
        "tenant_id",
        "salience"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_memory_nodes_tenant_last_accessed",
      table: "memory_nodes",
      columns: [
        "tenant_id",
        "last_accessed_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
