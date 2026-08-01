/**
 * GitHubLearningService — GitHub 学习段的**编排核心**（Plan 2 spec §5）。
 *
 * 串起学习段全部组件：ReadPort 拉取 → 增量过滤（游标）→ Mapper 映射 → digest 原子 claim →
 * 抢到才 perceive 摄入 → markIngested → **全批成功才推进游标**。本类不含新领域逻辑（映射在
 * Task 4 mapper、摄入在 PerceptionDistiller、幂等/游标在 Task 3 store），只做确定性编排。
 *
 * 两条铁律：
 *   ① 增量去重（spec ⑦b）：每条内容先 `store.claimDigest`（INSERT ON CONFLICT DO NOTHING 原子占位）——
 *      claim=false（已摄入过）**直接跳过，绝不再 perceive**（重复灌记忆是核心要防的）；claim=true 才
 *      perceive + markIngested。故重复 learn 同内容时 perceive 零调用。
 *   ② 失败不推进游标（spec ⑦）：某 resourceType 处理中若 perceive **抛错**，捕获后该 resourceType
 *      **不 advanceCursor**（游标停在旧值）。下次重拉会重新走一遍，已 ingested 的条目靠 digest
 *      claim=false 跳过，不重灌——digest 账本兜住幂等，游标只在全批成功后前移。
 *
 * 零-LLM 铁律：本 service 绝不直接调 LLM——LLM 老师是 perceive 里 provider（PerceptionDistiller
 *   构造时注入的 BYOK provider，Task 6 端点提供）的事。service 只编排确定性步骤（拉取/映射/claim/游标）。
 *
 * 游标锚（spec：commit 用时间戳锚）：
 *   - issues / pulls：游标 = 本批最新条目的 updatedAt（ReadPort 按 updated 升序返回）。
 *   - commits：游标 = 本批最新条目的 committedAt（GitHub commits 的 since 是时间戳，非 SHA）。
 *   - code：无增量 API（单次目录树快照），游标 = 本次运行时间戳（记录 last-synced，仅供审计）。
 */

import type { GitHubReadPort, GitHubCommit } from './github-read-port.js';
import type { GithubLearnStore } from '../../storage/github-learn-store.js';
import type { PerceptionDistiller } from '../../perception/perception-distiller.js';
import type { MappedLearning } from './github-learning-mapper.js';
import { mapIssue, mapPull, mapCommits, mapCodeAndReadme } from './github-learning-mapper.js';

/** 学习段支持的资源类型（spec §5.1）。 */
export type GitHubResourceType = 'code' | 'issues' | 'pulls' | 'commits';

/** learn 的聚合结果（跨全部 resourceType 汇总）。 */
export interface LearnGithubResult {
  /** 新摄入（claim 抢到并成功 perceive+markIngested）的条数。 */
  ingested: number;
  /** 已摄入过被跳过（claim=false）的条数。 */
  skipped: number;
  /** 是否至少推进了一个 resourceType 的游标（全批成功才推进）。 */
  cursorAdvanced: boolean;
}

/** README 候选文件名（大小写/扩展变体），按序尝试第一个能读到的。 */
const README_CANDIDATES = ['README.md', 'README', 'readme.md'];

export interface GitHubLearningServiceDeps {
  readPort: GitHubReadPort;
  store: GithubLearnStore;
  distiller: PerceptionDistiller;
  tenantId: string;
  personaId: string;
  /**
   * 记忆图句柄（演进式取代需删同讨论的旧记忆）。收窄成只含 deleteMemory 的结构类型——
   * 本 service 无权做记忆图的其它任何操作，类型即权限边界。
   */
  memories: { deleteMemory(id: string): boolean };
}

export class GitHubLearningService {
  private readonly readPort: GitHubReadPort;
  private readonly store: GithubLearnStore;
  private readonly distiller: PerceptionDistiller;
  private readonly tenantId: string;
  private readonly personaId: string;
  private readonly memories: { deleteMemory(id: string): boolean };

  constructor(deps: GitHubLearningServiceDeps) {
    this.readPort = deps.readPort;
    this.store = deps.store;
    this.distiller = deps.distiller;
    this.tenantId = deps.tenantId;
    this.personaId = deps.personaId;
    this.memories = deps.memories;
  }

  /**
   * 学一个 repo 的指定资源类型。逐 resourceType 独立处理（一类 perceive 抛错不影响其它类
   * 的游标推进），聚合 ingested/skipped/cursorAdvanced 返回。
   */
  async learn(repo: string, resourceTypes: GitHubResourceType[]): Promise<LearnGithubResult> {
    let ingested = 0;
    let skipped = 0;
    let cursorAdvanced = false;

    for (const resourceType of resourceTypes) {
      const outcome = await this.learnOne(repo, resourceType);
      ingested += outcome.ingested;
      skipped += outcome.skipped;
      cursorAdvanced = cursorAdvanced || outcome.cursorAdvanced;
    }

    return { ingested, skipped, cursorAdvanced };
  }

  /**
   * 处理单个 resourceType：读游标 → 拉取（带 since）→ 逐条 map+claim+perceive+markIngested →
   * 全批成功才 advanceCursor。任一条 perceive 抛错 → 捕获、不推进游标（已处理的靠 digest 幂等）。
   */
  private async learnOne(
    repo: string,
    resourceType: GitHubResourceType,
  ): Promise<{ ingested: number; skipped: number; cursorAdvanced: boolean }> {
    const since = this.store.getCursor(this.personaId, repo, resourceType)?.cursor ?? undefined;

    /* 拉取 + 映射：产出「映射结果 + 该批新游标锚」。code 无 since（单次快照）。 */
    let batch: { items: MappedLearning[]; newCursor: string | null };
    try {
      batch = await this.fetchAndMap(repo, resourceType, since);
    } catch {
      /* 拉取/映射失败：不推进游标（下次重拉），本类 0 摄入。 */
      return { ingested: 0, skipped: 0, cursorAdvanced: false };
    }

    let ingested = 0;
    let skipped = 0;
    try {
      for (const mapped of batch.items) {
        const now = Date.now();
        /* 原子占位：claim=false 表示已摄入过 → 跳过，绝不再 perceive（增量去重核心）。 */
        const claimed = this.store.claimDigest(
          this.personaId,
          repo,
          resourceType,
          mapped.contentSha,
          now,
          mapped.discussionKey,
        );
        if (!claimed) {
          skipped += 1;
          continue;
        }
        /* 取代前先记下旧记忆 ID 组——**新记忆沉淀成功后才删**，中途失败不致知识净损失。 */
        const previousMemoryIds = mapped.discussionKey
          ? this.store.findMemoryIdsByDiscussionKey(this.personaId, mapped.discussionKey)
          : [];

        /* 抢到才摄入：audio 壳范式喂进感知蒸馏管线（与 learn-topic 同款）。 */
        const result = await this.distiller.perceive({
          personaId: this.personaId,
          tenantId: this.tenantId,
          media: {
            modality: 'audio',
            mediaSha256: mapped.contentSha,
            durationMs: 0,
            representation: mapped.representation,
          },
        });

        /* 演进式取代：记新指针组 + 删旧记忆组，使同一 issue/PR 恒为最新一版共识。
         * 仅当 perceive 真产出新记忆时才取代——空产出（老师失败/无事实）时保留旧记忆，
         * 宁可留旧共识也不能把已有知识删成空白。
         * 注意 perceive 把一条表征切成**多条**事实记忆（标题/正文/讨论各一条），故整组进出。 */
        if (mapped.discussionKey && result.memoryIds.length > 0) {
          this.store.recordMemoryIds(this.personaId, repo, resourceType, mapped.contentSha, result.memoryIds, Date.now());
          const fresh = new Set(result.memoryIds);
          for (const oldId of previousMemoryIds) {
            /* 排除本轮刚产出的 ID（理论上不重叠，防御性守卫——绝不删刚写入的新记忆）。 */
            if (!fresh.has(oldId)) this.memories.deleteMemory(oldId);
          }
        }

        this.store.markIngested(this.personaId, repo, resourceType, mapped.contentSha, Date.now());
        ingested += 1;
      }
    } catch {
      /* perceive（或 markIngested）抛错：不推进游标。下次重拉，已 ingested 条靠 digest claim=false 跳过。 */
      return { ingested, skipped, cursorAdvanced: false };
    }

    /* 全批成功才推进游标（spec ⑦）。newCursor 为空（空批）则不推进。 */
    if (batch.newCursor !== null) {
      this.store.advanceCursor(this.personaId, repo, resourceType, batch.newCursor, Date.now());
      return { ingested, skipped, cursorAdvanced: true };
    }
    return { ingested, skipped, cursorAdvanced: false };
  }

  /**
   * 按 resourceType 拉取并映射成统一的 MappedLearning 列表，同时算出该批的新游标锚
   * （issues/pulls 用 updatedAt 最大值，commits 用 committedAt 最大值，code 用运行时间戳）。
   */
  private async fetchAndMap(
    repo: string,
    resourceType: GitHubResourceType,
    since: string | undefined,
  ): Promise<{ items: MappedLearning[]; newCursor: string | null }> {
    switch (resourceType) {
      case 'issues': {
        const issues = await this.readPort.listIssues(repo, since);
        const items: MappedLearning[] = [];
        for (const issue of issues) {
          /* 省配额闸二：评论计数为 0 直接跳过，不发请求（闸一是上面的增量游标 since——
           * 只有本轮有更新的 issue 才走到这里）。组织级同步时这两道闸决定 API 调用量量级。 */
          const comments = issue.comments > 0
            ? await this.safeListIssueComments(repo, issue.number)
            : [];
          const mapped = mapIssue(repo, issue, comments);
          items.push({ ...mapped, discussionKey: discussionKeyOf('issues', repo, issue.number) });
        }
        return { items, newCursor: maxUpdatedAt(issues) };
      }
      case 'pulls': {
        const pulls = await this.readPort.listPulls(repo, since);
        const items: MappedLearning[] = [];
        for (const pull of pulls) {
          /* PR 列表响应无 review 评论计数字段，无法像 issue 那样零成本预判，故一律抓取。 */
          const reviewComments = await this.safeListPullReviewComments(repo, pull.number);
          const mapped = mapPull(repo, pull, reviewComments);
          items.push({ ...mapped, discussionKey: discussionKeyOf('pulls', repo, pull.number) });
        }
        return { items, newCursor: maxUpdatedAt(pulls) };
      }
      case 'commits': {
        const commits = await this.readPort.listCommits(repo, since);
        if (commits.length === 0) {
          return { items: [], newCursor: null };
        }
        /* commits 聚合成一条表征（mapper 聚合近期 message）。游标=最新 committedAt（时间戳锚）。 */
        const items = [mapCommits(repo, commits)];
        return { items, newCursor: maxCommittedAt(commits) };
      }
      case 'code': {
        const tree = await this.readPort.getRepoTree(repo);
        const readme = await this.readReadme(repo);
        /* ReadPort 无语言 API，lang 交给 mapper 默认（'未知语言'）；code 无增量 API，游标=运行时间戳。 */
        const items = [mapCodeAndReadme(repo, tree, readme, '')];
        return { items, newCursor: new Date().toISOString() };
      }
    }
  }

  /**
   * 抓 issue 讨论评论；失败降级为空数组——一条坏数据（权限/限流/删帖）不该阻塞整个 repo 的学习。
   * 降级后该条记忆退回「（暂无讨论）」，下轮 issue 有更新时会重新尝试。
   */
  private async safeListIssueComments(repo: string, issueNumber: number): Promise<string[]> {
    try {
      return await this.readPort.listIssueComments(repo, issueNumber);
    } catch {
      return [];
    }
  }

  /** 抓 PR review 意见；失败降级为空数组，理由同 safeListIssueComments。 */
  private async safeListPullReviewComments(repo: string, pullNumber: number): Promise<string[]> {
    try {
      return await this.readPort.listPullReviewComments(repo, pullNumber);
    } catch {
      return [];
    }
  }

  /** 按候选文件名依序读 README；任一读失败/不存在则试下一个，全失败返回空串。 */
  private async readReadme(repo: string): Promise<string> {
    for (const name of README_CANDIDATES) {
      try {
        const content = await this.readPort.getFileContent(repo, name);
        if (content.trim().length > 0) {
          return content;
        }
      } catch {
        /* 该候选不存在/读失败：试下一个，不中断 code 学习。 */
      }
    }
    return '';
  }
}

/**
 * 讨论稳定标识：形如 `issues:acme/widget#42`。同一 issue/PR 跨轮次恒定，与表征 sha 无关。
 *
 * 为什么需要它：contentSha = sha256(representation)，讨论新增一条评论就换新 sha，
 * 按 sha 无法认出「这还是那个 issue」。演进式取代必须有一个不随内容变化的锚。
 */
function discussionKeyOf(resourceType: GitHubResourceType, repo: string, num: number): string {
  return `${resourceType}:${repo}#${num}`;
}

/** 取一批 issue/pull 的最大 updatedAt 作游标锚；空批返回 null（不推进）。 */
function maxUpdatedAt(items: Array<{ updatedAt: string }>): string | null {
  return maxByTimestamp(items.map((i) => i.updatedAt));
}

/** 取一批 commit 的最大 committedAt 作游标锚（GitHub commits since 是时间戳）；空批返回 null。 */
function maxCommittedAt(commits: GitHubCommit[]): string | null {
  return maxByTimestamp(commits.map((c) => c.committedAt));
}

/**
 * 从一组 ISO 时间戳里取「最新」的一个（按 Date.parse 比较）。忽略空串/不可解析项；
 * 全为空/无有效项返回 null（视为空批，不推进游标）。
 */
function maxByTimestamp(stamps: string[]): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const s of stamps) {
    if (!s) continue;
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = s;
    }
  }
  return best;
}
