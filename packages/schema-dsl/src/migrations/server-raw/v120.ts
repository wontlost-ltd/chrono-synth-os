import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 学习段地基（Plan 2 Task 1）——建 github_learn_state + github_ingest_digests 两表。
 *
 * 「数字人从 GitHub 增量学习」的最底层存储，两张表分工正交：
 *   - github_learn_state：增量同步游标账本。per (tenant, persona, repo, resource_type) 记录一条
 *     游标（cursor）与推进/同步时间戳，供后续 task 断点续拉。resource_type 限定四类可学资源
 *     （code / issues / pulls / commits），CHECK 钉死取值防脏数据。cursor 可空（首次同步前无游标）；
 *     cursor_advanced_at / last_synced_at 亦可空（尚未推进/同步）。UNIQUE(tenant_id, persona_id,
 *     repo, resource_type) 保证一个 (租户,人格,仓库,资源类型) 只有一条游标行。
 *   - github_ingest_digests：摄入幂等账本。以 content_sha 为内容指纹，记录某条资源是否已被摄入，
 *     status 走 claimed → ingested 两态（先占位 claimed 抢占幂等窗口，摄入完成后置 ingested），
 *     CHECK 钉死取值。claimed_at / ingested_at 分别记录两态时间（各自可空）。
 *     UNIQUE(tenant_id, persona_id, repo, resource_type, content_sha) 是幂等主键：同一内容指纹在
 *     同一 (租户,人格,仓库,资源类型) 下只能占位一次，防重复摄入。
 *
 * 两表均含 tenant_id，纳入 TenantDatabase 自动隔离集（TENANT_TABLES）与 GDPR 导出/擦除清单
 * （privacy-service TENANT_TABLES），随本片同片登记。
 *
 * 时间戳列：Postgres 用 BIGINT（毫秒 epoch），SQLite 无 BIGINT 用 INTEGER（同为 64 位整数语义）。
 *
 * 后续 task 依赖这两表（增量同步 store / 摄入 mapper / 学习 service / 端点）。本片纯建表 DDL，
 * 无 DML，向后兼容（新表不影响任何既有表），回滚安全（DROP 两新表即可）。
 *
 * Alias：SQLite v120 / Postgres v122（紧跟 Plan 1 github-integration / SQLite v119 / Postgres v121）。
 */
export const v120_github_learn_state: RawMigration = defineRaw({
  id: 'github-learn-state',
  version: 'v120',
  aliases: { postgres: 'v122', 'sqlite-sql': 'v120' },
  description: 'GitHub learning foundation: github_learn_state (incremental sync cursors) + github_ingest_digests (ingest idempotency ledger)',
  reason: '建两表：增量同步游标账本（(tenant,persona,repo,resource_type) 唯一）+ 摄入幂等账本（content_sha 指纹，claimed→ingested 两态，(tenant,persona,repo,resource_type,content_sha) 唯一防重复摄入）',
  postgres: rawSql([
    `CREATE TABLE IF NOT EXISTS github_learn_state (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('code', 'issues', 'pulls', 'commits')),
      cursor TEXT,
      cursor_advanced_at BIGINT,
      last_synced_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_learn_state_key
      ON github_learn_state (tenant_id, persona_id, repo, resource_type)`,
    `CREATE TABLE IF NOT EXISTS github_ingest_digests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      content_sha TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'ingested')),
      claimed_at BIGINT,
      ingested_at BIGINT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_ingest_digests_key
      ON github_ingest_digests (tenant_id, persona_id, repo, resource_type, content_sha)`,
  ]),
  sqlite: rawSql([
    `CREATE TABLE IF NOT EXISTS github_learn_state (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('code', 'issues', 'pulls', 'commits')),
      cursor TEXT,
      cursor_advanced_at INTEGER,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_learn_state_key
      ON github_learn_state (tenant_id, persona_id, repo, resource_type)`,
    `CREATE TABLE IF NOT EXISTS github_ingest_digests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      content_sha TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'ingested')),
      claimed_at INTEGER,
      ingested_at INTEGER
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_ingest_digests_key
      ON github_ingest_digests (tenant_id, persona_id, repo, resource_type, content_sha)`,
  ]),
});
