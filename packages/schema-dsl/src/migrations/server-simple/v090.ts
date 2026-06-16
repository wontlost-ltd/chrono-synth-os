import { defineMigration, type Migration } from '../../index.js';

/**
 * per-persona 治理策略表（ADR-0048 / ADR-0047 治理可配化）。
 *
 * 把已建好但「默认关/默认宽松」的治理能力（categoryRoutes / AML 阈值 / 不确定性预算）做成
 * **每 persona 可配**——owner 经 API / 管理控制台为单个 persona 覆盖默认策略。
 *
 * 字段决策：
 *   - (tenant_id, persona_id) 复合主键：一 persona 一行（策略是当前生效配置，非审计资产，覆盖更新）；
 *   - policy_json：可覆盖策略字段的 JSON 文本（categoryRoutes / defaultCategoryRoute / maxAutonomousReward /
 *     dailyRewardExposureCap / maxConcurrentTasks / aml / 预算 等）。存 JSON 而非多列——策略形状会演进，
 *     单 blob 免去每加一个旋钮就改 schema；resolve 时按字段 merge over DEFAULT，缺字段沿用默认。
 *   - updated_by（审计谁改的）/ created_at / updated_at（epoch ms，ADR-0029）。
 *
 * 无 row → 调用方完全回退 DEFAULT_EARNING_POLICY（向后兼容，行为不变）。
 * 含 tenant_id 且无敏感列 → 进 TenantDatabase 自动隔离 + privacy A 类标准导出/擦除。
 *
 * Alias：SQLite v090 / Postgres v092（紧跟 v089 compiled_via / Postgres v091）。
 */
export const v090_persona_governance_policy: Migration = defineMigration({
  kind: 'schema',
  id: '090-persona-governance-policy',
  aliases: { postgres: 'v092', 'sqlite-sql': 'v090' },
  description: 'Governance config: per-persona earning/AML/budget policy override (JSON blob)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'persona_governance_policy',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          /* 可覆盖策略字段的 JSON 文本；resolve 时 merge over DEFAULT_EARNING_POLICY。 */
          { name: 'policy_json', type: 'text', nullable: false, default: '{}' },
          { name: 'updated_by', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'persona_id'] },
        ],
      },
    },
  ],
});
