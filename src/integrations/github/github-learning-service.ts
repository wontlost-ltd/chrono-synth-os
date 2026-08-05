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
import { PartialPerceptionError } from '../../perception/perception-distiller.js';
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

/**
 * 组织轮转游标的哨兵 resource_type。与四类真实资源（code/issues/pulls/commits）区分，
 * 复用 github_learn_state 存「下一个起始下标」（迁移 v126 已扩 CHECK 容纳该值）。
 */
export const ORG_ROTATION_RESOURCE_TYPE = '_org_rotation';

/**
 * 单轮最多处理几个仓库。轮转的意义就在这个上限——它使**单轮成本恒定**，不随组织规模膨胀，
 * 从而不触发 GitHub 二级速率限制、不一次性烧光 LLM 老师额度。
 */
export const DEFAULT_MAX_REPOS_PER_RUN = 5;

/** learnOrg 单轮结果。 */
export interface LearnOrgResult {
  /** 本轮实际学习的仓库全名（按处理顺序）。 */
  reposProcessed: string[];
  /** 本轮跨全部仓库新摄入条数。 */
  ingested: number;
  /** 本轮跨全部仓库跳过（已摄入过）条数。 */
  skipped: number;
  /** 本轮抛出不可预期异常的仓库（learn 内部已逐类吞异常，正常为空）。 */
  failedRepos: string[];
  /** 推进后的组织轮转游标（下一轮起始下标；已回绕）。 */
  nextCursor: number;
}

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
  /**
   * 可选日志。唯一用途：占位释放彻底失败时留痕——那意味着一条内容将被永久跳过，
   * 静默发生比失败本身更糟。收窄成只含 error 的结构类型（类型即权限边界）。
   */
  logger?: { error?(scope: string, message: string): void };
}

export class GitHubLearningService {
  private readonly readPort: GitHubReadPort;
  private readonly store: GithubLearnStore;
  private readonly distiller: PerceptionDistiller;
  private readonly tenantId: string;
  private readonly personaId: string;
  private readonly memories: { deleteMemory(id: string): boolean };
  private readonly logger?: { error?(scope: string, message: string): void };

  constructor(deps: GitHubLearningServiceDeps) {
    this.readPort = deps.readPort;
    this.store = deps.store;
    this.distiller = deps.distiller;
    this.tenantId = deps.tenantId;
    this.personaId = deps.personaId;
    this.memories = deps.memories;
    this.logger = deps.logger;
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
   * 学一个组织（installation 授权范围）的仓库，**轮转推进**：每轮只处理 maxReposPerRun 个，
   * 用组织游标记住下次从哪开始，绕完一圈回到开头。
   *
   * 为什么轮转而非一次学完：一个 50 仓库的组织单轮就是几百次 API 调用 + 几百次 LLM 老师调用，
   * 会触发 GitHub 二级速率限制并烧光额度。轮转使**单轮成本恒定可预测**，大组织只是周期更长。
   *
   * 游标推进语义：无论各 repo 成败都推进——否则一个持续失败的 repo 会永久卡住整个组织的轮转。
   * 已成功摄入的内容靠 digest 账本保证回绕后不重复灌。
   */
  async learnOrg(
    orgKey: string,
    resourceTypes: GitHubResourceType[],
    maxReposPerRun: number = DEFAULT_MAX_REPOS_PER_RUN,
  ): Promise<LearnOrgResult> {
    const repos = await this.readPort.listInstallationRepos();
    if (repos.length === 0) {
      return { reposProcessed: [], ingested: 0, skipped: 0, failedRepos: [], nextCursor: 0 };
    }

    /* 读组织轮转游标（哨兵行）。非法/缺失 → 从 0 开始；越界（授权仓库变少）→ 收敛回 0。 */
    const raw = this.store.getCursor(this.personaId, orgKey, ORG_ROTATION_RESOURCE_TYPE)?.cursor;
    const parsed = raw === undefined || raw === null ? 0 : Number.parseInt(raw, 10);
    const start = Number.isInteger(parsed) && parsed >= 0 && parsed < repos.length ? parsed : 0;

    const slice = repos.slice(start, start + maxReposPerRun);

    const reposProcessed: string[] = [];
    const failedRepos: string[] = [];
    let ingested = 0;
    let skipped = 0;
    for (const repo of slice) {
      try {
        const outcome = await this.learn(repo, resourceTypes);
        ingested += outcome.ingested;
        skipped += outcome.skipped;
        reposProcessed.push(repo);
      } catch {
        /* 兜底：learn 内部已逐 resourceType 吞异常，此处防不可预期的异常中断整轮。 */
        failedRepos.push(repo);
      }
    }

    /* 推进游标：走到尾部则回绕到 0（下轮重新从头增量扫，未变内容靠 digest 全 skip）。 */
    const advanced = start + slice.length;
    const nextCursor = advanced >= repos.length ? 0 : advanced;
    this.store.advanceCursor(
      this.personaId, orgKey, ORG_ROTATION_RESOURCE_TYPE, String(nextCursor), Date.now(),
    );

    return { reposProcessed, ingested, skipped, failedRepos, nextCursor };
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

      /* 释放占位的窗口 = claim 之后、**记忆落库之前**的全部步骤，这是分界线：
       *   - 本窗口内抛错 → 尚无任何记忆落库，释放占位是安全的，否则该内容永久跳过；
       *   - perceive 成功之后的任何步骤抛错 → 记忆**已经写入**，此时释放占位会让下一轮
       *     重新 perceive，凭空生成第二套记忆。宁可留下 claimed 占位（该条本轮不再
       *     重学，但已有记忆完好），也不能制造重复知识。
       * 故绝不可把整段循环体裹进同一个 catch；旧记忆查询虽在 perceive 之前，
       * 也必须落在本窗口内——它同样发生在 claim 之后，抛错会同样泄漏占位。 */
      let result: Awaited<ReturnType<typeof this.distiller.perceive>>;
      let previousMemoryIds: readonly string[];
      try {
        /* 取代前先记下旧记忆 ID 组——**新记忆沉淀成功后才删**，中途失败不致知识净损失。 */
        previousMemoryIds = mapped.discussionKey
          ? this.store.findMemoryIdsByDiscussionKey(this.personaId, mapped.discussionKey)
          : [];

        /* 抢到才摄入：audio 壳范式喂进感知蒸馏管线（与 learn-topic 同款）。 */
        result = await this.distiller.perceive({
          personaId: this.personaId,
          tenantId: this.tenantId,
          media: {
            modality: 'audio',
            mediaSha256: mapped.contentSha,
            durationMs: 0,
            representation: mapped.representation,
          },
        });
      } catch (err) {
        /* 只有**确无记忆落库**时才释放占位。perceive 的记忆写入逐条独立、无事务，
         * 中途失败会留下部分记忆——此时释放占位等于允许下一轮重新摄入，为已落库的
         * 部分再生成一套重复记忆。PartialPerceptionError 正是用来区分这两种失败。 */
        const partial = err instanceof PartialPerceptionError && err.writtenMemoryIds.length > 0;
        if (!partial) {
          this.releaseClaimDurably(repo, resourceType, mapped.contentSha);
        }
        /* 不推进游标。下次重拉，已 ingested 条靠 digest claim=false 跳过。 */
        return { ingested, skipped, cursorAdvanced: false };
      }

      /* 老师瞬时故障（analyze 抛错）→ perceive 降级返回空结果 + teacherFailed=true。
       * 此时**没有任何记忆落库**，若照常 markIngested，该内容会被永久标为已摄入，
       * 下一轮 claim=false 而永远学不到——一次网关抖动就能静默烧掉一条内容。
       * 故与「无记忆落库」的其它失败同等对待：释放占位，留待下一轮重试。
       * 注意与「老师成功但无有效事实」区分：那是正常无沉淀（teacherFailed=false），
       * 内容确实没有可记的东西，应当标记 ingested 以免每轮重复询问老师。 */
      if (result.teacherFailed) {
        this.releaseClaimDurably(repo, resourceType, mapped.contentSha);
        return { ingested, skipped, cursorAdvanced: false };
      }

      /* 以下为 perceive 成功后的收尾——记忆已落库，**不再释放占位**。
       * 收尾失败时占位保持 claimed：内容不重复灌入，且已写入的记忆完整保留。 */
      try {
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
      } catch {
        /* 收尾失败：记忆已在库，占位保持 claimed（不释放）。不推进游标。 */
        return { ingested, skipped, cursorAdvanced: false };
      }
    }

    /* 全批成功才推进游标（spec ⑦）。newCursor 为空（空批）则不推进。 */
    if (batch.newCursor !== null) {
      this.store.advanceCursor(this.personaId, repo, resourceType, batch.newCursor, Date.now());
      return { ingested, skipped, cursorAdvanced: true };
    }
    return { ingested, skipped, cursorAdvanced: false };
  }

  /**
   * 释放摘要占位（无记忆落库的失败路径统一走这里）。
   *
   * 为什么要重试：占位释放失败的后果是该条内容**永久跳过**（下一轮 claim=false，
   * 且账本没有 lease/超时回收机制）。释放是幂等的单条 DELETE，短暂故障（锁竞争、
   * 瞬时 I/O）重试即可收敛，因此不接受一次失败就放弃。
   *
   * 仍然不抛出：调用方已经在失败路径上，释放失败不应掩盖原始故障。改为返回布尔值
   * 并写日志，让「永久跳过」至少是**可观测**的，而不是静默发生。
   */
  private releaseClaimDurably(repo: string, resourceType: string, contentSha: string): boolean {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        this.store.releaseDigestClaim(this.personaId, repo, resourceType, contentSha);
        return true;
      } catch (err) {
        lastErr = err;
      }
    }
    /* 三次仍失败：该条内容将被永久跳过。必须留下可检索的痕迹。 */
    this.logger?.error?.(
      'GitHubLearningService',
      `释放摘要占位失败，内容将被永久跳过（repo=${repo} type=${resourceType} sha=${contentSha}）：` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
    return false;
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
