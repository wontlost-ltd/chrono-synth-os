import { defineRaw } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * 感知蒸馏血缘独立化：distilled_artifacts.source 增加 'perception' 枚举。
 *
 * ADR-0051 Phase 1 感知蒸馏候选**暂复用** 'knowledge_import' 作 source（见 perception-distiller
 * 文件头与 distilled-artifact-types 注释）——这模糊了血缘：知识摄入与外部感知是两类不同的成长
 * 活动，溯源/审计时无法区分一条蒸馏候选是「读了篇文档」还是「听了段经历」。本迁移给 source
 * CHECK 加上独立的 'perception'，让感知蒸馏产物有自己的血缘标签。
 *
 * SQLite 无法 ALTER CHECK，需重建表（rename→新表带新 CHECK→INSERT SELECT→drop 旧→保索引）；
 * Postgres 直接 DROP/ADD CONSTRAINT。与 v030_check_rewrite 同款手法。
 *
 * 数据迁移：旧的感知候选（曾以 'knowledge_import' 落库）**不回填**为 'perception'——无法可靠区分
 * 哪些 knowledge_import 行源自感知（provenance 信息当时没存），强行猜测会污染血缘。新迁移只放开
 * 枚举，新写入的感知候选用 'perception'；历史 knowledge_import 保持原样（语义：迁移前的候选血缘未分）。
 *
 * Alias：SQLite v088 / Postgres v090（紧跟 v087 perception_events / Postgres v089）。
 */
export const v088_distilled_artifacts_perception_source: RawMigration = defineRaw({
  id: 'distilled-artifacts-perception-source',
  version: 'v088',
  aliases: { postgres: 'v090', 'sqlite-sql': 'v088' },
  description: 'Perception: add perception source to distilled_artifacts CHECK',
  reason: 'SQLite 重建表更新 source CHECK（+perception）；PG drop/add CHECK 约束',
  postgres: {
    sql: [
      `ALTER TABLE distilled_artifacts DROP CONSTRAINT IF EXISTS distilled_artifacts_source_check`,
      `ALTER TABLE distilled_artifacts ADD CONSTRAINT distilled_artifacts_source_check CHECK (source IN ('reflection', 'conversation', 'knowledge_import', 'onboarding', 'perception'))`,
    ],
  },
  sqlite: {
    sql: [
      `CREATE TABLE IF NOT EXISTS distilled_artifacts_new (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        persona_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('rule', 'value_shift', 'memory_edge', 'decision_style_patch', 'cognitive_model_patch', 'response_template', 'narrative_patch')),
        source TEXT NOT NULL CHECK(source IN ('reflection', 'conversation', 'knowledge_import', 'onboarding', 'perception')),
        payload TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        evidence TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'approved', 'compiled', 'rejected', 'rolled_back')),
        reason TEXT,
        created_at INTEGER NOT NULL,
        compiled_at INTEGER
      )`,
      `INSERT OR IGNORE INTO distilled_artifacts_new
       SELECT id, tenant_id, persona_id, kind, source, payload, confidence, evidence, status, reason, created_at, compiled_at
       FROM distilled_artifacts`,
      `DROP TABLE IF EXISTS distilled_artifacts`,
      `ALTER TABLE distilled_artifacts_new RENAME TO distilled_artifacts`,
      `CREATE INDEX IF NOT EXISTS idx_distilled_artifacts_persona ON distilled_artifacts(tenant_id, persona_id)`,
      `CREATE INDEX IF NOT EXISTS idx_distilled_artifacts_status ON distilled_artifacts(tenant_id, persona_id, status)`,
    ],
  },
});
