import { defineMigration, type Migration } from '../../index.js';

export const v024_migration: Migration = defineMigration({
  kind: 'schema',
  id: '024',
  aliases: { postgres: 'v024', 'sqlite-sql': 'v024' },
  description: "任务队列 purge 和公平调度性能索引",
  operations: [
  {
    kind: "create-index",
    index: {
      name: "idx_tasks_status_updated",
      table: "tasks",
      columns: [
        "status",
        "updated_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tasks_tenant_status",
      table: "tasks",
      columns: [
        "tenant_id",
        "status"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
