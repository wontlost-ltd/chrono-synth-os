import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 反馈发布段地基（Plan 4 Task 1）——给 github_reply_drafts 加发布态与审计列。
 *
 * Plan 3（v121）把草稿停在 drafted → approved / rejected 三态待审批（红线：起草即停，绝不自动发布）。
 * Plan 4 是集成最后一段（发布）：人工批准后经 pipeline highRisk confirmation 门真投递到 GitHub。
 * 投递成功后草稿要落一个终态并留审计佐证，本迁移改 github_reply_drafts 三处：
 *   - status CHECK 从 ('drafted','approved','rejected') 扩为 ('drafted','approved','rejected','published')，
 *     'published' 为发布成功后的终态（approved → published，人工批准后真投递到位才标）。
 *   - 加 published_at（可空，发布时间戳；未发布的草稿为 NULL）——审计与追溯。
 *   - 加 github_ref（可空 TEXT，发布后存 GitHub 侧 comment/review id）——审计佐证 + 去重佐证
 *     （同一草稿若重复投递可凭 github_ref 判定已发布，避免重复评论）。
 * 其余列 / PRIMARY KEY (id) / 唯一约束 / idx_github_reply_drafts_lookup 索引均不变。
 *
 * 手法与 v107 单例表重建同款：SQLite 不能 ALTER CHECK 约束，故重建表——
 *   RENAME github_reply_drafts → _old（索引随表迁到 _old）；CREATE 新表（新 CHECK + 两新列）；
 *   INSERT SELECT 回填旧数据（旧行 status 都是 drafted/approved/rejected，全落在新 CHECK 集内，
 *   两新列回填 NULL）；重建 idx_github_reply_drafts_lookup（旧索引随 _old 一并 DROP 掉需重建）；
 *   DROP _old。PG 走原地 ALTER：DROP CONSTRAINT + ADD CONSTRAINT（新 CHECK）+ 两次 ADD COLUMN。
 *
 * 时间戳列：Postgres 用 BIGINT（毫秒 epoch），SQLite 无 BIGINT 用 INTEGER（同为 64 位整数语义）。
 *
 * 向后兼容：两新列可空、status 新增取值是超集（旧行全合法），draft store 旧写路径不传两新列仍合法。
 * 表未变更隔离/GDPR 归属（github_reply_drafts 已含 tenant_id，Plan 3 已登记 TENANT_TABLES / privacy 清单）。
 * 回滚：SQLite 反向重建（去 published 态 + 去两列），PG 反向 DROP COLUMN + 换回原 CHECK。
 *
 * Alias：SQLite v122 / Postgres v124（紧跟 Plan 3 github-reply-drafts / SQLite v121 / Postgres v123）。
 */
export const v122_github_draft_published: RawMigration = defineRaw({
  id: 'github-draft-published',
  version: 'v122',
  aliases: { postgres: 'v124', 'sqlite-sql': 'v122' },
  description: 'GitHub feedback publishing foundation: github_reply_drafts status CHECK adds published + published_at/github_ref audit columns',
  reason: '给 github_reply_drafts 加发布终态与审计列：status CHECK 加 published（发布成功终态）+ published_at（发布时间戳，可空）+ github_ref（GitHub 侧 comment/review id，可空，审计+去重佐证）；PG 原地 ALTER，SQLite 重建表（不能 ALTER CHECK）',
  postgres: rawSql([
    `ALTER TABLE github_reply_drafts DROP CONSTRAINT IF EXISTS github_reply_drafts_status_check`,
    `ALTER TABLE github_reply_drafts ADD CONSTRAINT github_reply_drafts_status_check CHECK (status IN ('drafted', 'approved', 'rejected', 'published'))`,
    `ALTER TABLE github_reply_drafts ADD COLUMN IF NOT EXISTS published_at BIGINT`,
    `ALTER TABLE github_reply_drafts ADD COLUMN IF NOT EXISTS github_ref TEXT`,
  ]),
  sqlite: rawSql([
    /* SQLite 不能改 CHECK 约束，重建 github_reply_drafts（新 status CHECK 含 published + 加两新列）。
     * safe:if-table-exists 守卫 legacy 部分预建路径（某些迁移路径下表可能未由前序迁移建出）。 */
    `/* safe:if-table-exists:github_reply_drafts */ ALTER TABLE github_reply_drafts RENAME TO github_reply_drafts_old`,
    `/* safe:if-table-exists:github_reply_drafts_old */ CREATE TABLE IF NOT EXISTS github_reply_drafts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('issue', 'pull')),
      target_number INTEGER NOT NULL,
      draft_body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('drafted', 'approved', 'rejected', 'published')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      published_at INTEGER,
      github_ref TEXT
    )`,
    `/* safe:if-table-exists:github_reply_drafts_old */ INSERT OR IGNORE INTO github_reply_drafts (id, tenant_id, persona_id, repo, target_type, target_number, draft_body, status, created_at, updated_at)
     SELECT id, tenant_id, persona_id, repo, target_type, target_number, draft_body, status, created_at, updated_at FROM github_reply_drafts_old`,
    `/* safe:if-table-exists:github_reply_drafts_old */ CREATE INDEX IF NOT EXISTS idx_github_reply_drafts_lookup ON github_reply_drafts (tenant_id, persona_id, status)`,
    `/* safe:if-table-exists:github_reply_drafts_old */ DROP TABLE IF EXISTS github_reply_drafts_old`,
  ]),
});
