/**
 * GitHub App 凭据存储 — 薄适配器，加密在此层，密文落库（参照 LlmCredentialStore）。
 *
 * 存储的是「数字人接 GitHub」最底层的两类敏感数据：
 *   - github_app_credentials：per-tenant 单例的 GitHub App 凭据（app_id + 私钥 PEM + webhook secret）。
 *     私钥 PEM 与 webhook secret 各经 FieldEncryption 加密后落库，**明文绝不持久化**。
 *   - github_installations：GitHub App 在某账号下的 installation → 本地 tenant 映射（供 webhook 反查）。
 *
 * 安全契约：
 *   - 构造器 fail-closed（照 LlmCredentialStore）：!encryption.isEnabled → throw。否则 encrypt() 恒等
 *     返回明文，私钥/webhook secret 会明文落库。store 不依赖调用方纪律，自身拒绝明文落库。
 *   - storeApp：私钥 PEM + webhook secret 各加密后 upsert（同 tenant 覆盖，secret 不留版本史）。
 *   - getApp：解密取回明文（供签发 installation token / 校验 webhook 签名）。
 *   - resolveTenantByInstallation：webhook 反查——**不带 tenant_id 过滤**（见方法注释）。
 */

import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  githubAppCredQueryByTenant, githubAppCredUpsert,
  githubInstallQueryByHostIid, githubInstallUpsert,
  githubInstallDelete, githubInstallSetSuspended, githubInstallUpdateRepos,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';
import { FieldEncryption } from './encryption.js';

export interface GithubAppCredential {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  gheBaseUrl: string | null;
}

export class GithubAppCredentialStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly encryption: FieldEncryption,
    private readonly tenantId: string = 'default',
  ) {
    /* 硬安全边界（照 LlmCredentialStore BYOK 复审）：拒绝 disabled FieldEncryption——否则 encrypt()
     * 恒等返回明文，私钥 PEM / webhook secret 会明文落库。store 不依赖调用方纪律，自身 fail-closed。 */
    if (!encryption.isEnabled) {
      throw new Error('GithubAppCredentialStore 需要启用的 FieldEncryption（拒绝明文落库私钥 / webhook secret）');
    }
    registerCoreSelfExecutors();
  }

  /**
   * 加密落库本租户 GitHub App 凭据（覆盖既有）。私钥 PEM 与 webhook secret 各加密后落库——
   * **明文绝不持久化**。
   */
  storeApp(
    appId: string,
    privateKeyPem: string,
    webhookSecret: string,
    gheBaseUrl: string | null,
    createdBy: string | null,
    now: number,
  ): void {
    /* 各自加密后落库——明文绝不进库。 */
    const privateKeyEncrypted = this.encryption.encrypt(privateKeyPem);
    const webhookSecretEncrypted = this.encryption.encrypt(webhookSecret);
    this.tx.execute(githubAppCredUpsert({
      tenantId: this.tenantId,
      appId,
      privateKeyEncrypted,
      webhookSecretEncrypted,
      gheBaseUrl,
      createdBy,
      now,
    }));
  }

  /** 取本租户 App 凭据（解密私钥 PEM + webhook secret）。无凭据返回 undefined。 */
  getApp(): GithubAppCredential | undefined {
    const row = this.tx.queryOne(githubAppCredQueryByTenant(this.tenantId));
    if (!row) return undefined;
    return {
      appId: row.app_id,
      privateKeyPem: this.encryption.decrypt(row.private_key_encrypted),
      webhookSecret: this.encryption.decrypt(row.webhook_secret_encrypted),
      gheBaseUrl: row.ghe_base_url,
    };
  }

  /**
   * upsert 本租户的 installation → tenant 映射（安装回调 / 元数据同步）。
   * 冲突键是全局唯一的 (github_host, installation_id)：冲突时更新 account / repos 元数据，
   * 主键 id 保持不变。首次 insert 生成稳定 UUID 主键。
   */
  upsertInstallation(
    installationId: string,
    githubHost: string,
    account: string | null,
    repos: string | null,
    now: number,
  ): void {
    this.tx.execute(githubInstallUpsert({
      /* 首次 insert 用的候选主键；冲突（已存在同 host+installation）时 DO UPDATE 不改既有 id。 */
      id: randomUUID(),
      tenantId: this.tenantId,
      installationId,
      githubHost,
      account,
      repos,
      now,
    }));
  }

  /**
   * webhook 反查：从 (github_host, installation_id) 推断该 installation 归属的 tenant。
   *
   * ⚠️ 安全不变量（Task 3 红线）：**绝不带 tenant_id 过滤**。反查的全部意义就是推断一条 GitHub
   * webhook 到达时其归属的**未知** tenant——调用方此刻还不知道 tenant，无从过滤。依赖
   * UNIQUE(github_host, installation_id) 全局唯一约束保证 (host, installation) 只属于一个 tenant，
   * 从而返回确定的 0/1 行。因此本方法**不使用** this.tenantId。
   */
  resolveTenantByInstallation(githubHost: string, installationId: string): { tenantId: string } | undefined {
    const row = this.tx.queryOne(githubInstallQueryByHostIid({ githubHost, installationId }));
    if (!row) return undefined;
    return { tenantId: row.tenant_id };
  }

  /**
   * 删除 installation 映射（App 卸载时）。返回是否确有删除（幂等：删不存在的返 false 不抛错）。
   *
   * 删除即「停止学习」——映射一没，assembleGitHubReadPort 返 no-installation，
   * 组织同步 worker 与学习 handler 都静默跳过，无需额外停学逻辑。
   */
  deleteInstallation(githubHost: string, installationId: string): boolean {
    const result = this.tx.execute(githubInstallDelete({ githubHost, installationId }));
    return result.rowsAffected > 0;
  }

  /** 置/清 installation 暂停状态（suspendedAt=null 表示恢复）。 */
  setInstallationSuspended(githubHost: string, installationId: string, suspendedAt: number | null, now: number): void {
    this.tx.execute(githubInstallSetSuspended({ githubHost, installationId, suspendedAt, now }));
  }

  /** 同步 installation 的授权仓库列表（installation_repositories 事件维护）。 */
  updateInstallationRepos(githubHost: string, installationId: string, repos: string | null, now: number): void {
    this.tx.execute(githubInstallUpdateRepos({ githubHost, installationId, repos, now }));
  }
}
