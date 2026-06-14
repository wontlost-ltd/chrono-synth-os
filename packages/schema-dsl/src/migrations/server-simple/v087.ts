import { defineMigration, type Migration } from '../../index.js';

/**
 * 感知事件审计（ADR-0051 感知层 / 深化感知）— perception_events。
 *
 * 记录每次「让 TA 听/看一段」感知调用的**审计行为**，供用户回看「人格何时感知了什么」、合规
 * 导出/擦除、重放分析。**不存表征原文**（transcript 可能含 PII），只存内容哈希作 provenance +
 * 计数 + 元数据——故本表是「感知行为审计」，不含敏感内容。
 *
 * 字段决策：
 *   - id 主键；tenant_id 默认 'default'（多租户隔离 + GDPR）；persona_id；
 *   - modality（audio/video）；representation_sha256（表征内容哈希，去重/provenance，非原文）；
 *   - provider_name（mock-perception / llm-perception，审计用了哪个感官老师）；
 *   - memory_count（沉淀几条事实记忆）/ candidate_count（成长候选）/ pending_count（待审批身份提案）；
 *   - status（done/failed）；created_at 为 epoch ms（ADR-0029）。
 *
 * 含 tenant_id 且无敏感列 → 进 TenantDatabase 自动隔离 + privacy A 类标准导出/擦除。
 *
 * Alias：SQLite v087 / Postgres v089（紧跟 v086 perception_media_refs / Postgres v088）。
 */
export const v087_perception_events: Migration = defineMigration({
  kind: 'schema',
  id: '087-perception-events',
  aliases: { postgres: 'v089', 'sqlite-sql': 'v087' },
  description: 'Perception layer: perception event audit (hash + counts + metadata, no raw representation)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'perception_events',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false, default: 'default' },
          { name: 'modality', type: 'text', nullable: false },
          /* 表征内容哈希（provenance/去重）——不存原文（可能含 PII）。 */
          { name: 'representation_sha256', type: 'text', nullable: false },
          { name: 'provider_name', type: 'text', nullable: false },
          { name: 'memory_count', type: 'bigint', nullable: false, default: 0 },
          { name: 'candidate_count', type: 'bigint', nullable: false, default: 0 },
          { name: 'pending_count', type: 'bigint', nullable: false, default: 0 },
          { name: 'status', type: 'text', nullable: false, default: 'done' },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_perception_events_tenant',
        table: 'perception_events',
        columns: ['tenant_id', 'created_at'],
        ifNotExists: true,
      },
    },
  ],
});
