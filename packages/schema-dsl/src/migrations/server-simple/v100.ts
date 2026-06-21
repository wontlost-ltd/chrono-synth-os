import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 B2：任务 handoff（交接/委派协商）——把一个任务的执行权从一个 worker 转给另一个。
 *
 * 真实组织里任务会交接（请假/专长不匹配/负载均衡）。handoff 是**有状态的协商**：proposed → accepted
 * / rejected / cancelled，而非直接改 assignee（保留协商痕迹 + 审计）。接受后才真正改任务执行者。
 *
 *   - org_handoffs：from/to worker，绑 task，reason，status（proposed/accepted/rejected/cancelled）。
 *
 * 含 tenant_id → 自动隔离；GDPR A 类。零-LLM（状态机确定性）。
 * Alias：SQLite v100 / Postgres v102（紧跟 v099 / Postgres v101）。
 */
export const v100_workforce_handoff: Migration = defineMigration({
  kind: 'schema',
  id: '100-workforce-handoff',
  aliases: { postgres: 'v102', 'sqlite-sql': 'v100' },
  description: 'Digital workforce B2: task handoff negotiation (proposed/accepted/rejected/cancelled)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'org_handoffs',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          { name: 'task_id', type: 'text', nullable: false },
          { name: 'from_worker_id', type: 'text', nullable: false },
          { name: 'to_worker_id', type: 'text', nullable: false },
          { name: 'reason', type: 'text', nullable: false, default: '' },
          /* proposed/accepted/rejected/cancelled */
          { name: 'status', type: 'text', nullable: false, default: 'proposed' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'responded_at', type: 'bigint' },
        ],
      },
    },
    { kind: 'create-index', index: { name: 'idx_handoffs_task', table: 'org_handoffs', columns: ['tenant_id', 'org_id', 'task_id'], ifNotExists: true } },
  ],
});
