import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 C1：协作记忆——解决「串味」（cross-contamination）。
 *
 * companion 的 relationship 表语义是「我↔**那一个用户**」per (tenant, persona)——单飞数字人对的。
 * 但组织内一个数字员工要面对**多个同事/团队/客户**：若复用 companion relationship，一个 worker 记住的
 * 「你是谁/聊过几次」会在不同对手方之间**串味**（把 Alice 的协作状态带给 Bob）。
 *
 * C1 新建**组织作用域**的协作记忆，按 (tenant, org, worker, counterpart) 分别记——每个对手方一行，
 * 互不污染。**完全独立于 companion_relationship**（两个外壳各用各的，ADR-0046）。
 *
 *   - worker_collaboration_memory：worker 对某 counterpart（worker/team/external）的协作历史
 *     （互动次数、第一次/最近协作时间、可选备注）。
 *
 * 含 tenant_id → 自动隔离；GDPR A 类。零-LLM（计数/时间确定性递增）。
 * Alias：SQLite v101 / Postgres v103（紧跟 v100 handoff / Postgres v102）。
 */
export const v101_worker_collaboration_memory: Migration = defineMigration({
  kind: 'schema',
  id: '101-worker-collaboration-memory',
  aliases: { postgres: 'v103', 'sqlite-sql': 'v101' },
  description: 'Digital workforce C1: per-counterpart collaboration memory (fixes cross-contamination)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'worker_collaboration_memory',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          /* 拥有这段记忆的数字员工。 */
          { name: 'worker_id', type: 'text', nullable: false },
          /* 对手方类型：worker（同事）/ team / external（客户/外部干系人）。 */
          { name: 'counterpart_type', type: 'text', nullable: false },
          /* 对手方标识（worker id / team id / 外部 id）。 */
          { name: 'counterpart_id', type: 'text', nullable: false },
          { name: 'interaction_count', type: 'integer', nullable: false, default: 0 },
          { name: 'first_collaborated_at', type: 'bigint' },
          { name: 'last_collaborated_at', type: 'bigint' },
          /* 可选协作备注（如「常一起处理退款」）。 */
          { name: 'note', type: 'text' },
        ],
        constraints: [
          /* 复合主键：一个 worker 对一个 counterpart 只一行（per-counterpart 隔离的核心，无串味）。 */
          { kind: 'primary-key', columns: ['tenant_id', 'org_id', 'worker_id', 'counterpart_type', 'counterpart_id'] },
        ],
      },
    },
    { kind: 'create-index', index: { name: 'idx_collab_worker', table: 'worker_collaboration_memory', columns: ['tenant_id', 'org_id', 'worker_id'], ifNotExists: true } },
  ],
});
