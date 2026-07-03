import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0060 T3 — 工具动作规则来源追溯 (tool_action_rules.source_artifact_id)。
 *
 * 红线 6（T3 实现复审修订）：映射规则**不得**由任意调用方直灌规则表，必须经等价蒸馏门控纪律
 * （lint → 工具考试验收 → 过考才落表）产出，且每条落表规则**必须携带 provenance** 指向其上游蒸馏
 * 产物，来源可审计。本列即该 provenance——由门控学习通道 ToolRuleLearningService 落表时写入。
 *
 * 字段决策：
 *   - 列可空（sqlite ADD COLUMN 不允许 NOT NULL 无 default + 有行回填）；T1 刚建表本无生产数据，
 *     旧行（若有）留 NULL；**新规则由 service 层强制非空**（门控通道保证 provenance 齐全）。
 *
 * Alias：SQLite v114 / Postgres v116（紧跟 v113 工具动作规则表 / Postgres v115）。
 */
export const v114_tool_action_rule_provenance: Migration = defineMigration({
  kind: 'schema',
  id: '114-tool-action-rule-provenance',
  aliases: { postgres: 'v116', 'sqlite-sql': 'v114' },
  description: 'ADR-0060 T3: tool action rule provenance (source_artifact_id) — 红线 6 来源可追溯',
  operations: [
    {
      kind: 'add-column',
      table: 'tool_action_rules',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'source_artifact_id', type: 'text' },
    },
  ],
});
