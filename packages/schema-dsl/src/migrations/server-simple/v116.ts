import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0060 T4 — 能力→工具授权资格投影 (capability_tool_eligibility)。
 *
 * capability-learned 事件的新订阅者 ToolEligibilityProjector 产出的**授权建议**投影：标记「该 persona 学会
 * 某 capability 后，对某已过工具考试的 tool，*建议*可授权（含 constraints 指纹）」——**只建议，不 grant**
 * （红线 2/12：capability≠permission，eligibility≠allow；授权仍由 ToolPermission/AgencyAuthorization 决定，
 * 本表任何执行门/授权服务**绝不当 allow 条件读取**，只驱动建议/待审批请求）。
 *
 * 字段决策（红线 11 陈旧即失效元数据齐全）：
 *   - (tenant_id, persona_id) per-persona 隔离（红线 7）；缺 tenantId 事件直接 drop 不入表；
 *   - capability / tool_id 定位建议维度；
 *   - schema_version / source_rule_version / exam_spec_version / risk_class / constraints_hash：溯源 + 失效判定
 *     依据——tool schema 变化（schema_version 不符）/ riskClass 变化 / 规则版本变化 → 建议失效，不得用于自动授权；
 *   - recommended_at epoch ms（ADR-0029）；expires_at 可空（过期建议失效 fail-closed）；
 *   - active + 部分唯一索引：同 (tenant, persona, capability, tool_id) 只一个 active 建议（新建议替换旧）。
 *
 * Alias：SQLite v116 / Postgres v118（紧跟 v115 规则溯源列 / Postgres v117）。
 */
export const v116_capability_tool_eligibility: Migration = defineMigration({
  kind: 'schema',
  id: '116-capability-tool-eligibility',
  aliases: { postgres: 'v118', 'sqlite-sql': 'v116' },
  description: 'ADR-0060 T4: capability→tool eligibility recommendations (recommendation only, never grant; 红线 11 staleness metadata)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'capability_tool_eligibility',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          { name: 'capability', type: 'text', nullable: false },
          { name: 'tool_id', type: 'text', nullable: false },
          { name: 'schema_version', type: 'text', nullable: false },
          { name: 'source_rule_version', type: 'text', nullable: false },
          { name: 'exam_spec_version', type: 'text', nullable: false },
          { name: 'risk_class', type: 'text', nullable: false },
          { name: 'constraints_hash', type: 'text', nullable: false },
          { name: 'recommended_at', type: 'bigint', nullable: false },
          { name: 'expires_at', type: 'bigint' },
          { name: 'active', type: 'integer', nullable: false, default: 1 },
        ],
      },
    },
    {
      /* 查询索引：按 (tenant, persona) 取某 persona 的全部 eligibility 建议。 */
      kind: 'create-index',
      index: {
        name: 'idx_capability_tool_eligibility_lookup',
        table: 'capability_tool_eligibility',
        columns: ['tenant_id', 'persona_id'],
        ifNotExists: true,
      },
    },
    {
      /* 部分唯一索引：同 (tenant, persona, capability, tool_id) 的 **active** 建议至多一条
       * （新建议替换旧，历史 inactive 留档供审计）。 */
      kind: 'create-index',
      index: {
        name: 'uq_capability_tool_eligibility_active',
        table: 'capability_tool_eligibility',
        columns: ['tenant_id', 'persona_id', 'capability', 'tool_id'],
        unique: true,
        where: 'active = 1',
        ifNotExists: true,
      },
    },
  ],
});
