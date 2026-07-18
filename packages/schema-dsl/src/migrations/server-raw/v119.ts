import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 集成地基（Plan 1 Task 1）——建 github_app_credentials + github_installations 两表。
 *
 * 「数字人接 GitHub」的最底层存储：
 *   - github_app_credentials：per-tenant 存储 GitHub App 凭据（app_id + 加密的私钥 + 加密的 webhook
 *     secret）。tenant_id 作主键，即每租户单份 App 凭据（单例表）。ghe_base_url 支持 GitHub Enterprise
 *     自托管实例（NULL 表示 github.com 公有云）。private_key_encrypted / webhook_secret_encrypted 落库即
 *     密文（加密由服务层负责，本表只存密文列）。
 *   - github_installations：GitHub App 在某账号下的 installation → 本地 tenant 映射。id 作主键；
 *     UNIQUE(github_host, installation_id) 是**全局唯一**（不含 tenant_id）——这是防跨租户 webhook 混淆
 *     的安全不变量：一个 (host, installation) 只能属于一个 tenant，否则同一条 GitHub webhook 会在多个租户
 *     间产生归属歧义。account / repos 是 installation 元数据（账号名 / 仓库列表 JSON），可空。
 *
 * 两表均含 tenant_id，纳入 TenantDatabase 自动隔离集（TENANT_TABLES）与 GDPR 导出/擦除清单
 * （privacy-service TENANT_TABLES），随 Task 1 同片登记。
 *
 * 时间戳列：Postgres 用 BIGINT（毫秒 epoch），SQLite 无 BIGINT 用 INTEGER（同为 64 位整数语义）。
 *
 * 后续 5 个 task 依赖这两表（webhook 入口 / installation 回调 / App 凭据管理 / 仓库操作等）。本片纯建表
 * DDL，无 DML，向后兼容（新表不影响任何既有表），回滚安全（DROP 两新表即可）。
 *
 * Alias：SQLite v119 / Postgres v121（紧跟 v118 life_simulations owner_user_id / Postgres v120）。
 */
export const v119_github_integration: RawMigration = defineRaw({
  id: 'github-integration',
  version: 'v119',
  aliases: { postgres: 'v121', 'sqlite-sql': 'v119' },
  description: 'GitHub integration foundation: github_app_credentials + github_installations tables',
  reason: '建两表：per-tenant GitHub App 凭据（密文）+ installation→tenant 映射（(github_host, installation_id) 全局唯一防跨租户混淆）',
  postgres: rawSql([
    `CREATE TABLE IF NOT EXISTS github_app_credentials (
      tenant_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      private_key_encrypted TEXT NOT NULL,
      webhook_secret_encrypted TEXT NOT NULL,
      ghe_base_url TEXT,
      created_by TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS github_installations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      github_host TEXT NOT NULL,
      account TEXT,
      repos TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_host_iid
      ON github_installations (github_host, installation_id)`,
  ]),
  sqlite: rawSql([
    `CREATE TABLE IF NOT EXISTS github_app_credentials (
      tenant_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      private_key_encrypted TEXT NOT NULL,
      webhook_secret_encrypted TEXT NOT NULL,
      ghe_base_url TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS github_installations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      github_host TEXT NOT NULL,
      account TEXT,
      repos TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_host_iid
      ON github_installations (github_host, installation_id)`,
  ]),
});
