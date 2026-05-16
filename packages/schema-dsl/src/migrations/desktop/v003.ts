import { defineMigration, type Migration } from '../../index.js';

export const desktop_v003: Migration = defineMigration({
  kind: 'schema',
  id: 'desktop-memory-graph',
  aliases: { 'sqlite-rust': 'v003' },
  description: 'memory_nodes + memory_edges',
  target: 'desktop-only',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'memory_nodes',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          {
            name: 'persona_id',
            type: 'text',
            references: { table: 'personas', column: 'persona_id', onDelete: 'CASCADE' },
          },
          {
            name: 'kind',
            type: 'text',
            nullable: false,
            check: "kind IN ('episodic', 'semantic', 'procedural')",
          },
          { name: 'content', type: 'text', nullable: false },
          { name: 'valence', type: 'real', nullable: false, check: 'valence >= -1 AND valence <= 1' },
          { name: 'salience', type: 'real', nullable: false, check: 'salience >= 0 AND salience <= 1' },
          { name: 'created_at', type: 'integer', nullable: false },
          { name: 'last_accessed_at', type: 'integer', nullable: false },
          { name: 'synced_at', type: 'integer', nullable: false, default: 0 },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_memory_nodes_persona_recency',
        table: 'memory_nodes',
        columns: ['persona_id', 'last_accessed_at DESC'],
        ifNotExists: true,
      },
    },
    {
      kind: 'create-table',
      table: {
        name: 'memory_edges',
        ifNotExists: true,
        columns: [
          {
            name: 'source',
            type: 'text',
            nullable: false,
            references: { table: 'memory_nodes', column: 'id', onDelete: 'CASCADE' },
          },
          {
            name: 'target',
            type: 'text',
            nullable: false,
            references: { table: 'memory_nodes', column: 'id', onDelete: 'CASCADE' },
          },
          { name: 'kind', type: 'text', nullable: false },
          {
            name: 'strength',
            type: 'real',
            nullable: false,
            default: 0.5,
            check: 'strength >= 0 AND strength <= 1',
          },
        ],
        constraints: [{ kind: 'primary-key', columns: ['source', 'target', 'kind'] }],
      },
    },
  ],
});
