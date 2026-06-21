import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 C 链：任务 SLA 截止时间——给 org_tasks 加 due_at（可空 bigint 时间戳）。
 *
 * worker 的 enterprise 类人化「时间感知」（C0 运营信号扩展）需要任务有截止时间：据 now 与 due_at
 * 确定性派生 overdue（已逾期）/ due_soon（临近）/ on_track，让管理者知道哪个 worker 有逾期/临期任务。
 * 这是 SLA 信号（B 端运营），不是「心情」；纯确定性、零-LLM（now vs due_at 比较）。
 *
 * due_at 可空：旧任务/无截止的任务 due_at=NULL → 不计入 SLA（既不逾期也不临期）。
 * Alias：SQLite v104 / Postgres v106（紧跟 v103 escalations / pg v105）。
 */
export const v104_org_tasks_due_at: Migration = defineMigration({
  kind: 'schema',
  id: '104-org-tasks-due-at',
  aliases: { postgres: 'v106', 'sqlite-sql': 'v104' },
  description: 'Digital workforce C-chain: org_tasks.due_at (task SLA deadline for temporal awareness signal)',
  operations: [
    { kind: 'add-column', table: 'org_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'due_at', type: 'bigint' } },
  ],
});
