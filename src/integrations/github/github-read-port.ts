/**
 * GitHubReadPort：GitHub 只读端点（Plan 2 学习段消费）。
 *
 * 学习段要"看"一个 repo 的活动来长记忆：拉 issues / PRs / commits、看目录
 * 树、读单个文件。本 port 把这些 GitHub REST 端点封成一组只读方法，并把
 * GitHub 巨型响应**精简映射**成学习需要的字段（number/title/body/updatedAt/
 * sha/paths…），不透传整份响应。
 *
 * 铁律（spec 约束 ⑧）：本 port **只读**——绝不含 comment/review/create 等
 *   任何写方法。写侧（回评/审阅）是 Plan 4 的 GitHubWritePort，且唯一持有
 *   写能力。读写分离是安全不变式：把两者放在不同类里，学习段拿到的对象在
 *   类型上就不可能发出写请求。
 *
 * 认证与出站边界（复用 Task 4/5）：
 *   - token 来自注入的 GitHubAuthManager.getInstallationToken()（Task 5）；
 *     每个方法都以 `Authorization: token <installation-token>` 发请求。
 *   - 出站请求经 Task 4 的 githubFetch（SSRF 网关，锁 host=api.github.com、
 *     scheme=https、禁自动重定向）。公有云用默认 allowlist；GHE 场景由调用
 *     方通过 deps.apiBase + deps.hostAllowlist 显式给出。
 *
 * 分页：list 方法沿 GitHub 的 Link header `rel="next"` 循环拉取，直到无
 *   next 或触及 MAX_LIST_PAGES 上限。触及上限时用 console.warn **显式**记录
 *   截断（照 memory「no silent caps」——绝不静默丢数据）。
 *
 * 凭据缺失：getInstallationToken() 在本租户无 App 凭据时会抛错（Task 5）。
 *   本 port 把该错误包一层"GitHub 未连接"语义再上抛，让上层能清晰区分
 *   "未接 GitHub"与"接了但请求失败"，而不是裸抛底层错误。
 */

import { githubFetch, type GithubFetchOptions } from './github-http.js';
import type { GitHubAuthManager } from './github-auth-manager.js';

/** 公有云 API base（GHE 场景由 deps.apiBase 覆盖）。 */
const PUBLIC_API_BASE = 'https://api.github.com';

/** 分页封顶页数：防止无限分页拖垮学习摄入；触顶显式 warn（不静默截断）。 */
export const MAX_LIST_PAGES = 10;

/** 每页条数（GitHub 上限 100）。取满以尽量少翻页。 */
const PER_PAGE = 100;

/** 学习段消费的精简 issue。仅取长记忆需要的字段，不映射 GitHub 巨型响应。 */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
  /**
   * 讨论评论数（GitHub 列表响应自带，零额外成本）。
   * 为 0 时跳过评论抓取——省一次 API 请求，是组织级同步的关键省配额闸。
   */
  comments: number;
}

/** 学习段消费的精简 PR。 */
export interface GitHubPull {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
  filesChanged?: string[];
}

/** 学习段消费的精简 commit。 */
export interface GitHubCommit {
  sha: string;
  message: string;
  committedAt: string;
}

/** 仓库目录树：仅文件（blob）路径清单 + 树根 SHA。 */
export interface GitHubTree {
  sha: string;
  paths: string[];
}

/**
 * GitHub 只读接口。只有 list/get 读方法——绝无写方法（写侧属 Plan 4
 * GitHubWritePort）。
 */
export interface GitHubReadPort {
  /** 列 issues（按 updated 排序，since 过滤更新时间下界）。 */
  listIssues(repo: string, since?: string): Promise<GitHubIssue[]>;
  /** 列 pull requests。 */
  listPulls(repo: string, since?: string): Promise<GitHubPull[]>;
  /** 列 commits（since 过滤提交时间下界）。 */
  listCommits(repo: string, since?: string): Promise<GitHubCommit[]>;
  /** 拉仓库默认分支的完整目录树（递归，仅返回文件路径）。 */
  getRepoTree(repo: string): Promise<GitHubTree>;
  /** 读单个文件内容（自动解 base64）。 */
  getFileContent(repo: string, path: string): Promise<string>;
  /**
   * 列某 issue 的讨论评论正文（丢弃空正文）。讨论串是组织信息密度最高的知识——
   * 「这个问题最后怎么定的」只存在于评论里，标题正文答不了。
   */
  listIssueComments(repo: string, issueNumber: number): Promise<string[]>;
  /** 列某 PR 的 review 意见正文（丢弃空正文）。 */
  listPullReviewComments(repo: string, pullNumber: number): Promise<string[]>;
}

/** GitHubReadPortImpl 的可选依赖（默认走公有云 + 真 githubFetch）。 */
export interface GitHubReadPortDeps {
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

export class GitHubReadPortImpl implements GitHubReadPort {
  private readonly auth: GitHubAuthManager;
  private readonly fetchImpl: typeof githubFetch;
  private readonly apiBase: string;
  private readonly fetchOpts: GithubFetchOptions | undefined;

  constructor(auth: GitHubAuthManager, deps: GitHubReadPortDeps = {}) {
    this.auth = auth;
    this.fetchImpl = deps.fetchImpl ?? githubFetch;
    this.apiBase = (deps.apiBase ?? PUBLIC_API_BASE).replace(/\/+$/, '');
    this.fetchOpts = deps.hostAllowlist ? { hostAllowlist: deps.hostAllowlist } : undefined;
  }

  async listIssues(repo: string, since?: string): Promise<GitHubIssue[]> {
    const url = this.buildListUrl(repo, 'issues', since, { sort: 'updated', direction: 'asc' });
    const raw = await this.fetchAllPages(url);
    /* GitHub 的 /issues 端点会把 PR 也当 issue 返回（带 pull_request 字段）；
     * 学习段只要真 issue，过滤掉 PR。 */
    return raw
      .filter((item) => (item as Record<string, unknown>).pull_request === undefined)
      .map((item) => this.mapIssue(item));
  }

  async listPulls(repo: string, since?: string): Promise<GitHubPull[]> {
    /* /pulls 端点无 since 参数；按 updated 升序拉取，本地用 since 过滤更新时间。 */
    const url = this.buildListUrl(repo, 'pulls', undefined, {
      state: 'all',
      sort: 'updated',
      direction: 'asc',
    });
    const raw = await this.fetchAllPages(url);
    const pulls = raw.map((item) => this.mapPull(item));
    if (!since) {
      return pulls;
    }
    const floor = Date.parse(since);
    if (Number.isNaN(floor)) {
      return pulls;
    }
    return pulls.filter((p) => {
      const t = Date.parse(p.updatedAt);
      return Number.isNaN(t) ? true : t >= floor;
    });
  }

  async listCommits(repo: string, since?: string): Promise<GitHubCommit[]> {
    const url = this.buildListUrl(repo, 'commits', since);
    const raw = await this.fetchAllPages(url);
    return raw.map((item) => this.mapCommit(item));
  }

  async getRepoTree(repo: string): Promise<GitHubTree> {
    /* 两跳：先查 repo 拿 default_branch，再按该分支拉递归树。 */
    const repoInfo = await this.fetchJson<{ default_branch?: string }>(
      `${this.apiBase}/repos/${repo}`,
    );
    const branch = repoInfo.default_branch ?? 'main';
    const tree = await this.fetchJson<{
      sha?: string;
      tree?: Array<{ path?: string; type?: string }>;
      truncated?: boolean;
    }>(`${this.apiBase}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);

    /* GitHub 对超大树会 truncated=true——显式 warn，不静默给残缺树。 */
    if (tree.truncated) {
      console.warn(
        `[GitHubReadPort] getRepoTree(${repo}) 目录树被 GitHub 截断（truncated=true），返回的 paths 不完整`,
      );
    }
    const paths = (tree.tree ?? [])
      .filter((node) => node.type === 'blob' && typeof node.path === 'string')
      .map((node) => node.path as string);
    return { sha: tree.sha ?? '', paths };
  }

  async getFileContent(repo: string, path: string): Promise<string> {
    /* contents 端点对 path 逐段编码（保留 '/' 分隔），避免含空格/中文路径被拒。 */
    const encodedPath = path
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const body = await this.fetchJson<{ content?: string; encoding?: string }>(
      `${this.apiBase}/repos/${repo}/contents/${encodedPath}`,
    );
    if (body.encoding === 'base64' && typeof body.content === 'string') {
      /* GitHub 把 base64 内容按 76 列折行，Buffer 能容忍换行；去空白更稳。 */
      return Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8');
    }
    /* 少数情况（如空文件）content 为空串；非 base64 直接返回原文。 */
    return typeof body.content === 'string' ? body.content : '';
  }

  async listIssueComments(repo: string, issueNumber: number): Promise<string[]> {
    return this.listComments(`${this.apiBase}/repos/${repo}/issues/${issueNumber}/comments`);
  }

  async listPullReviewComments(repo: string, pullNumber: number): Promise<string[]> {
    return this.listComments(`${this.apiBase}/repos/${repo}/pulls/${pullNumber}/comments`);
  }

  /**
   * 评论抓取公共实现：带 per_page 沿 Link header 跟随分页拉全量，只取正文字符串。
   *
   * 丢弃空正文/缺 body 的条目——mapper 的 summarizeComments 只消费有内容的讨论要点，
   * 空条目混进去会挤占 MAX_COMMENTS 名额，把真正的结论挤出表征。
   */
  private async listComments(baseUrl: string): Promise<string[]> {
    const url = new URL(baseUrl);
    url.searchParams.set('per_page', String(PER_PAGE));
    const raw = await this.fetchAllPages(url.toString());
    return raw
      .map((item) => (item as Record<string, unknown>).body)
      .filter((body): body is string => typeof body === 'string' && body.trim().length > 0);
  }

  /** 拼 list 端点 URL（含 per_page、since、以及额外 query）。 */
  private buildListUrl(
    repo: string,
    endpoint: string,
    since: string | undefined,
    extra: Record<string, string> = {},
  ): string {
    const url = new URL(`${this.apiBase}/repos/${repo}/${endpoint}`);
    url.searchParams.set('per_page', String(PER_PAGE));
    if (since) {
      url.searchParams.set('since', since);
    }
    for (const [k, v] of Object.entries(extra)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  /**
   * 沿 Link header rel="next" 循环拉取所有页，合并成一个数组。触及
   * MAX_LIST_PAGES 上限时显式 warn 并停止（不静默丢数据）。
   */
  private async fetchAllPages(firstUrl: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let nextUrl: string | undefined = firstUrl;
    let page = 0;

    while (nextUrl) {
      if (page >= MAX_LIST_PAGES) {
        console.warn(
          `[GitHubReadPort] 分页已达上限 MAX_LIST_PAGES=${MAX_LIST_PAGES}，停止翻页；` +
            `尚有后续页未拉取（下一页：${nextUrl}）——结果被截断。`,
        );
        break;
      }
      const res = await this.request(nextUrl);
      const body = (await res.json()) as unknown;
      if (Array.isArray(body)) {
        all.push(...body);
      }
      page += 1;
      nextUrl = parseNextLink(res.headers.get('link'));
    }
    return all;
  }

  /** 拉单个 JSON 端点（非分页），解析为期望形状。 */
  private async fetchJson<T>(url: string): Promise<T> {
    const res = await this.request(url);
    return (await res.json()) as T;
  }

  /**
   * 发一次 GitHub 读请求：取 token（Task 5）→ 经 githubFetch（Task 4）→
   * 非 2xx 抛错。token 获取失败（无凭据）时包一层"未连接"语义再上抛。
   */
  private async request(url: string): Promise<Response> {
    let token: string;
    try {
      token = await this.auth.getInstallationToken();
    } catch (cause) {
      /* getApp 无凭据 / 换 token 失败：让"GitHub 未连接"语义清晰浮现，
       * 保留原始 cause 便于排查。 */
      throw new Error(
        `GitHubReadPort：GitHub 未连接或凭据无效，无法读取（${
          cause instanceof Error ? cause.message : String(cause)
        }）`,
        { cause: cause instanceof Error ? cause : undefined },
      );
    }

    const res = await this.fetchImpl(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
        },
      },
      this.fetchOpts,
    );
    if (!res.ok) {
      throw new Error(`GitHubReadPort：读取 GitHub 失败（HTTP ${res.status}）：${url}`);
    }
    return res;
  }

  /** issue 精简映射：仅取 number/title/body/updatedAt。 */
  private mapIssue(item: unknown): GitHubIssue {
    const o = item as Record<string, unknown>;
    return {
      number: Number(o.number),
      title: typeof o.title === 'string' ? o.title : '',
      body: typeof o.body === 'string' ? o.body : '',
      updatedAt: typeof o.updated_at === 'string' ? o.updated_at : '',
      comments: typeof o.comments === 'number' ? o.comments : 0,
    };
  }

  /** PR 精简映射：字段同 issue，额外可选 filesChanged（若响应带 files）。 */
  private mapPull(item: unknown): GitHubPull {
    const o = item as Record<string, unknown>;
    const pull: GitHubPull = {
      number: Number(o.number),
      title: typeof o.title === 'string' ? o.title : '',
      body: typeof o.body === 'string' ? o.body : '',
      updatedAt: typeof o.updated_at === 'string' ? o.updated_at : '',
    };
    /* 列表端点通常不含 files；若上游附带 files 数组则取其文件名，否则留空。 */
    if (Array.isArray(o.files)) {
      pull.filesChanged = o.files
        .map((f) => (f as Record<string, unknown>).filename)
        .filter((n): n is string => typeof n === 'string');
    }
    return pull;
  }

  /** commit 精简映射：sha + commit.message + commit.committer.date。 */
  private mapCommit(item: unknown): GitHubCommit {
    const o = item as Record<string, unknown>;
    const commit = (o.commit ?? {}) as Record<string, unknown>;
    const committer = (commit.committer ?? {}) as Record<string, unknown>;
    return {
      sha: typeof o.sha === 'string' ? o.sha : '',
      message: typeof commit.message === 'string' ? commit.message : '',
      committedAt: typeof committer.date === 'string' ? committer.date : '',
    };
  }
}

/**
 * 从 GitHub 的 Link header 里解析 rel="next" 的 URL。无 header 或无 next
 * 返回 undefined。
 *
 * Link header 形如：
 *   <https://api.github.com/...?page=2>; rel="next", <...?page=5>; rel="last"
 */
function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}
