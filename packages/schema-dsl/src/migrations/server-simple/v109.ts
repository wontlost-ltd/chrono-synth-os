import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工按职能进修 L7（ADR-0057）——能力索引 capability_index。
 *
 * 把「该 persona 学会了哪些能力」从 L2 账本的 `status='passed'` 扫描**正式化**为一个薄元数据层：
 * 由 L6 的 capability-learned 事件投影写入（CapabilityIndexProjector 订阅），是 GapDetector 算缺口差集的
 * 正式「已学」来源（替换 L2 时代的 listPassedCapabilities）。
 *
 * 职责：
 *   - **可查覆盖**：(tenant, persona, capability) **唯一**——一项能力一行，O(索引) 查「学没学过」，
 *     替代对 learning_requests 全表 status 扫描。
 *   - **审计链**：learning_request_id 回指 L2 账本条目（习得出处）；exam_score（验收 coverage）+ learned_at。
 *   - **能力版本**：capability_version 供后续能力词表/验收口径升级时区分（默认 1）。
 *
 * 投影语义（fail-safe）：索引只在 capability-learned（L6 真落核后）写——index 说「学过」必真学过。
 * 投影失败/滞后只会让 GapDetector 误判「没学过」而重登记（L2 active 幂等防洪，安全方向）；L2 passed 行保留
 * 作持久审计 + 回填兜底来源。
 *
 * 含 tenant_id → TenantDatabase 自动隔离；GDPR A 类；per-persona（persona_id 列）。零-LLM（事件投影确定性）。
 * Alias：SQLite v109 / Postgres v111（紧跟 L2 sqlite v108 / pg v110）。
 */
export const v109_capability_index: Migration = defineMigration({
  kind: 'schema',
  id: '109-capability-index',
  aliases: { postgres: 'v111', 'sqlite-sql': 'v109' },
  description: 'Job-function learning L7 (ADR-0057): capability_index — formal learned-capabilities source (replaces L2 listPassedCapabilities scan)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'capability_index',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          /* 哪个数字员工（per-persona 隔离键）。 */
          { name: 'persona_id', type: 'text', nullable: false },
          /* 学会的能力（已规范化，normalizeCapability 形态）。 */
          { name: 'capability', type: 'text', nullable: false },
          /* 验收得分（影子验收 coverage，≥0.95）。 */
          { name: 'exam_score', type: 'real', nullable: false },
          /* 习得出处：L2 账本条目 id（审计链回指）。 */
          { name: 'learning_request_id', type: 'text', nullable: false, default: '' },
          /* 能力词表/验收口径版本（后续升级区分；默认 1）。 */
          { name: 'capability_version', type: 'integer', nullable: false, default: 1 },
          { name: 'learned_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    /* 可查覆盖 + 投影幂等兜底：一项能力一行（同 persona 重学=更新非新增）。 */
    { kind: 'create-index', index: { name: 'uq_capability_index_persona_cap', table: 'capability_index', columns: ['tenant_id', 'persona_id', 'capability'], unique: true, ifNotExists: true } },
    /* 时序审计：按 persona 最近习得列出。 */
    { kind: 'create-index', index: { name: 'idx_capability_index_persona_learned', table: 'capability_index', columns: ['tenant_id', 'persona_id', 'learned_at'], ifNotExists: true } },
  ],
});
