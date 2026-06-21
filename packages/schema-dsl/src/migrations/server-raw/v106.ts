import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * K1（ADR-0056）每-(租户, 人格) 认知内核隔离·数据模型扩维——认知核心状态表加 persona_id。
 *
 * 认知核心当前**每租户单个人格**（核心状态表全按 tenant_id 单键）。要支撑「一个组织里多个不同认知
 * 人格的数字员工」，认知核心身份从 tenantId 扩成 (tenantId, personaId)。本片（K1）只做**最纯加性的一步**：
 * 给 7 张认知核心表**加 persona_id 列**（default 'default'，回填现有行）+ 扩复合索引。
 *
 * **关键设计取舍（向后兼容铁律，ADR-0056 红线 2）**：本片**不改主键/唯一约束**。原因——单例核心表
 * （decision_style/cognitive_model/narrative）当前 executor 用 `ON CONFLICT(tenant_id)` upsert，若 K1 就把
 * 主键改成 (tenant_id, persona_id)，`ON CONFLICT(tenant_id)` 会找不到匹配唯一约束而**运行时报错**——
 * 破坏现有 companion/manager-persona 路径。故**主键/唯一约束改 (tenant_id, persona_id) 与 executor 改
 * `ON CONFLICT(tenant_id, persona_id)` 必须在 K2 原子一起落**（同一片改 schema 约束 + 服务 SQL），不能拆。
 * K1 只加列 + 复合索引（列存在、默认 default、暂不被查询使用），完全向后兼容，旧测试全过。
 *
 * 隔离边界（ADR-0056 D0.2）覆盖 7 张认知核心表，全部 ADD COLUMN persona_id：
 *   decision_style / cognitive_model / narrative / core_values / survival_anchors / memory_nodes / memory_edges。
 *
 * 手法与 v007_tenant_id 的 ADD COLUMN 部分同款：PG `ADD COLUMN IF NOT EXISTS`；SQLite safe-add-column 注释式。
 * 复合索引 (tenant_id, persona_id) 供 K2 按 persona 查；旧 tenant 单列索引保留。
 *
 * 红线（ADR-0056 红线 1/2/3）：零-LLM 不变；**完全向后兼容**（只加列不改约束）；本片未产生非 default 数据，
 * 回滚安全（K4 起 seed 多 persona 后回滚受限）。
 *
 * Alias：SQLite v106 / Postgres v108（紧跟 server-simple v105 playbook_version / Postgres v107）。
 */
export const v106_persona_id_core_isolation: RawMigration = defineRaw({
  id: 'persona-id-core-isolation',
  version: 'v106',
  aliases: { postgres: 'v108', 'sqlite-sql': 'v106' },
  description: 'K1 ADR-0056: per-(tenant, persona) cognitive core isolation — add persona_id to core state tables',
  reason: '纯加性：7 张认知核心表 ADD COLUMN persona_id(default default) + 复合索引；不改主键(向后兼容,主键改与 executor 改 K2 原子落)',
  postgres: rawSql([
    /* 7 张认知核心表加 persona_id 列（默认 default，回填现有行）。**不改主键/唯一约束**（K2 与 executor 原子改）。 */
    `ALTER TABLE decision_style ADD COLUMN IF NOT EXISTS persona_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE cognitive_model ADD COLUMN IF NOT EXISTS persona_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE narrative ADD COLUMN IF NOT EXISTS persona_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE core_values ADD COLUMN IF NOT EXISTS persona_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE survival_anchors ADD COLUMN IF NOT EXISTS persona_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS persona_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE memory_edges ADD COLUMN IF NOT EXISTS persona_id TEXT NOT NULL DEFAULT 'default'`,
    /* 复合索引 (tenant_id, persona_id) 供 K2 按 persona 查；旧 tenant 单列索引保留（不删，向后兼容查询）。 */
    `CREATE INDEX IF NOT EXISTS idx_core_values_tenant_persona ON core_values(tenant_id, persona_id)`,
    `CREATE INDEX IF NOT EXISTS idx_survival_anchors_tenant_persona ON survival_anchors(tenant_id, persona_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant_persona ON memory_nodes(tenant_id, persona_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_edges_tenant_persona ON memory_edges(tenant_id, persona_id)`,
  ]),
  sqlite: rawSql([
    /* 7 张认知核心表 safe add-column（与 v007 同款 safe-add-column 注释式，幂等）。不重建表、不改主键。 */
    `/* safe:add-column:decision_style:persona_id */ ALTER TABLE decision_style ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:cognitive_model:persona_id */ ALTER TABLE cognitive_model ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:narrative:persona_id */ ALTER TABLE narrative ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:core_values:persona_id */ ALTER TABLE core_values ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:survival_anchors:persona_id */ ALTER TABLE survival_anchors ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:memory_nodes:persona_id */ ALTER TABLE memory_nodes ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:memory_edges:persona_id */ ALTER TABLE memory_edges ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'default'`,
    /* 复合索引供 K2 按 persona 查（旧 tenant 单列索引保留）。safe:if-table-exists 守卫——某些迁移路径
     * （如 legacy 部分预建 schema）下核心表可能尚未由前序迁移建出，索引只在表存在时建。 */
    `/* safe:if-table-exists:core_values */ CREATE INDEX IF NOT EXISTS idx_core_values_tenant_persona ON core_values(tenant_id, persona_id)`,
    `/* safe:if-table-exists:survival_anchors */ CREATE INDEX IF NOT EXISTS idx_survival_anchors_tenant_persona ON survival_anchors(tenant_id, persona_id)`,
    `/* safe:if-table-exists:memory_nodes */ CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant_persona ON memory_nodes(tenant_id, persona_id)`,
    `/* safe:if-table-exists:memory_edges */ CREATE INDEX IF NOT EXISTS idx_memory_edges_tenant_persona ON memory_edges(tenant_id, persona_id)`,
  ]),
});
