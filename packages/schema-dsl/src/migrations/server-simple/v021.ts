import { defineMigration, type Migration } from '../../index.js';

export const v021_migration: Migration = defineMigration({
  kind: 'schema',
  id: '021',
  aliases: { postgres: 'v021', 'sqlite-sql': 'v021' },
  description: "任务队列优先级支持",
  operations: [
  {
    kind: "add-column",
    table: "tasks",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "priority",
      type: "integer",
      nullable: false,
      default: 0
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tasks_priority_created",
      table: "tasks",
      columns: [
        "priority DESC",
        "created_at ASC"
      ],
      unique: false,
      ifNotExists: true,
      where: "status = 'pending'"
    }
  }
],
});
