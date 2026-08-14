/**
 * GitHub ReadPort 共享装配器——从租户凭据造只读 port。
 *
 * 为什么抽出来：装配逻辑（查 App 凭据 → 取 installation → 造 auth → GHE 分支）此前重复在
 * learn-github 端点、draft-github-reply 端点、app.ts 发布装配三处；组织同步 worker 会成为
 * 第四份。四次复制同一段**安全敏感**逻辑（凭据读取 + SSRF allowlist）是明确的维护风险
 * ——改一处漏三处即可能造成 GHE 场景绕过 host allowlist，故收敛为单一实现。
 *
 * 返回 failure 而非抛错的理由：调用方对「未连 GitHub」的期望不同——HTTP 端点要给明确 4xx
 * 引导用户去连接，而后台 worker 应静默跳过（未连 GitHub 的租户占多数，抛错会刷满错误日志）。
 * 把「是什么情况」与「怎么反应」分开，让调用方自己决定。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { githubInstallListByTenant } from '@chrono/kernel';
import { GitHubAuthManager } from './github-auth-manager.js';
import { GitHubReadPortImpl, type GitHubReadPort } from './github-read-port.js';
import { GithubAppCredentialStore } from '../../storage/github-app-credential-store.js';
import type { FieldEncryption } from '../../storage/encryption.js';

/** 装配失败原因（调用方据此给明确 4xx 或静默跳过）。 */
export type ReadPortAssemblyFailure = 'no-credential' | 'no-installation';

export interface ReadPortAssemblyResult {
  /** 装配成功的只读 port；失败时为 undefined。 */
  readPort?: GitHubReadPort;
  /** 失败原因；成功时为 undefined。 */
  failure?: ReadPortAssemblyFailure;
}

/**
 * 从租户凭据装配 ReadPort。
 *
 * installationId 取本租户最近一个 installation（首版策略；listByTenant 按 created_at DESC）。
 * GHE 自托管（gheBaseUrl 非空）：把企业 API host 透传给 ReadPort 的 apiBase + hostAllowlist
 * ——否则出站会被 SSRF 网关拒绝。
 */
export function assembleGitHubReadPort(
  tx: SyncWriteUnitOfWork,
  encryption: FieldEncryption,
  tenantId: string,
  now: () => number,
): ReadPortAssemblyResult {
  const appCred = new GithubAppCredentialStore(tx, encryption, tenantId).getApp();
  if (!appCred) return { failure: 'no-credential' };

  const installation = tx.queryMany(githubInstallListByTenant(tenantId))[0];
  if (!installation) return { failure: 'no-installation' };

  const auth = new GitHubAuthManager({
    getApp: () => ({ appId: appCred.appId, privateKeyPem: appCred.privateKeyPem, gheBaseUrl: appCred.gheBaseUrl }),
    installationId: installation.installation_id,
    now,
  });
  if (appCred.gheBaseUrl) {
    const host = new URL(appCred.gheBaseUrl).hostname;
    return { readPort: new GitHubReadPortImpl(auth, { apiBase: appCred.gheBaseUrl, hostAllowlist: [host] }) };
  }
  return { readPort: new GitHubReadPortImpl(auth) };
}
