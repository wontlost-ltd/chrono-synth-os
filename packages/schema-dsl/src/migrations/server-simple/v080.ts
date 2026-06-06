import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0047 — 蒸馏工件持久化 (distilled_artifacts)。
 *
 * "LLM 作为可蒸馏的老师"：LLM 教学输出不直接写核心状态，先落为 candidate
 * 工件，经 schema 校验 → 闸门审批 → 编译 → 快照后才进入确定性内核。本表持久化
 * 该管线的全部工件，使自我修改可审计、可审批、可回滚、可重放。
 *
 * 字段决策：
 *   - kind/source/status 用 CHECK 约束锁定枚举，与 kernel 联合类型同源；
 *   - payload/evidence 存 JSON 文本（kernel 已有 schema validator 校验形状），
 *     SQLite 无原生 JSON 列、Postgres 也用 text 以保持双库渲染一致；
 *   - confidence 为 real[0,1]；
 *   - created_at/compiled_at 为 epoch ms（ADR-0029），compiled_at 可空；
 *   - persona_id + tenant_id 双维度索引，支持按数字人/租户查询候选；
 *   - status 索引支持"列出待审/已编译"治理查询。
 *
 * Alias：SQLite v080 / Postgres v082（紧跟 v079 / Postgres v081）。
 */
export const v080_distilled_artifacts: Migration = defineMigration({
  kind: 'schema',
  id: '080-distilled-artifacts',
  aliases: { postgres: 'v082', 'sqlite-sql': 'v080' },
  description: 'ADR-0047: persist distillation artifacts (gated LLM→core pipeline)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'distilled_artifacts',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          {
            name: 'kind', type: 'text', nullable: false,
            check: "kind IN ('rule', 'value_shift', 'memory_edge', 'decision_style_patch', 'cognitive_model_patch', 'response_template', 'narrative_patch')",
          },
          {
            name: 'source', type: 'text', nullable: false,
            check: "source IN ('reflection', 'conversation', 'knowledge_import', 'onboarding')",
          },
          { name: 'payload', type: 'text', nullable: false },
          { name: 'confidence', type: 'real', nullable: false, default: 0 },
          { name: 'evidence', type: 'text', nullable: false, default: '[]' },
          {
            name: 'status', type: 'text', nullable: false, default: 'candidate',
            check: "status IN ('candidate', 'approved', 'compiled', 'rejected', 'rolled_back')",
          },
          { name: 'reason', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'compiled_at', type: 'bigint' },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_distilled_artifacts_persona',
        table: 'distilled_artifacts',
        columns: ['tenant_id', 'persona_id'],
        ifNotExists: true,
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_distilled_artifacts_status',
        table: 'distilled_artifacts',
        columns: ['tenant_id', 'persona_id', 'status'],
        ifNotExists: true,
      },
    },
  ],
});
