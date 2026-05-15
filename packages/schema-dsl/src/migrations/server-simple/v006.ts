import { defineMigration, type Migration } from '../../index.js';

export const v006_memory_embeddings: Migration = defineMigration({
  kind: 'schema',
  id: 'memory-embeddings',
  aliases: { postgres: 'v006', 'sqlite-sql': 'v006' },
  description: '记忆向量索引',
  operations: [
    { kind: 'create-table', table: { name: 'memory_embeddings', ifNotExists: true, columns: [
      { name: 'memory_id', type: 'text', primaryKey: true, references: { table: 'memory_nodes', column: 'id', onDelete: 'CASCADE' } },
      { name: 'embedding_json', type: 'text', nullable: false },
      { name: 'model', type: 'text', nullable: false },
      { name: 'updated_at', type: 'bigint', nullable: false },
    ] } },
  ],
});
