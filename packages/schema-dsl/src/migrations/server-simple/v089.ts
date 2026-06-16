import { defineMigration, type Migration } from '../../index.js';

/**
 * distilled_artifacts 加 compiled_via 列（ADR-0047 成长治理 / 不确定性预算）。
 *
 * 不确定性预算只该统计**自动编译（未验证）**的成长——人工审批后编译的已验证，不该消耗未验证额度。
 * 原表只有 status（compiled 无法区分 auto vs approved），故加 compiled_via 列精确区分：
 *   - 'auto'：过门自动编译（未经人工，算未验证成长，进预算统计）；
 *   - 'approved'：人工审批后编译（已验证，不进预算）；
 *   - NULL：未编译 / 历史行（编译前的工件，或迁移前已存在的行）。
 *
 * 可空 + 无默认：历史 compiled 行 compiled_via 为 NULL，预算统计把 NULL 视为「非 auto」不计入
 * （保守且向后兼容——旧自动编译行不会被回溯算进预算，新行才精确计）。
 *
 * Alias：SQLite v089 / Postgres v091（紧跟 v088 distilled perception-source / Postgres v090）。
 */
export const v089_distilled_compiled_via: Migration = defineMigration({
  kind: 'schema',
  id: '089-distilled-compiled-via',
  aliases: { postgres: 'v091', 'sqlite-sql': 'v089' },
  description: 'Growth governance: distilled_artifacts.compiled_via (auto vs approved) for unverified-growth budget',
  operations: [
    {
      kind: 'add-column',
      table: 'distilled_artifacts',
      column: { name: 'compiled_via', type: 'text' },
    },
  ],
});
