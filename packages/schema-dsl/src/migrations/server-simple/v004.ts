import { defineMigration, type Migration } from '../../index.js';

export const v004_cognitive_memory: Migration = defineMigration({
  kind: 'schema',
  id: 'cognitive-memory',
  aliases: { postgres: 'v004', 'sqlite-sql': 'v004' },
  description: '认知记忆扩展',
  operations: [
    { kind: 'add-column', table: 'memory_nodes', ifNotExists: true, safeIfTableExists: true, column: { name: 'access_count', type: 'integer', nullable: false, default: 0 } },
    { kind: 'add-column', table: 'memory_nodes', ifNotExists: true, safeIfTableExists: true, column: { name: 'decay_lambda', type: 'real', nullable: false, default: 0.0001 } },
    { kind: 'add-column', table: 'memory_nodes', ifNotExists: true, safeIfTableExists: true, column: { name: 'last_decayed_at', type: 'bigint', nullable: false, default: 0 } },
    { kind: 'add-column', table: 'memory_nodes', ifNotExists: true, safeIfTableExists: true, column: { name: 'consolidated_from', type: 'text', references: { table: 'memory_nodes', column: 'id', onDelete: 'SET NULL' } } },
    { kind: 'create-table', table: { name: 'working_memory', ifNotExists: true, columns: [
      { name: 'memory_id', type: 'text', primaryKey: true, references: { table: 'memory_nodes', column: 'id', onDelete: 'CASCADE' } },
      { name: 'score', type: 'real', nullable: false },
      { name: 'entered_at', type: 'bigint', nullable: false },
    ] } },
    { kind: 'create-index', index: { name: 'idx_working_memory_score', table: 'working_memory', columns: ['score'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_memory_nodes_salience', table: 'memory_nodes', columns: ['salience'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_memory_nodes_kind_access', table: 'memory_nodes', columns: ['kind', 'access_count'], ifNotExists: true } },
  ],
});
