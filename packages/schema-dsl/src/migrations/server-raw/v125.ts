import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 讨论内容摄入地基——给 github_ingest_digests 加讨论键与记忆指针两列。
 *
 * 为什么要这两列：摄入幂等账本以 content_sha 为键，而 content_sha = sha256(representation)。
 * 表征一旦包含 issue 讨论/PR review 评论，**每新增一条评论就产生新 sha**，去重账本随之失效——
 * 同一个 issue 会被反复当作「新内容」沉淀，记忆库堆积大量近似重复的碎片。
 *
 * 解法（演进式取代）：加两列——
 *   - discussion_key：讨论稳定标识（形如 issues:owner/repo#42），跨轮次恒定，与表征 sha 无关。
 *   - memory_id：该讨论当前对应的记忆 ID，供新表征沉淀后定位并删除上一版记忆。
 * 摄入流程据此变为「查旧记忆 → perceive 产新记忆 → 删旧记忆 → 记新指针」，
 * 使每个 issue/PR 在记忆库中恒为一条 = 最新共识，讨论演进时记忆随之演进而非堆积。
 *
 * 两列均可空：既有行以及 code / commits 两类资源无讨论概念，保持 NULL 合法。
 *
 * 二级索引 idx_github_ingest_digests_discussion (tenant_id, persona_id, discussion_key)
 * 支撑按讨论键反查（取代路径每条内容查一次，必须走索引）。
 *
 * 手法：纯加列 + 加索引，**不重建表**——故不触发 SQLite 重建表时
 * 「RENAME 占用索引名致 CREATE INDEX IF NOT EXISTS 静默 no-op」那个已知坑（参 v122 注释）。
 * PG 用 ADD COLUMN IF NOT EXISTS；SQLite 的 ALTER TABLE ADD COLUMN 无 IF NOT EXISTS 语法，
 * 因版本号全新不会重复执行，直接加列。
 *
 * 向后兼容：两列可空，既有 claim/markIngested 写路径不传两列仍合法。
 * 表隔离/GDPR 归属不变（github_ingest_digests 已含 tenant_id，Plan 2 已登记）。
 * 回滚：PG 反向 DROP COLUMN + DROP INDEX；SQLite 需重建表去列（或保留冗余空列，无害）。
 *
 * Alias：SQLite v125 / Postgres v127（紧跟 v124 tenant-bootstrap-backfill / Postgres v126）。
 */
export const v125_github_digest_discussion_key: RawMigration = defineRaw({
  id: 'github-digest-discussion-key',
  version: 'v125',
  aliases: { postgres: 'v127', 'sqlite-sql': 'v125' },
  description: 'GitHub ingest digests: add discussion_key + memory_id columns for evolutionary supersede',
  reason: '讨论内容摄入：加 discussion_key（issues:owner/repo#42 讨论稳定标识，可空）+ memory_id（该讨论当前记忆指针，可空，供新记忆沉淀后删旧记忆）+ (tenant_id, persona_id, discussion_key) 二级索引；纯加列不重建表，规避 SQLite 重建丢索引坑',
  postgres: rawSql([
    `ALTER TABLE github_ingest_digests ADD COLUMN IF NOT EXISTS discussion_key TEXT`,
    `ALTER TABLE github_ingest_digests ADD COLUMN IF NOT EXISTS memory_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_github_ingest_digests_discussion
      ON github_ingest_digests (tenant_id, persona_id, discussion_key)`,
  ]),
  sqlite: rawSql([
    /* SQLite 无 ADD COLUMN IF NOT EXISTS；版本号全新不会重复执行，直接加列。 */
    `ALTER TABLE github_ingest_digests ADD COLUMN discussion_key TEXT`,
    `ALTER TABLE github_ingest_digests ADD COLUMN memory_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_github_ingest_digests_discussion
      ON github_ingest_digests (tenant_id, persona_id, discussion_key)`,
  ]),
});
