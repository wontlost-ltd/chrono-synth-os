import { defineMigration, type Migration } from '../../index.js';

export const v008_task_queue: Migration = defineMigration({
  kind: 'schema',
  id: 'task-queue',
  aliases: { postgres: 'v008', 'sqlite-sql': 'v008' },
  description: '异步任务队列',
  operations: [
    { kind: 'create-table', table: { name: 'tasks', ifNotExists: true, columns: [
      { name: 'id', type: 'text', primaryKey: true },
      { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
      { name: 'type', type: 'text', nullable: false },
      { name: 'payload', type: 'text', nullable: false, default: '{}' },
      { name: 'status', type: 'text', nullable: false, default: 'pending', check: "status IN ('pending', 'running', 'completed', 'failed')" },
      { name: 'result', type: 'text' },
      { name: 'error', type: 'text' },
      { name: 'retry_count', type: 'integer', nullable: false, default: 0 },
      { name: 'max_retries', type: 'integer', nullable: false, default: 3 },
      { name: 'created_at', type: 'bigint', nullable: false },
      { name: 'updated_at', type: 'bigint', nullable: false },
      { name: 'available_at', type: 'bigint', nullable: false },
    ] } },
    { kind: 'create-index', index: { name: 'idx_tasks_status_available', table: 'tasks', columns: ['status', 'available_at'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_tasks_tenant', table: 'tasks', columns: ['tenant_id'], ifNotExists: true } },
  ],
});
