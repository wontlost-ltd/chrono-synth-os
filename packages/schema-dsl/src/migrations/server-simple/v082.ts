import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0047 — 响应模板专用持久化 (response_templates)。
 *
 * response_template 蒸馏工件原先编译成 procedural memory，会衰减+被驱逐（「学了会忘」），
 * 违背蒸馏持久性。改落本专用表：不在 memory 衰减范围内 → 真正持久；版本化保留同 intent
 * 的多版本（蒸馏迭代留史），检索按 intent 取最高版本。
 *
 * 字段决策：
 *   - 复合主键 (tenant_id, persona_id, intent, version)：同一数字人同一意图按版本保留多行，
 *     不覆盖历史；
 *   - artifact_id 可空：溯源到编译来源的蒸馏工件，便于审计；非蒸馏直写时为 NULL；
 *   - created_at / updated_at 为 epoch ms（ADR-0029）；
 *   - 按 (tenant_id, persona_id, intent) 建索引，支撑「取某意图最新版本」的检索热路径。
 *
 * Alias：SQLite v082 / Postgres v084（紧跟 v081 persona_leases / Postgres v083）。
 */
export const v082_response_templates: Migration = defineMigration({
  kind: 'schema',
  id: '082-response-templates',
  aliases: { postgres: 'v084', 'sqlite-sql': 'v082' },
  description: 'ADR-0047: durable versioned response_templates (replaces decaying procedural memory)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'response_templates',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          { name: 'intent', type: 'text', nullable: false },
          { name: 'template', type: 'text', nullable: false },
          { name: 'version', type: 'integer', nullable: false, default: 1 },
          { name: 'artifact_id', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        /* 复合主键留史：同 (tenant, persona, intent) 按 version 多行并存。 */
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'persona_id', 'intent', 'version'] },
        ],
      },
    },
    {
      kind: 'create-index',
      /* 含 version：支撑「按 intent 取最高版本」(ORDER BY version DESC LIMIT 1) 走索引，
       * 而非全分组扫描。DSL 索引列无方向，但前缀 (tenant,persona,intent) + version 已足够
       * 让规划器用索引定位分组并有序扫描。 */
      index: {
        name: 'idx_response_templates_intent',
        table: 'response_templates',
        columns: ['tenant_id', 'persona_id', 'intent', 'version'],
        ifNotExists: true,
      },
    },
  ],
});
