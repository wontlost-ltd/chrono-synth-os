import { defineMigration, type Migration } from '../../index.js';

export const desktop_v004: Migration = defineMigration({
  kind: 'schema',
  id: 'desktop-knowledge-sources',
  aliases: { 'sqlite-rust': 'v004' },
  description: 'knowledge_sources',
  target: 'desktop-only',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'knowledge_sources',
        ifNotExists: true,
        columns: [
          { name: 'source_id', type: 'text', primaryKey: true },
          {
            name: 'persona_id',
            type: 'text',
            references: { table: 'personas', column: 'persona_id', onDelete: 'CASCADE' },
          },
          { name: 'kind', type: 'text', nullable: false },
          { name: 'label', type: 'text', nullable: false },
          { name: 'url', type: 'text' },
          { name: 'last_synced', type: 'integer' },
          { name: 'updated_at', type: 'integer', nullable: false },
          { name: 'synced_at', type: 'integer', nullable: false, default: 0 },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_knowledge_sources_persona',
        table: 'knowledge_sources',
        columns: ['persona_id'],
        ifNotExists: true,
      },
    },
  ],
});
