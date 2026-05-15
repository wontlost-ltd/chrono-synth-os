import { defineMigration, type Migration } from '../../index.js';

export const v019_migration: Migration = defineMigration({
  kind: 'schema',
  id: '019',
  aliases: { postgres: 'v019', 'sqlite-sql': 'v019' },
  description: "任务队列安全 — 工作者领取标记",
  operations: [
  {
    kind: "add-column",
    table: "tasks",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "claimed_by",
      type: "text"
    }
  },
  {
    kind: "add-column",
    table: "tasks",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "claimed_at",
      type: "bigint"
    }
  }
],
});
