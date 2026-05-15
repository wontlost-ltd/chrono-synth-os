import { defineMigration, type Migration } from '../../index.js';

export const desktop_v005: Migration = defineMigration({
  kind: 'schema',
  id: 'desktop-tool-invocations-cache',
  aliases: { 'sqlite-rust': 'v005' },
  description: 'tool_invocations cache',
  target: 'desktop-only',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'tool_invocations',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          {
            name: 'persona_id',
            type: 'text',
            nullable: false,
            references: { table: 'personas', column: 'persona_id', onDelete: 'CASCADE' },
          },
          { name: 'tool_id', type: 'text', nullable: false },
          { name: 'status', type: 'text', nullable: false },
          { name: 'invoker_type', type: 'text', nullable: false },
          { name: 'invoked_at', type: 'integer', nullable: false },
          { name: 'duration_ms', type: 'integer', nullable: false, default: 0 },
          { name: 'error_message', type: 'text' },
          { name: 'confirmation_token_id', type: 'text' },
          { name: 'synced_at', type: 'integer', nullable: false, default: 0 },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_tool_invocations_recency',
        table: 'tool_invocations',
        columns: ['persona_id', 'invoked_at DESC'],
        ifNotExists: true,
      },
    },
  ],
});
