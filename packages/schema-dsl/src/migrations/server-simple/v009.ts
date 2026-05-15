import { defineMigration, type Migration } from '../../index.js';

export const v009_core_values_tuning: Migration = defineMigration({
  kind: 'schema',
  id: 'core-values-tuning',
  aliases: { postgres: 'v009', 'sqlite-sql': 'v009' },
  description: '核心价值扩展 time_discount/emotion_amplifier',
  operations: [
    { kind: 'add-column', table: 'core_values', ifNotExists: true, safeIfTableExists: true, column: { name: 'time_discount', type: 'real', nullable: false, default: 0.5 } },
    { kind: 'add-column', table: 'core_values', ifNotExists: true, safeIfTableExists: true, column: { name: 'emotion_amplifier', type: 'real', nullable: false, default: '1.0' } },
  ],
});
