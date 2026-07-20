/**
 * GitHubWritePort：GitHub 写端点（Plan 4 反馈发布段消费）。
 *
 * 本 port 是整个 GitHub 集成里**唯一能真写 GitHub 的模块**：对 issue 发评论、
 * 对 PR 发 COMMENT 型 review。Task 4 的 highRisk 写工具是它唯一持有者。
 *
 * 铁律（读写分离，与 Plan 1 的 GitHubReadPort 对称）：
 *   - 写能力**只**在本类里。只读侧（GitHubReadPort）绝不含写方法；把两者放在
 *     不同类里，学习/读取段拿到的对象在类型上就不可能发出写请求。
 *   - 所有写调用**经 githubFetch**（Task 4 的 SSRF 网关，锁死 host=
 *     api.github.com、scheme=https、禁自动重定向），绝不裸 fetch。Task 6 会加
 *     架构测试锁死本模块只被写工具 + 组合根 import。
 *
 * event 锁死 COMMENT（首版）：createReview 的 event 参数类型上就锁死字面量
 *   `'COMMENT'`——首版不做 APPROVE / REQUEST_CHANGES 这种更高危动作（YAGNI +
 *   降低"数字人误批准 PR"的风险）。要扩更高危 event 须显式改类型 + 走更严的
 *   审批门，而非在此悄悄放开。
 *
 * 认证与出站边界（复用 Task 4/5，与 read-port 完全一致）：
 *   - token 来自注入的 GitHubAuthManager.getInstallationToken()（Task 5）；
 *     每个方法都以 `Authorization: token <installation-token>` 发请求。
 *   - 出站经 githubFetch（Task 4）。公有云用默认 allowlist；GHE 场景由调用方
 *     通过 deps.apiBase + deps.hostAllowlist 显式给出（透传给 githubFetch）。
 *   - 凭据缺失时 getInstallationToken() 抛错，本 port 包一层"GitHub 未连接"
 *     语义再上抛，让上层清晰区分"未接 GitHub"与"接了但请求失败"。
 */

import { githubFetch, type GithubFetchOptions } from './github-http.js';
import type { GitHubAuthManager } from './github-auth-manager.js';
import { StateError } from '../../errors/index.js';

/** 公有云 API base（GHE 场景由 deps.apiBase 覆盖）。 */
const PUBLIC_API_BASE = 'https://api.github.com';

/** 写操作的返回：GitHub 资源的数字 id + 人可读的 html_url（映射为 htmlUrl）。 */
export interface GitHubWriteResult {
  id: number;
  htmlUrl: string;
}

/**
 * GitHub 写接口。只含"回评 / 发 review"两个写方法——review 的 event 类型上
 * 锁死 `'COMMENT'`（见文件头）。
 */
export interface GitHubWritePort {
  /** 对 issue（issueNumber）发一条评论，body 为评论正文。 */
  createIssueComment(repo: string, issueNumber: number, body: string): Promise<GitHubWriteResult>;
  /**
   * 对 PR（prNumber）发一条 review。event 首版锁死 `'COMMENT'`（不做
   * APPROVE / REQUEST_CHANGES 这种更高危动作）。
   */
  createReview(
    repo: string,
    prNumber: number,
    body: string,
    event: 'COMMENT',
  ): Promise<GitHubWriteResult>;
}

/** GitHubWritePortImpl 的可选依赖（默认走公有云 + 真 githubFetch）。 */
export interface GitHubWritePortDeps {
  /** 可注入出站实现，默认 Task 4 的 githubFetch（SSRF 网关）。仅用于可测性。 */
  fetchImpl?: typeof githubFetch;
  /** API base，默认公有云 `https://api.github.com`；GHE 场景传企业 API base。 */
  apiBase?: string;
  /**
   * githubFetch 的 host allowlist。公有云不传（用 githubFetch 默认只放
   * api.github.com）；GHE 场景须传企业 host，否则被 SSRF 网关拒绝。
   */
  hostAllowlist?: string[];
}

export class GitHubWritePortImpl implements GitHubWritePort {
  private readonly auth: GitHubAuthManager;
  private readonly fetchImpl: typeof githubFetch;
  private readonly apiBase: string;
  private readonly fetchOpts: GithubFetchOptions | undefined;

  constructor(auth: GitHubAuthManager, deps: GitHubWritePortDeps = {}) {
    this.auth = auth;
    this.fetchImpl = deps.fetchImpl ?? githubFetch;
    this.apiBase = (deps.apiBase ?? PUBLIC_API_BASE).replace(/\/+$/, '');
    this.fetchOpts = deps.hostAllowlist ? { hostAllowlist: deps.hostAllowlist } : undefined;
  }

  async createIssueComment(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubWriteResult> {
    const url = `${this.apiBase}/repos/${repo}/issues/${issueNumber}/comments`;
    return this.post(url, { body });
  }

  async createReview(
    repo: string,
    prNumber: number,
    body: string,
    event: 'COMMENT',
  ): Promise<GitHubWriteResult> {
    const url = `${this.apiBase}/repos/${repo}/pulls/${prNumber}/reviews`;
    /* event 类型上已锁死 'COMMENT'；显式写进 payload，不透传更高危 event。 */
    return this.post(url, { body, event });
  }

  /**
   * 发一次 GitHub 写请求（POST）：取 token（Task 5）→ 经 githubFetch（Task 4，
   * SSRF 网关）→ 非 2xx 抛 StateError → 解析返回的 id + html_url。
   *
   * token 获取失败（无凭据）时包一层"GitHub 未连接"语义再上抛（保留原始
   * cause），与 read-port 对称。
   */
  private async post(url: string, payload: Record<string, unknown>): Promise<GitHubWriteResult> {
    let token: string;
    try {
      token = await this.auth.getInstallationToken();
    } catch (cause) {
      /* getApp 无凭据 / 换 token 失败：让"GitHub 未连接"语义清晰浮现。 */
      throw new StateError(
        `GitHubWritePort：GitHub 未连接或凭据无效，无法写入（${
          cause instanceof Error ? cause.message : String(cause)
        }）`,
      );
    }

    const res = await this.fetchImpl(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      this.fetchOpts,
    );

    if (!res.ok) {
      throw new StateError(`GitHubWritePort：写入 GitHub 失败（HTTP ${res.status}）：${url}`);
    }

    const responseBody = (await res.json()) as { id?: number; html_url?: string };
    return {
      id: Number(responseBody.id),
      htmlUrl: typeof responseBody.html_url === 'string' ? responseBody.html_url : '',
    };
  }
}
