import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0060 T1 — 工具动作规则持久化 (tool_action_rules)。
 *
 * 「运行时零-LLM 据确定性规则构造工具调用」的规则表。一条规则 = 某 persona 学会某 capability 后，对某
 * tool 的某 schemaVersion，如何从任务字段确定性构造 arguments（argMappings DSL）。规则由学习/编译期
 * （T2/T3）产出并入表；运行时 ToolActionCompiler 查表据规则构造 ToolCallPlan（无规则/冲突/过期 → fail-closed）。
 *
 * 字段决策（ADR-0060 红线 9 元数据齐全）：
 *   - (tenant_id, persona_id) per-persona 隔离（红线 7）；
 *   - tool_id / capability / schema_version 定位规则应用场景；schema_version 与 tool 当前 inputSchema 不符 →
 *     运行时 fail-closed（规则失效）；
 *   - rule_version / content_hash 防篡改 + 假变更去重（content_hash = 规范化 DSL 的哈希，由宿主编译期算）；
 *   - active + 唯一约束：同 (tenant, persona, tool, capability, schema_version) 只能一个 active 规则（红线 10
 *     冲突 fail-closed 的存储侧保障——部分唯一索引，仅约束 active=1 的行）；
 *   - arg_mappings 存 JSON 文本（受限确定性 DSL，kernel 有类型 + 编译期 lint 校验形状）；
 *   - expires_at 可空（过期规则运行时 fail-closed）；created_at epoch ms（ADR-0029）。
 *
 * Alias：SQLite v113 / Postgres v115（紧跟 v112 双边工单市场 / Postgres v114）。
 */
export const v113_tool_action_rules: Migration = defineMigration({
  kind: 'schema',
  id: '113-tool-action-rules',
  aliases: { postgres: 'v115', 'sqlite-sql': 'v113' },
  description: 'ADR-0060 T1: deterministic tool action rules (runtime zero-LLM argument construction)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'tool_action_rules',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          { name: 'tool_id', type: 'text', nullable: false },
          { name: 'capability', type: 'text', nullable: false },
          { name: 'schema_version', type: 'text', nullable: false },
          { name: 'rule_version', type: 'text', nullable: false },
          { name: 'content_hash', type: 'text', nullable: false },
          { name: 'arg_mappings', type: 'text', nullable: false },
          { name: 'created_by', type: 'text', nullable: false },
          { name: 'compiled_at', type: 'bigint', nullable: false },
          { name: 'expires_at', type: 'bigint' },
          { name: 'active', type: 'integer', nullable: false, default: 1 },
        ],
      },
    },
    {
      /* 查询索引：运行时按 (tenant, persona, tool, capability) 取候选规则集。 */
      kind: 'create-index',
      index: {
        name: 'idx_tool_action_rules_lookup',
        table: 'tool_action_rules',
        columns: ['tenant_id', 'persona_id', 'tool_id', 'capability'],
        ifNotExists: true,
      },
    },
    {
      /* 唯一约束（红线 10 存储侧）：同 (tenant, persona, tool, capability, schema_version) 的 **active** 规则
       * 至多一条。部分唯一索引（仅 active=1 的行受约束，历史 inactive 版本可共存）。 */
      kind: 'create-index',
      index: {
        name: 'uq_tool_action_rules_active',
        table: 'tool_action_rules',
        columns: ['tenant_id', 'persona_id', 'tool_id', 'capability', 'schema_version'],
        unique: true,
        where: 'active = 1',
        ifNotExists: true,
      },
    },
  ],
});
