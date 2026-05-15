import { defineMigration, type Migration } from '../../index.js';

export const desktop_v002: Migration = defineMigration({
  kind: 'schema',
  id: 'desktop-identities',
  aliases: { 'sqlite-rust': 'v002' },
  description: 'identities',
  target: 'desktop-only',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'identities',
        ifNotExists: true,
        columns: [
          { name: 'identity_id', type: 'text', primaryKey: true },
          {
            name: 'persona_id',
            type: 'text',
            nullable: false,
            references: { table: 'personas', column: 'persona_id', onDelete: 'CASCADE' },
          },
          { name: 'display_name', type: 'text', nullable: false },
          { name: 'type', type: 'text', nullable: false },
          { name: 'updated_at', type: 'text', nullable: false },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_identities_persona',
        table: 'identities',
        columns: ['persona_id'],
        ifNotExists: true,
      },
    },
  ],
});
