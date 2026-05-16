import { defineMigration, type Migration } from '../../index.js';

export const v011_migration: Migration = defineMigration({
  kind: 'schema',
  id: '011',
  aliases: { postgres: 'v011', 'sqlite-sql': 'v011' },
  description: "演化差异报告",
  operations: [
  {
    kind: "add-column",
    table: "evolution_records",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "diff_report_json",
      type: "text"
    }
  }
],
});
