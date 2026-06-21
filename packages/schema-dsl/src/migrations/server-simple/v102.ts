import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 D2：执行审批门（ADR-0055）——高风险动作必须人类批准，无审批不执行。
 *
 * 数字员工要真实执行（D3 接 ToolInvocationPipeline）前，按**有效风险**走审批：
 *   - low：无需审批；
 *   - medium：组织内审批（上级数字员工 或 人类，默认人类）；
 *   - high/不可逆/对外/敏感/资金：**必须人类审批**（上级 persona 批准不充分）。
 *
 *   - org_approvals：一次审批请求。subject（task/tool_invocation）、requester worker、有效风险、
 *     状态机（pending/approved/rejected/expired）、approver 是 worker 还是人类 user、理由、关联键。
 *
 * 含 tenant_id → 自动隔离；GDPR A 类。审批决策确定性零-LLM（风险/路由是规则）。
 * Alias：SQLite v102 / Postgres v104（紧跟 v101 collaboration memory / Postgres v103）。
 */
export const v102_org_approvals: Migration = defineMigration({
  kind: 'schema',
  id: '102-org-approvals',
  aliases: { postgres: 'v104', 'sqlite-sql': 'v102' },
  description: 'Digital workforce D2: execution approval gate (ADR-0055 risk-tiered, human-required for high)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'org_approvals',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          /* 审批对象类型：task_execution / tool_invocation。 */
          { name: 'subject_type', type: 'text', nullable: false },
          /* 审批对象 id（task id / 预期 tool action hash）。 */
          { name: 'subject_id', type: 'text', nullable: false },
          /* 发起执行的数字员工。 */
          { name: 'requester_worker_id', type: 'text', nullable: false },
          /* 有效风险（确定性计算，铁律1 只升不降）：low/medium/high。 */
          { name: 'effective_risk', type: 'text', nullable: false },
          /* 是否要求人类审批（high 或敏感/对外/资金/不可逆 → true，上级 persona 批准不充分）。 */
          { name: 'requires_human', type: 'integer', nullable: false, default: 0 },
          /* 审批模式（路由结果持久化，防绕过）：human_only / org_or_human。medium+policy关=human_only。 */
          { name: 'approval_mode', type: 'text', nullable: false, default: 'human_only' },
          /* 状态机：pending/approved/rejected/expired。 */
          { name: 'status', type: 'text', nullable: false, default: 'pending' },
          /* 批准者：worker id（上级数字员工，仅 medium 且非 requires_human）。 */
          { name: 'approver_worker_id', type: 'text' },
          /* 批准者：人类 user id（高风险/默认）。 */
          { name: 'approver_user_id', type: 'text' },
          { name: 'reason', type: 'text', nullable: false, default: '' },
          /* 关联键（保审计链：task/handoff/tool invocation）。 */
          { name: 'correlation_id', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
          /* 过期时间（pending 超过则 expired，不放行）。 */
          { name: 'expires_at', type: 'bigint' },
          { name: 'decided_at', type: 'bigint' },
        ],
      },
    },
    { kind: 'create-index', index: { name: 'idx_approvals_subject', table: 'org_approvals', columns: ['tenant_id', 'org_id', 'subject_type', 'subject_id'], ifNotExists: true } },
  ],
});
