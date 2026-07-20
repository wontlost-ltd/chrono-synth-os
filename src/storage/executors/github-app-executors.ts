/**
 * GitHub App 凭据 + installation 映射 SQL 执行器（GitHub 集成 Plan 1 Task 3）。
 *
 * kernel（github-app-types.ts）只声明 { kind, params } 描述符与 Row 形状；真 SQL 在此层。
 * 与 llm-credential-executors.ts 同架构。
 *
 * 加密列（private_key_encrypted / webhook_secret_encrypted）只存密文（store 层
 * FieldEncryption 加密后传入）。App 凭据 upsert 同 tenant 覆盖更新（secret 不留版本史）。
 *
 * ⚠️ 安全不变量（Task 2 契约 + Task 3 红线）：
 *   github_app_credentials 是 per-tenant 单例 → 全部 tenant scoped（WHERE tenant_id = ?）。
 *   githubInstall.byHostIid（webhook 反查）**绝不带 tenant_id 过滤**——反查的全部意义就是从
 *   (github_host, installation_id) 推断**未知**的 tenant。依赖 UNIQUE(github_host, installation_id)
 *   全局唯一约束保证 0/1 行。加 tenant_id 过滤会让 webhook 永远查不到归属租户，功能与安全双失。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  GithubAppCredentialRow, GithubInstallationRow,
  GithubAppCredUpsertParams, GithubInstallByHostIidParams, GithubInstallUpsertParams,
} from '@chrono/kernel';
import {
  GITHUB_APPCRED_QUERY_BY_TENANT, GITHUB_APPCRED_CMD_UPSERT, GITHUB_APPCRED_CMD_DELETE,
  GITHUB_INSTALL_QUERY_BY_HOST_IID, GITHUB_INSTALL_QUERY_LIST_BY_TENANT, GITHUB_INSTALL_CMD_UPSERT,
} from '@chrono/kernel';

export function registerGithubAppExecutors(): void {
  /* ── App 凭据 Queries ── */

  /** per-tenant 单例：取本租户 App 凭据。tenant scoped。 */
  registerQuery<GithubAppCredentialRow | null, string>(GITHUB_APPCRED_QUERY_BY_TENANT, (db, tenantId) => {
    return db.prepare<GithubAppCredentialRow>(
      'SELECT * FROM github_app_credentials WHERE tenant_id = ?',
    ).get(tenantId) ?? null;
  });

  /* ── App 凭据 Commands ── */

  /** upsert：同 tenant 覆盖更新（App 凭据是 secret，不留版本史；同 BYOK upsert 语义）。 */
  registerCommand<GithubAppCredUpsertParams>(GITHUB_APPCRED_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO github_app_credentials
         (tenant_id, app_id, private_key_encrypted, webhook_secret_encrypted, ghe_base_url, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         app_id = excluded.app_id,
         private_key_encrypted = excluded.private_key_encrypted,
         webhook_secret_encrypted = excluded.webhook_secret_encrypted,
         ghe_base_url = excluded.ghe_base_url,
         created_by = excluded.created_by,
         updated_at = excluded.updated_at`,
    ).run(
      p.tenantId, p.appId, p.privateKeyEncrypted, p.webhookSecretEncrypted,
      p.gheBaseUrl, p.createdBy, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });

  /** 删除本租户 App 凭据（撤销 / GDPR 擦除）。 */
  registerCommand<string>(GITHUB_APPCRED_CMD_DELETE, (db, tenantId) => {
    const result = db.prepare<void>(
      'DELETE FROM github_app_credentials WHERE tenant_id = ?',
    ).run(tenantId);
    return { rowsAffected: result.changes };
  });

  /* ── Installation Queries ── */

  /**
   * ⚠️ webhook 反查：按 (github_host, installation_id) 定位 installation → tenant 映射。
   * **绝不带 tenant_id 过滤**——反查目的即推断未知 tenant。依赖 UNIQUE(github_host, installation_id)
   * 全局唯一约束返回 0/1 行。
   */
  registerQuery<GithubInstallationRow | null, GithubInstallByHostIidParams>(GITHUB_INSTALL_QUERY_BY_HOST_IID, (db, p) => {
    return db.prepare<GithubInstallationRow>(
      'SELECT * FROM github_installations WHERE github_host = ? AND installation_id = ?',
    ).get(p.githubHost, p.installationId) ?? null;
  });

  /** 列本租户全部 installation 映射（管理 / 展示）。tenant scoped。 */
  registerQuery<readonly GithubInstallationRow[], string>(GITHUB_INSTALL_QUERY_LIST_BY_TENANT, (db, tenantId) => {
    return db.prepare<GithubInstallationRow>(
      'SELECT * FROM github_installations WHERE tenant_id = ? ORDER BY created_at DESC',
    ).all(tenantId);
  });

  /* ── Installation Commands ── */

  /**
   * upsert installation 映射（安装回调 / 元数据同步）。
   * 冲突键是全局唯一的 (github_host, installation_id)——冲突时更新元数据，**主键 id 保持不变**
   * （DO UPDATE 不改 id，保证 installation 身份稳定）。tenant_id 只在首次 insert 落定。
   */
  registerCommand<GithubInstallUpsertParams>(GITHUB_INSTALL_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO github_installations
         (id, tenant_id, installation_id, github_host, account, repos, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(github_host, installation_id) DO UPDATE SET
         account = excluded.account,
         repos = excluded.repos,
         updated_at = excluded.updated_at`,
    ).run(
      p.id, p.tenantId, p.installationId, p.githubHost, p.account, p.repos, p.now, p.now,
    );
    return { rowsAffected: result.changes };
  });
}
