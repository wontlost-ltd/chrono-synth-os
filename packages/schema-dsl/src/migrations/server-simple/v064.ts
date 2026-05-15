import { defineMigration, type Migration } from '../../index.js';

export const v064_migration: Migration = defineMigration({
  kind: 'schema',
  id: '064',
  aliases: { postgres: 'v064', 'sqlite-sql': 'v064' },
  description: "P1-B job 元数据：模板联动统计",
  operations: [
  {
    kind: "add-column",
    table: "bulk_knowledge_import_jobs",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "metadata_json",
      type: "text",
      nullable: false,
      default: "{}"
    }
  }
],
});
