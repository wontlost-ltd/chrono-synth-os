import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工按职能进修 L2（ADR-0057）——学习请求账本 learning_requests。
 *
 * 缺口检测（L1 GapDetector）发现「这个数字员工干这任务缺能力 X」→ 登记一条学习请求。账本职责：
 *   - **幂等去重**：同 (tenant, persona, capability) 的 active 学习请求**唯一**（多个挂起任务共享一次学习，
 *     防请教风暴——ADR-0057 红线 9/D0.8）。**DB 级部分唯一索引** (tenant_id, persona_id, capability)
 *     WHERE status IN ('pending','learning') 兜底并发（应用层 findActive 先查 + DB 唯一约束防并发双插，
 *     冲突方 catch-and-refetch 返回 deduped）。**幂等是 persona-global**（不含 org_id）——能力属于 persona，
 *     与哪个 org 任务暴露它无关（红线 8 (tenant, persona)；org_id 仅审计元数据，Codex L2 复审）。
 *   - **审计**：evidence（确定性证据，非 LLM）、触发任务、优先级、状态机、时间。
 *   - **unknown 标记**（Codex L1 复审）：能力是否在 KNOWN_CAPABILITIES 词表内——typo（如 'reserch'）标 is_unknown=1，
 *     便于人工归并，GapDetector 不自动猜。
 *
 * 状态机：pending（待学）→ learning（学习中）→ passed（≥95 学会，落主内核）/ failed（验收连续不过/退回）/
 *   cancelled（任务取消/超时）。capability-learned 唤醒据 passed 派生（L8）。
 *
 * 含 tenant_id → TenantDatabase 自动隔离；GDPR A 类；per-persona（persona_id 列）。零-LLM（缺口/证据确定性）。
 * Alias：SQLite v108 / Postgres v110（紧跟 K2 sqlite v107 / pg v109）。
 */
export const v108_learning_requests: Migration = defineMigration({
  kind: 'schema',
  id: '108-learning-requests',
  aliases: { postgres: 'v110', 'sqlite-sql': 'v108' },
  description: 'Job-function learning L2 (ADR-0057): learning_requests ledger (gap → request, idempotent per (persona,capability))',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'learning_requests',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          /* 哪个数字员工要学（per-persona 隔离键）。 */
          { name: 'persona_id', type: 'text', nullable: false },
          /* 缺的能力（已规范化，normalizeCapability 形态）。 */
          { name: 'capability', type: 'text', nullable: false },
          /* 是否未知能力（不在 KNOWN_CAPABILITIES 词表——可能 typo，标记供人工归并）。 */
          { name: 'is_unknown', type: 'integer', nullable: false, default: 0 },
          /* 确定性证据（哪个任务暴露了缺口，非 LLM 生成）。 */
          { name: 'evidence', type: 'text', nullable: false, default: '' },
          /* 优先级：low/medium/high（由任务风险/SLA 确定性派生）。 */
          { name: 'priority', type: 'text', nullable: false, default: 'medium' },
          /* 触发缺口的任务 id（审计链）。 */
          { name: 'triggered_by_task_id', type: 'text' },
          /* 状态机：pending/learning/passed/failed/cancelled。 */
          { name: 'status', type: 'text', nullable: false, default: 'pending' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    /* 幂等 DB 兜底：active(pending/learning) 的 (tenant, persona, capability) **部分唯一**——并发双插被 DB 挡，
     * 防请教风暴（红线 9）。persona-global（不含 org_id）：能力属于 persona。 */
    { kind: 'create-index', index: { name: 'uq_learning_req_active_persona_cap', table: 'learning_requests', columns: ['tenant_id', 'persona_id', 'capability'], unique: true, ifNotExists: true, where: "status IN ('pending', 'learning')" } },
    /* 查询索引：按 (tenant, persona, status) 列已学/进行中（listPassedCapabilities 等）。 */
    { kind: 'create-index', index: { name: 'idx_learning_req_persona_status', table: 'learning_requests', columns: ['tenant_id', 'persona_id', 'status'], ifNotExists: true } },
    /* 按 org 列出学习请求（治理/审计）。 */
    { kind: 'create-index', index: { name: 'idx_learning_req_org', table: 'learning_requests', columns: ['tenant_id', 'org_id', 'status'], ifNotExists: true } },
  ],
});
