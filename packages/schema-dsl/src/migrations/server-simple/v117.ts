import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0060 T5 — 工具授权待审批请求 (tool_authorization_requests)。
 *
 * T5 自动授权桥消费有效 eligibility 建议：白名单低风险工具 → 直接自动授予 ToolPermission；**其余**（不在治理
 * 白名单 / 高风险）→ **不自动授权**，只自动创建一条**待审批请求**（红线 3：高风险/外部副作用工具自动授权一律
 * 禁止，只能自动创建待审批请求，由人工/治理决定）。本表即该请求队列。
 *
 * 字段决策：
 *   - (tenant_id, persona_id) per-persona 隔离（红线 7）；
 *   - tool_id / capability / source_rule_version / risk_class：请求来源溯源；
 *   - reason：为何进待审批（如 'not_whitelisted' / 'high_risk'）——供审批人判断；
 *   - status：pending / approved / rejected（人工/治理决议后转移；approved 不等于已授权，仍走既有 grant 路径）；
 *   - requested_at epoch ms（ADR-0029）；decided_at / decided_by 决议留痕；
 *   - 部分唯一索引：同 (tenant, persona, capability, tool_id) 只一个 pending 请求（防重复堆积）。
 *
 * Alias：SQLite v117 / Postgres v119（紧跟 v116 eligibility 表 / Postgres v118）。
 */
export const v117_tool_authorization_requests: Migration = defineMigration({
  kind: 'schema',
  id: '117-tool-authorization-requests',
  aliases: { postgres: 'v119', 'sqlite-sql': 'v117' },
  description: 'ADR-0060 T5: pending tool authorization requests (non-whitelisted / high-risk eligibility → manual approval, never auto-grant)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'tool_authorization_requests',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          { name: 'capability', type: 'text', nullable: false },
          { name: 'tool_id', type: 'text', nullable: false },
          { name: 'source_rule_version', type: 'text', nullable: false },
          { name: 'risk_class', type: 'text', nullable: false },
          { name: 'reason', type: 'text', nullable: false },
          { name: 'status', type: 'text', nullable: false, default: 'pending' },
          { name: 'requested_at', type: 'bigint', nullable: false },
          { name: 'decided_at', type: 'bigint' },
          { name: 'decided_by', type: 'text' },
        ],
      },
    },
    {
      /* 查询索引：按 (tenant, persona, status) 取某 persona 的待审批请求。 */
      kind: 'create-index',
      index: {
        name: 'idx_tool_authorization_requests_lookup',
        table: 'tool_authorization_requests',
        columns: ['tenant_id', 'persona_id', 'status'],
        ifNotExists: true,
      },
    },
    {
      /* 部分唯一索引：同 (tenant, persona, capability, tool_id) 只一个 pending 请求（防桥重复投递堆积）。 */
      kind: 'create-index',
      index: {
        name: 'uq_tool_authorization_requests_pending',
        table: 'tool_authorization_requests',
        columns: ['tenant_id', 'persona_id', 'capability', 'tool_id'],
        unique: true,
        where: "status = 'pending'",
        ifNotExists: true,
      },
    },
  ],
});
