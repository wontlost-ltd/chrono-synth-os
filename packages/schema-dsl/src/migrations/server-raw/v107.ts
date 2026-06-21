import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * K2（ADR-0056）每-(租户, 人格) 认知内核隔离·人格特征三表主键扩维。
 *
 * K1（v106）已给认知核心表加 persona_id 列（不改主键，保 ON CONFLICT(tenant_id) 向后兼容）。K2 把**定义
 * 一个人格性格的三张单例表**——decision_style / cognitive_model / narrative——主键从 (tenant_id) 改成
 * **(tenant_id, persona_id)**，让同租户多 persona 各有独立的决策风格 / 认知模型 / 自我叙事。
 *
 * **必须与 executor 改 `ON CONFLICT(tenant_id, persona_id)` 原子一起落**（K1 已论证：单改主键会让旧
 * executor `ON CONFLICT(tenant_id)` 运行时报错）。本迁移改主键 + 同 PR 的 executor 改 SQL，二者同片不可拆。
 *
 * 向后兼容：persona_id 已是 NOT NULL DEFAULT 'default'（K1 加），现有行都是 default；旧调用方（companion +
 * manager-persona）不传 persona → 服务层默认 'default'，读写仍命中 default 行。
 *
 * 手法与 v007 单例表重建同款：PG DROP/ADD PRIMARY KEY；SQLite RENAME→新表(复合主键)→INSERT SELECT 回填
 * →drop 旧。memory/values/anchors 图谱**不在本片**（persona_id 列已加但 executor 仍 tenant 键，留后续子片）。
 *
 * 红线：零-LLM 不变；本片仍未产生非 default persona 数据（seed 在 K4），回滚安全。
 * Alias：SQLite v107 / Postgres v109（紧跟 v106 persona_id 加列 / Postgres v108）。
 */
export const v107_persona_character_pk: RawMigration = defineRaw({
  id: 'persona-character-pk',
  version: 'v107',
  aliases: { postgres: 'v109', 'sqlite-sql': 'v107' },
  description: 'K2 ADR-0056: composite (tenant_id, persona_id) PK on decision_style/cognitive_model/narrative',
  reason: 'PG DROP/ADD PRIMARY KEY；SQLite 重建三张人格特征单例表为 (tenant_id, persona_id) 复合主键',
  postgres: rawSql([
    `ALTER TABLE decision_style DROP CONSTRAINT IF EXISTS decision_style_pkey`,
    `ALTER TABLE decision_style ADD PRIMARY KEY (tenant_id, persona_id)`,
    `ALTER TABLE cognitive_model DROP CONSTRAINT IF EXISTS cognitive_model_pkey`,
    `ALTER TABLE cognitive_model ADD PRIMARY KEY (tenant_id, persona_id)`,
    `ALTER TABLE narrative DROP CONSTRAINT IF EXISTS narrative_pkey`,
    `ALTER TABLE narrative ADD PRIMARY KEY (tenant_id, persona_id)`,
  ]),
  sqlite: rawSql([
    /* SQLite 不能改主键，三张人格特征表重建为 (tenant_id, persona_id) 复合主键（safe:if-table-exists 守卫
     * legacy 部分预建路径——某些迁移路径下表可能未由前序迁移建出）。 */
    `/* safe:if-table-exists:decision_style */ ALTER TABLE decision_style RENAME TO decision_style_old`,
    `/* safe:if-table-exists:decision_style_old */ CREATE TABLE IF NOT EXISTS decision_style (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      persona_id TEXT NOT NULL DEFAULT 'default',
      style_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, persona_id)
    )`,
    `/* safe:if-table-exists:decision_style_old */ INSERT OR IGNORE INTO decision_style (tenant_id, persona_id, style_json, updated_at)
     SELECT tenant_id, persona_id, style_json, updated_at FROM decision_style_old`,
    `/* safe:if-table-exists:decision_style_old */ DROP TABLE IF EXISTS decision_style_old`,
    `/* safe:if-table-exists:cognitive_model */ ALTER TABLE cognitive_model RENAME TO cognitive_model_old`,
    `/* safe:if-table-exists:cognitive_model_old */ CREATE TABLE IF NOT EXISTS cognitive_model (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      persona_id TEXT NOT NULL DEFAULT 'default',
      model_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, persona_id)
    )`,
    `/* safe:if-table-exists:cognitive_model_old */ INSERT OR IGNORE INTO cognitive_model (tenant_id, persona_id, model_json, updated_at)
     SELECT tenant_id, persona_id, model_json, updated_at FROM cognitive_model_old`,
    `/* safe:if-table-exists:cognitive_model_old */ DROP TABLE IF EXISTS cognitive_model_old`,
    `/* safe:if-table-exists:narrative */ ALTER TABLE narrative RENAME TO narrative_old`,
    `/* safe:if-table-exists:narrative_old */ CREATE TABLE IF NOT EXISTS narrative (
      tenant_id TEXT NOT NULL DEFAULT 'default',
      persona_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, persona_id)
    )`,
    `/* safe:if-table-exists:narrative_old */ INSERT OR IGNORE INTO narrative (tenant_id, persona_id, content, updated_at)
     SELECT tenant_id, persona_id, content, updated_at FROM narrative_old`,
    `/* safe:if-table-exists:narrative_old */ DROP TABLE IF EXISTS narrative_old`,
  ]),
});
