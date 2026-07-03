import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0060 T4 — 工具动作规则补 eligibility 溯源列 (tool_action_rules.exam_spec_version / risk_class)。
 *
 * T4 eligibility 建议（capability_tool_eligibility）要满足红线 11「陈旧即失效」，必须携带
 * examSpecVersion + riskClass 才能在「tool schema / riskClass 变化」时让建议失效。这两项的**真实来源**
 * 是「放行该规则的那份工具考试」+「学习期评定的风险类」——故回填进规则表（用户决策：回填 T3 规则表），
 * 由门控学习通道 ToolRuleLearningService 落表时写入，T4 projector 直接从规则读，全程真实可追溯。
 *
 * 字段决策：
 *   - exam_spec_version：放行规则的工具考试标识（examId::scorerVersion 复合），冻结考试的唯一版本；
 *   - risk_class：学习期评定的风险类（'high'|'low'）——红线 13：仅作 eligibility 溯源/失效判定的记录，
 *     **非**自动授权依据（授权仍由治理白名单 + ToolPermission 决定）；
 *   - 两列可空（sqlite ADD COLUMN NOT NULL 无 default + 回填非法；旧行无 provenance 留 NULL）；
 *     **新规则由 service 层强制非空**（门控通道保证 eligibility 溯源齐全）。
 *
 * Alias：SQLite v115 / Postgres v117（紧跟 v114 provenance / Postgres v116）。
 */
export const v115_tool_action_rule_eligibility_provenance: Migration = defineMigration({
  kind: 'schema',
  id: '115-tool-action-rule-eligibility-provenance',
  aliases: { postgres: 'v117', 'sqlite-sql': 'v115' },
  description: 'ADR-0060 T4: tool action rule eligibility provenance (exam_spec_version, risk_class) — 红线 11 陈旧失效溯源',
  operations: [
    {
      kind: 'add-column',
      table: 'tool_action_rules',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'exam_spec_version', type: 'text' },
    },
    {
      kind: 'add-column',
      table: 'tool_action_rules',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'risk_class', type: 'text' },
    },
  ],
});
