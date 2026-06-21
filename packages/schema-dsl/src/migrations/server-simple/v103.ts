import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 B 链扩展：升级链（escalation chain）——下属阻塞时沿汇报链逐级上升求助。
 *
 * B1(结构化消息)/B2(handoff) 之上加**多级升级状态机**：某 worker 在某任务上阻塞 → 向其**直接上级**
 * 发起 escalation(pending) → 上级 resolve（给出处置）或 reescalate（再升给自己的上级，形成升级链）。
 * 根 worker（无上级）不能升级（顶层必须自行处置）。全确定性零-LLM。
 *
 *   - org_escalations：一次升级请求。subject task、from(阻塞者)、to(被升级到的上级)、parent(被哪条升级
 *     再升上来的，串成链)、状态机（pending/resolved/reescalated/cancelled）、原因/处置、关联键。
 *
 * 含 tenant_id → 自动隔离；GDPR A 类。Alias：SQLite v103 / Postgres v105（紧跟 v102 approvals / pg v104）。
 */
export const v103_org_escalations: Migration = defineMigration({
  kind: 'schema',
  id: '103-org-escalations',
  aliases: { postgres: 'v105', 'sqlite-sql': 'v103' },
  description: 'Digital workforce B-chain: multi-level escalation chain (blocked worker escalates up reporting line)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'org_escalations',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          /* 升级的任务。 */
          { name: 'task_id', type: 'text', nullable: false },
          /* 发起升级的数字员工（阻塞者/上一级未解者）。 */
          { name: 'from_worker_id', type: 'text', nullable: false },
          /* 被升级到的上级数字员工（from 的直接上级）。 */
          { name: 'to_worker_id', type: 'text', nullable: false },
          /* 父升级 id（被哪条升级 reescalate 上来的）：null=链首。串成升级链。 */
          { name: 'parent_escalation_id', type: 'text' },
          /* 升级层级（链首=0，每 reescalate 一次 +1）：可观测链深 + 防无限升级。 */
          { name: 'depth', type: 'integer', nullable: false, default: 0 },
          /* 状态机：pending/resolved/reescalated/cancelled。 */
          { name: 'status', type: 'text', nullable: false, default: 'pending' },
          /* 升级原因（阻塞描述，确定性记录）。 */
          { name: 'reason', type: 'text', nullable: false, default: '' },
          /* 处置说明（resolve 时填）。 */
          { name: 'resolution', type: 'text' },
          /* 关联键（保审计链：task/thread/handoff）。 */
          { name: 'correlation_id', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'decided_at', type: 'bigint' },
        ],
      },
    },
    { kind: 'create-index', index: { name: 'idx_escalations_task', table: 'org_escalations', columns: ['tenant_id', 'org_id', 'task_id'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_escalations_to', table: 'org_escalations', columns: ['tenant_id', 'org_id', 'to_worker_id', 'status'], ifNotExists: true } },
  ],
});
