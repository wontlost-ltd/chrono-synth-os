/**
 * GitHub App 凭据 + Installation 映射的 Query/Command kind 契约（GitHub 集成 Plan 1）。
 *
 * kernel 只声明数据形状与 { kind, params } 描述符；SQL 执行器在 src/storage/executors
 * （与 llm-credential-queries.ts / llm-credential-executors.ts 同架构）。加密列
 * （private_key_encrypted / webhook_secret_encrypted）只存密文——加解密是应用层 store 的事，
 * kernel 契约层不碰。
 *
 * 两个存储对象：
 *   - github_app_credentials：per-tenant 单例（tenant_id 作主键）。App 凭据 upsert 同 BYOK
 *     语义：同 tenant 覆盖更新，secret 不留版本史。ghe_base_url 支持 GitHub Enterprise 自托管
 *     （null = github.com 公有云）。
 *   - github_installations：installation → tenant 映射。UNIQUE(github_host, installation_id)
 *     是全局唯一约束（不含 tenant_id），防跨租户 webhook 混淆——githubInstallQueryByHostIid
 *     即依赖该约束做 webhook 反查（一个 (host, installation) 只能属于一个 tenant）。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const GITHUB_APPCRED_QUERY_BY_TENANT = 'githubAppCred.byTenant' as const;
export const GITHUB_APPCRED_CMD_UPSERT = 'githubAppCred.upsert' as const;
export const GITHUB_APPCRED_CMD_DELETE = 'githubAppCred.delete' as const;

export const GITHUB_INSTALL_QUERY_BY_HOST_IID = 'githubInstall.byHostIid' as const;
export const GITHUB_INSTALL_QUERY_LIST_BY_TENANT = 'githubInstall.listByTenant' as const;
export const GITHUB_INSTALL_CMD_UPSERT = 'githubInstall.upsert' as const;
/** 删除 installation 映射（App 被卸载 → 学习自动停）。 */
export const GITHUB_INSTALL_CMD_DELETE = 'githubInstall.delete' as const;
/** 置/清 installation 暂停状态。 */
export const GITHUB_INSTALL_CMD_SET_SUSPENDED = 'githubInstall.setSuspended' as const;
/** 同步 installation 的授权仓库列表。 */
export const GITHUB_INSTALL_CMD_UPDATE_REPOS = 'githubInstall.updateRepos' as const;

/* ── Row（对齐 DB 列，snake_case） ── */

export interface GithubAppCredentialRow {
  readonly tenant_id: string;
  readonly app_id: string;
  /** FieldEncryption 密文（明文私钥绝不落库）。 */
  readonly private_key_encrypted: string;
  /** FieldEncryption 密文（webhook secret 绝不落库）。 */
  readonly webhook_secret_encrypted: string;
  /** GitHub Enterprise 自托管实例 base url；null = github.com 公有云。 */
  readonly ghe_base_url: string | null;
  readonly created_by: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface GithubInstallationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly installation_id: string;
  readonly github_host: string;
  /** installation 元数据：账号名（可空）。 */
  readonly account: string | null;
  /** installation 元数据：仓库列表 JSON（可空）。 */
  readonly repos: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  /** 暂停时刻（毫秒 epoch）；null = 未暂停。GitHub 允许暂停已安装 App（暂停期 token 换取失败）。 */
  readonly suspended_at: number | null;
}

/* ── Params ── */

export interface GithubAppCredUpsertParams {
  tenantId: string;
  appId: string;
  privateKeyEncrypted: string;
  webhookSecretEncrypted: string;
  gheBaseUrl: string | null;
  createdBy: string | null;
  now: number;
}

export interface GithubInstallByHostIidParams {
  githubHost: string;
  installationId: string;
}

export interface GithubInstallUpsertParams {
  id: string;
  tenantId: string;
  installationId: string;
  githubHost: string;
  account: string | null;
  repos: string | null;
  now: number;
}

/* ── App 凭据工厂 ── */

/** 取某租户的 GitHub App 凭据（per-tenant 单例；供签发 installation token 用）。 */
export function githubAppCredQueryByTenant(tenantId: string): Query<GithubAppCredentialRow | null, string> {
  return { kind: GITHUB_APPCRED_QUERY_BY_TENANT, params: tenantId };
}

/** upsert：同 tenant 覆盖更新（App 凭据是 secret，不留版本史；同 BYOK upsert 语义）。 */
export function githubAppCredUpsert(params: GithubAppCredUpsertParams): Command<GithubAppCredUpsertParams> {
  return { kind: GITHUB_APPCRED_CMD_UPSERT, params };
}

/** 删除某租户 App 凭据（撤销 / GDPR 擦除）。 */
export function githubAppCredDelete(tenantId: string): Command<string> {
  return { kind: GITHUB_APPCRED_CMD_DELETE, params: tenantId };
}

/* ── Installation 工厂 ── */

/**
 * webhook 反查：按 (github_host, installation_id) 定位 installation → tenant 映射。
 * 依赖 UNIQUE(github_host, installation_id) 全局唯一约束，返回 0/1 行。
 */
export function githubInstallQueryByHostIid(params: GithubInstallByHostIidParams): Query<GithubInstallationRow | null, GithubInstallByHostIidParams> {
  return { kind: GITHUB_INSTALL_QUERY_BY_HOST_IID, params };
}

/** 列某租户全部 installation 映射（管理 / 展示）。 */
export function githubInstallListByTenant(tenantId: string): Query<GithubInstallationRow, string> {
  return { kind: GITHUB_INSTALL_QUERY_LIST_BY_TENANT, params: tenantId };
}

/** upsert installation 映射（安装回调 / 元数据同步）。 */
export function githubInstallUpsert(params: GithubInstallUpsertParams): Command<GithubInstallUpsertParams> {
  return { kind: GITHUB_INSTALL_CMD_UPSERT, params };
}

/** installation 全局唯一定位键（平台级映射表，不带 tenant 过滤——同 resolveTenantByInstallation）。 */
export interface GithubInstallKeyParams {
  githubHost: string;
  installationId: string;
}

export interface GithubInstallSetSuspendedParams extends GithubInstallKeyParams {
  /** 暂停时刻（毫秒 epoch）；null = 恢复（清除暂停）。 */
  suspendedAt: number | null;
  now: number;
}

export interface GithubInstallUpdateReposParams extends GithubInstallKeyParams {
  /** 授权仓库列表（逗号分隔的 owner/name）；null = 未知。 */
  repos: string | null;
  now: number;
}

/**
 * 删除 installation 映射。App 被卸载时调用——映射一删，assembleGitHubReadPort 即返
 * no-installation，组织同步 worker 与学习 handler 都会静默跳过，学习自动停止。
 */
export function githubInstallDelete(params: GithubInstallKeyParams): Command<GithubInstallKeyParams> {
  return { kind: GITHUB_INSTALL_CMD_DELETE, params };
}

/** 置/清 installation 暂停状态（suspendedAt=null 表示恢复）。 */
export function githubInstallSetSuspended(params: GithubInstallSetSuspendedParams): Command<GithubInstallSetSuspendedParams> {
  return { kind: GITHUB_INSTALL_CMD_SET_SUSPENDED, params };
}

/** 同步 installation 的授权仓库列表（installation_repositories 事件维护）。 */
export function githubInstallUpdateRepos(params: GithubInstallUpdateReposParams): Command<GithubInstallUpdateReposParams> {
  return { kind: GITHUB_INSTALL_CMD_UPDATE_REPOS, params };
}
