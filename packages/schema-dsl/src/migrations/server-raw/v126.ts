import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 组织级驻留地基——给 github_learn_state.resource_type 的 CHECK 加组织轮转哨兵。
 *
 * 为什么要扩：组织级同步每轮只处理 N 个仓库（使单轮成本恒定、不触发 GitHub 二级速率限制），
 * 需要一条「下一个起始下标」游标记住轮转进度。该游标本质就是一种学习进度游标，属
 * github_learn_state 的固有职责，故复用该表——repo 字段存组织标识、resource_type 存哨兵
 * '_org_rotation'、cursor 存下标。但原 CHECK 锁死四类可学资源，哨兵值写入被拒
 * （实测报错 CHECK constraint failed），故须扩容为超集。
 *
 * 手法与 v122 同款：SQLite 不能 ALTER CHECK 约束，重建表——
 *   RENAME github_learn_state → _old（同名唯一索引随表迁到 _old，但索引名在库内全局唯一，
 *   仍占用该名字）；DROP INDEX IF EXISTS 先删掉随 _old 挪来的旧索引（否则后面
 *   CREATE INDEX IF NOT EXISTS 因同名索引已存在而静默 no-op，新表建不出索引，
 *   DROP _old 时连带删掉唯一那份索引 → live 表零唯一索引、幂等键失效）；
 *   CREATE 新表（新 CHECK）；INSERT SELECT 回填（旧行 resource_type 全落在新 CHECK 超集内）；
 *   CREATE INDEX 重建；DROP _old。
 *   PG 走原地 ALTER：DROP CONSTRAINT + ADD CONSTRAINT。
 *
 * 时间戳列：Postgres BIGINT（毫秒 epoch），SQLite 无 BIGINT 用 INTEGER（同为 64 位整数语义）。
 *
 * 向后兼容：新 CHECK 是旧取值的**超集**，既有行全部合法，既有写路径零影响。
 * 表未变更隔离/GDPR 归属（github_learn_state 已含 tenant_id，Plan 2 已登记）。
 * 回滚：SQLite 反向重建（去哨兵取值），PG 反向换回原 CHECK。
 *
 * Alias：SQLite v126 / Postgres v128（紧跟 v125 github-digest-discussion-key / Postgres v127）。
 */
export const v126_github_learn_state_org_rotation: RawMigration = defineRaw({
  id: 'github-learn-state-org-rotation',
  version: 'v126',
  aliases: { postgres: 'v128', 'sqlite-sql': 'v126' },
  description: 'GitHub org residency: github_learn_state resource_type CHECK adds _org_rotation sentinel',
  reason: '组织级驻留轮转游标复用 github_learn_state（语义正确：轮转进度即学习进度游标），但原 CHECK 锁死四类资源致哨兵值写入被拒；扩 CHECK 为超集容纳 _org_rotation；PG 原地 ALTER CONSTRAINT，SQLite 重建表（不能 ALTER CHECK），重建前先 DROP INDEX 防静默丢唯一索引',
  postgres: rawSql([
    `ALTER TABLE github_learn_state DROP CONSTRAINT IF EXISTS github_learn_state_resource_type_check`,
    `ALTER TABLE github_learn_state ADD CONSTRAINT github_learn_state_resource_type_check CHECK (resource_type IN ('code', 'issues', 'pulls', 'commits', '_org_rotation'))`,
  ]),
  sqlite: rawSql([
    `/* safe:if-table-exists:github_learn_state */ ALTER TABLE github_learn_state RENAME TO github_learn_state_old`,
    /* RENAME 后同名索引随 _old 挪走但仍占用全局索引名，先 DROP 掉——否则下面
     * CREATE INDEX IF NOT EXISTS 静默 no-op，DROP _old 时连带删掉唯一那份索引。 */
    `/* safe:if-table-exists:github_learn_state_old */ DROP INDEX IF EXISTS idx_github_learn_state_key`,
    `/* safe:if-table-exists:github_learn_state_old */ CREATE TABLE IF NOT EXISTS github_learn_state (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('code', 'issues', 'pulls', 'commits', '_org_rotation')),
      cursor TEXT,
      cursor_advanced_at INTEGER,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `/* safe:if-table-exists:github_learn_state_old */ INSERT OR IGNORE INTO github_learn_state (id, tenant_id, persona_id, repo, resource_type, cursor, cursor_advanced_at, last_synced_at, created_at, updated_at)
     SELECT id, tenant_id, persona_id, repo, resource_type, cursor, cursor_advanced_at, last_synced_at, created_at, updated_at FROM github_learn_state_old`,
    `/* safe:if-table-exists:github_learn_state_old */ CREATE UNIQUE INDEX IF NOT EXISTS idx_github_learn_state_key
      ON github_learn_state (tenant_id, persona_id, repo, resource_type)`,
    `/* safe:if-table-exists:github_learn_state_old */ DROP TABLE IF EXISTS github_learn_state_old`,
  ]),
});
