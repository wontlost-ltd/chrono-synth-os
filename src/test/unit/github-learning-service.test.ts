/**
 * GitHubLearningService（学习段编排核心）：拉取 → 增量过滤 → 映射 → digest 原子 claim →
 * 抢到才 perceive 摄入 → markIngested → 全批成功才推进游标。
 *
 * 断言重点（spec ⑦ / ⑦b——增量去重 + 失败不推进）：
 *   1. 首次 learn issues：ReadPort 拉 → mapper 映射 → claimDigest 抢到 → perceive 被调 →
 *      markIngested → digest 记 ingested；全批成功后 advanceCursor 推进游标（cursorAdvanced=true）。
 *   2. 重复 learn 同内容：第二次每条 claimDigest 全 false（已摄入）→ 全部计 skipped，
 *      perceive **不再被调**（增量去重端到端——避免重复灌记忆）。
 *   3. perceive 抛错：该 resourceType 不 advanceCursor（游标停在旧值），
 *      下次重拉靠 digest claim 兜幂等，不重灌。
 *
 * 用真 GithubLearnStore on createMemoryDatabase()（真幂等账本 + 真游标表），
 * mock readPort（返固定条目）+ mock distiller（记录调用次数 / 可注入抛错）。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { GithubLearnStore } from '../../storage/github-learn-store.js';
import { GitHubLearningService } from '../../integrations/github/github-learning-service.js';
import type {
  GitHubReadPort,
  GitHubIssue,
  GitHubPull,
  GitHubCommit,
  GitHubTree,
} from '../../integrations/github/github-read-port.js';
import type { PerceptionDistiller } from '../../perception/perception-distiller.js';
import type {
  PerceptionDistillInput,
  PerceptionDistillResult,
} from '../../perception/perception-distiller.js';
import { PartialPerceptionError } from '../../perception/perception-distiller.js';

const TENANT = 'tenant_a';
const PERSONA = 'persona_1';
const REPO = 'acme/repo';

/** 固定两条 issue（updatedAt 递增，供游标推进断言）。 */
const ISSUES: GitHubIssue[] = [
  { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
  { number: 2, title: '性能优化', body: '列表页加载慢', updatedAt: '2026-01-02T00:00:00Z', comments: 0 },
];

/** 只实现 learn 用到的方法；未用到的读方法抛错（不该被调）。 */
function makeReadPort(overrides: Partial<GitHubReadPort> = {}): GitHubReadPort {
  return {
    listIssues: async (): Promise<GitHubIssue[]> => ISSUES,
    listPulls: async (): Promise<GitHubPull[]> => {
      throw new Error('listPulls 不该被调');
    },
    listCommits: async (): Promise<GitHubCommit[]> => {
      throw new Error('listCommits 不该被调');
    },
    getRepoTree: async (): Promise<GitHubTree> => {
      throw new Error('getRepoTree 不该被调');
    },
    getFileContent: async (): Promise<string> => {
      throw new Error('getFileContent 不该被调');
    },
    /* 缺省无讨论；需要讨论内容的用例经 overrides 注入。 */
    listIssueComments: async (): Promise<string[]> => [],
    listPullReviewComments: async (): Promise<string[]> => [],
    /* 组织级驻留：缺省无授权仓库；需要枚举的用例经 overrides 注入。 */
    listInstallationRepos: async (): Promise<string[]> => [],
    ...overrides,
  };
}

/** 假记忆图：只暴露 deleteMemory（service 类型边界即此），记录被删的记忆 ID。 */
function fakeMemories(deleted: string[] = []): { deleteMemory(id: string): boolean } {
  return { deleteMemory: (id: string): boolean => { deleted.push(id); return true; } };
}

/** mock distiller：记录 perceive 调用（可注入抛错）。 */
interface DistillerSpy {
  distiller: PerceptionDistiller;
  calls: PerceptionDistillInput[];
}
function makeDistiller(opts: { throwOnCall?: boolean } = {}): DistillerSpy {
  const calls: PerceptionDistillInput[] = [];
  const perceive = async (input: PerceptionDistillInput): Promise<PerceptionDistillResult> => {
    calls.push(input);
    if (opts.throwOnCall) {
      throw new Error('感官老师基础设施失败（模拟）');
    }
    return { memoryIds: ['m1'], candidates: [], teacherFailed: false };
  };
  /* 仅需 perceive；以 PerceptionDistiller 结构对接（cast，避开真 provider/memoryGraph 构造）。 */
  return { distiller: { perceive } as unknown as PerceptionDistiller, calls };
}

describe('GitHubLearningService（编排：增量拉取→digest 原子摄入→游标成功才推进）', () => {
  let db: IDatabase;
  let store: GithubLearnStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new GithubLearnStore(db, TENANT);
  });

  it('learn issues：拉取→映射→perceive 被调、digest 记 ingested、游标推进', async () => {
    const { distiller, calls } = makeDistiller();
    const service = new GitHubLearningService({
      readPort: makeReadPort(),
      store,
      distiller,
      tenantId: TENANT,
      personaId: PERSONA,
      memories: fakeMemories(),
    });

    const result = await service.learn(REPO, ['issues']);

    /* 两条 issue 各 perceive 一次 → ingested=2, skipped=0, 游标推进。 */
    assert.equal(calls.length, 2, '两条 issue 各 perceive 一次');
    assert.equal(result.ingested, 2, 'ingested=2');
    assert.equal(result.skipped, 0, 'skipped=0');
    assert.equal(result.cursorAdvanced, true, '全批成功→游标推进');

    /* perceive 用 audio 壳范式（modality=audio, durationMs=0, mediaSha256=contentSha）。 */
    assert.equal(calls[0].personaId, PERSONA);
    assert.equal(calls[0].tenantId, TENANT);
    assert.equal(calls[0].media.modality, 'audio');
    assert.equal(calls[0].media.durationMs, 0);
    assert.equal(typeof calls[0].media.mediaSha256, 'string');
    assert.ok(calls[0].media.representation.includes('acme/repo issue #1'), '表征含 issue 锚');

    /* 数字账本：两条 digest 都置 ingested。 */
    const ingestedCount = db
      .prepare<{ c: number }>(
        "SELECT COUNT(*) AS c FROM github_ingest_digests WHERE tenant_id=? AND persona_id=? AND repo=? AND resource_type=? AND status='ingested'",
      )
      .get(TENANT, PERSONA, REPO, 'issues')?.c;
    assert.equal(ingestedCount, 2, '两条 digest 置 ingested');

    /* 游标推进到最新 issue 的 updatedAt。 */
    const cursor = store.getCursor(PERSONA, REPO, 'issues');
    assert.equal(cursor?.cursor, '2026-01-02T00:00:00Z', '游标=最新 updatedAt');
  });

  it('重复 learn 同内容：第二次 claimDigest 全 false → skipped，perceive 不再被调', async () => {
    /* 首次 learn：正常摄入两条。 */
    const first = makeDistiller();
    await new GitHubLearningService({
      readPort: makeReadPort(),
      store,
      distiller: first.distiller,
      tenantId: TENANT,
      personaId: PERSONA,
      memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.equal(first.calls.length, 2, '首次两条各 perceive 一次');

    /* 第二次 learn 同内容：digest 已存在 → claim 全 false → 全部 skipped，perceive 零调用。 */
    const second = makeDistiller();
    const result = await new GitHubLearningService({
      readPort: makeReadPort(),
      store,
      distiller: second.distiller,
      tenantId: TENANT,
      personaId: PERSONA,
      memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    assert.equal(second.calls.length, 0, '增量去重：第二次 perceive 零调用');
    assert.equal(result.ingested, 0, '无新摄入');
    assert.equal(result.skipped, 2, '两条都因已摄入被跳过');
  });

  it('perceive 抛错：游标不推进（下次重拉靠 digest 兜幂等）', async () => {
    /* 先给一个旧游标，验证抛错后游标停在旧值（不被推进）。 */
    store.advanceCursor(PERSONA, REPO, 'issues', 'OLD_CURSOR', 500);

    const { distiller, calls } = makeDistiller({ throwOnCall: true });
    const result = await new GitHubLearningService({
      readPort: makeReadPort(),
      store,
      distiller,
      tenantId: TENANT,
      personaId: PERSONA,
      memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    /* perceive 被调一次（抢到 claim 后调），抛错 → 该 resourceType 不推进。 */
    assert.ok(calls.length >= 1, 'perceive 至少被调一次（抢到 claim 后）');
    assert.equal(result.cursorAdvanced, false, '失败不推进游标');

    /* 游标仍停在旧值。 */
    const cursor = store.getCursor(PERSONA, REPO, 'issues');
    assert.equal(cursor?.cursor, 'OLD_CURSOR', '游标停在旧值（未被推进）');
  });

  /* 审计 Warning B4-16：claim 发生在 perceive 之前，失败若不释放占位，
   * 下一轮 claimDigest 返回 false → 该条内容被当作「已摄入」永久跳过。
   * 只验游标不推进是不够的——游标回到旧值也救不回被占位卡死的那条内容。 */
  it('perceive 抛错后释放占位：同内容下一轮仍可重新学习（不被永久跳过）', async () => {
    /* 第一次：老师失败 → 占位必须被释放。 */
    const failing = makeDistiller({ throwOnCall: true });
    await new GitHubLearningService({
      readPort: makeReadPort(),
      store,
      distiller: failing.distiller,
      tenantId: TENANT,
      personaId: PERSONA,
      memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.ok(failing.calls.length >= 1, '首轮 perceive 被调（抢到 claim 后）');

    /* 第二次：老师恢复 → 同内容必须能重新被摄入，而不是被 digest 判为已学过。 */
    const recovered = makeDistiller();
    const second = await new GitHubLearningService({
      readPort: makeReadPort(),
      store,
      distiller: recovered.distiller,
      tenantId: TENANT,
      personaId: PERSONA,
      memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    /* 关键断言：必须是**那条失败的内容**重新被摄入。
     * 不能只断言「有内容被 perceive」——批次里还有其它未被 claim 的条目，
     * 它们本来就会在下一轮被处理，会把占位泄漏掩盖成绿灯。 */
    const failedSha = failing.calls[0]!.media.mediaSha256;
    const retriedShas = recovered.calls.map((c) => c.media.mediaSha256);
    assert.ok(
      retriedShas.includes(failedSha),
      `占位已释放：失败内容（${failedSha}）必须重新 perceive，实际重试了 ${JSON.stringify(retriedShas)}`,
    );
    assert.ok(second.ingested >= 1, '恢复后真正摄入，而非全部 skipped');
  });

  /* Codex 交叉审查发现：释放窗口若覆盖 perceive **之后**的收尾步骤，
   * 就把「永久跳过」换成了更坏的「重复灌记忆」——记忆已落库却释放占位，
   * 下一轮重新 perceive 会凭空生成第二套。故注入 markIngested 失败，
   * 断言第二轮**不再** perceive（占位保持 claimed）。 */
  it('perceive 成功但收尾失败：不释放占位，下一轮不重复灌记忆', async () => {
    const first = makeDistiller();
    /* 注入：markIngested 抛错，模拟 perceive 成功后的收尾故障。 */
    let failMark = true;
    const brittleStore = Object.create(store) as GithubLearnStore;
    brittleStore.markIngested = (): void => {
      if (failMark) throw new Error('收尾写入失败（模拟）');
    };

    await new GitHubLearningService({
      readPort: makeReadPort(), store: brittleStore, distiller: first.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.ok(first.calls.length >= 1, '首轮 perceive 成功（记忆已落库）');
    const ingestedSha = first.calls[0]!.media.mediaSha256;

    /* 第二轮用正常 store：那条已产生记忆的内容必须**不再**被 perceive。 */
    failMark = false;
    const second = makeDistiller();
    await new GitHubLearningService({
      readPort: makeReadPort(), store, distiller: second.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    const retried = second.calls.map((c) => c.media.mediaSha256);
    assert.equal(
      retried.includes(ingestedSha), false,
      `记忆已落库的内容（${ingestedSha}）不得重新 perceive，否则产生重复记忆`,
    );
  });

  /* Codex 第二轮：perceive 的记忆写入逐条独立、无事务包裹，中途抛错会留下
   * **部分已落库**的记忆。若把这种失败也当作零写入而释放占位，下一轮重新摄入
   * 会为已落库的部分再生成一套重复记忆。PartialPerceptionError 用于区分。 */
  it('perceive 部分写入后失败：不释放占位（避免为已落库部分生成重复记忆）', async () => {
    const calls: PerceptionDistillInput[] = [];
    const partialDistiller = {
      perceive: async (input: PerceptionDistillInput): Promise<PerceptionDistillResult> => {
        calls.push(input);
        /* 模拟：已写入 2 条记忆后基础设施失败。 */
        throw new PartialPerceptionError(['m-written-1', 'm-written-2'], new Error('db 写入失败'));
      },
    } as unknown as PerceptionDistiller;

    await new GitHubLearningService({
      readPort: makeReadPort(), store, distiller: partialDistiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.ok(calls.length >= 1, '首轮 perceive 被调用');
    const partialSha = calls[0]!.media.mediaSha256;

    /* 第二轮：该条**不得**重新 perceive，否则重复灌记忆。 */
    const second = makeDistiller();
    await new GitHubLearningService({
      readPort: makeReadPort(), store, distiller: second.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    const retried = second.calls.map((c) => c.media.mediaSha256);
    assert.equal(
      retried.includes(partialSha), false,
      `已部分落库的内容（${partialSha}）不得重新摄入`,
    );
  });

  /* Codex 第四轮：占位释放失败原本被静默吞掉，后果是内容**永久跳过**且无痕迹。
   * 释放是幂等单条 DELETE，瞬时故障应重试收敛；彻底失败必须留下可检索日志。 */
  it('占位释放瞬时失败：重试后成功，内容仍可重学', async () => {
    const singleIssue: GitHubIssue[] = [
      { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
    ];
    const onePort = makeReadPort({ listIssues: async (): Promise<GitHubIssue[]> => singleIssue });

    /* 前两次释放抛错，第三次成功——验证重试真的把内容救回来了。 */
    let releaseAttempts = 0;
    const flakyStore = Object.create(store) as GithubLearnStore;
    flakyStore.releaseDigestClaim = function (
      p: string, r: string, rt: string, sha: string,
    ): boolean {
      releaseAttempts += 1;
      if (releaseAttempts < 3) throw new Error('瞬时锁竞争');
      return (Object.getPrototypeOf(this) as GithubLearnStore)
        .releaseDigestClaim.call(store, p, r, rt, sha);
    };

    const teacherDown = {
      perceive: async (): Promise<PerceptionDistillResult> =>
        ({ memoryIds: [], candidates: [], teacherFailed: true }),
    } as unknown as PerceptionDistiller;

    await new GitHubLearningService({
      readPort: onePort, store: flakyStore, distiller: teacherDown,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.equal(releaseAttempts, 3, '前两次失败后应继续重试');

    /* 释放最终成功 → 内容可重学。 */
    const recovered = makeDistiller();
    await new GitHubLearningService({
      readPort: onePort, store, distiller: recovered.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.equal(recovered.calls.length, 1, '重试成功后内容被重新摄入');
  });

  it('占位释放彻底失败：写日志留痕（永久跳过不得静默发生）', async () => {
    const singleIssue: GitHubIssue[] = [
      { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
    ];
    const onePort = makeReadPort({ listIssues: async (): Promise<GitHubIssue[]> => singleIssue });

    const deadStore = Object.create(store) as GithubLearnStore;
    deadStore.releaseDigestClaim = (): boolean => { throw new Error('账本不可写'); };

    const errors: string[] = [];
    const teacherDown = {
      perceive: async (): Promise<PerceptionDistillResult> =>
        ({ memoryIds: [], candidates: [], teacherFailed: true }),
    } as unknown as PerceptionDistiller;

    await new GitHubLearningService({
      readPort: onePort, store: deadStore, distiller: teacherDown,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      logger: { error: (_scope, msg) => { errors.push(msg); } },
    }).learn(REPO, ['issues']);

    assert.equal(errors.length, 1, '彻底失败必须留下一条错误日志');
    assert.match(errors[0]!, /永久跳过/, '日志需说明后果');
    assert.match(errors[0]!, /acme\/repo/, '日志需含可检索的定位信息');
  });

  /* Codex 第五轮：releaseDigestClaim 返回 false（没删到 claimed 行）同样意味着
   * 占位仍在、内容会被永久跳过。若把 false 当成功，"释放失败"会悄悄退化成静默丢内容。 */
  it('占位释放返回 false：视为失败并最终告警（不得当成功）', async () => {
    const singleIssue: GitHubIssue[] = [
      { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
    ];
    const onePort = makeReadPort({ listIssues: async (): Promise<GitHubIssue[]> => singleIssue });

    let attempts = 0;
    const falseStore = Object.create(store) as GithubLearnStore;
    falseStore.releaseDigestClaim = (): boolean => { attempts += 1; return false; };

    const errors: string[] = [];
    const teacherDown = {
      perceive: async (): Promise<PerceptionDistillResult> =>
        ({ memoryIds: [], candidates: [], teacherFailed: true }),
    } as unknown as PerceptionDistiller;

    await new GitHubLearningService({
      readPort: onePort, store: falseStore, distiller: teacherDown,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      logger: { error: (_s, m) => { errors.push(m); } },
    }).learn(REPO, ['issues']);

    assert.equal(attempts, 3, 'false 应触发重试，而非被当作成功直接返回');
    assert.equal(errors.length, 1, 'false 到底仍须告警');
    assert.match(errors[0]!, /永久跳过/);
  });

  it('日志后端自身抛错：不向上传播（不得掩盖原始故障）', async () => {
    const singleIssue: GitHubIssue[] = [
      { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
    ];
    const onePort = makeReadPort({ listIssues: async (): Promise<GitHubIssue[]> => singleIssue });

    const deadStore = Object.create(store) as GithubLearnStore;
    deadStore.releaseDigestClaim = (): boolean => { throw new Error('账本不可写'); };

    const teacherDown = {
      perceive: async (): Promise<PerceptionDistillResult> =>
        ({ memoryIds: [], candidates: [], teacherFailed: true }),
    } as unknown as PerceptionDistiller;

    /* 释放失败 + 日志后端也失败：learn 仍须正常返回，不抛出。 */
    await assert.doesNotReject(() => new GitHubLearningService({
      readPort: onePort, store: deadStore, distiller: teacherDown,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      logger: { error: (): never => { throw new Error('日志后端故障'); } },
    }).learn(REPO, ['issues']));
  });

  /* Codex 第四轮抓到的既有缺陷：老师瞬时故障时 perceive **不抛错**，而是降级返回
   * 空结果 + teacherFailed=true。编排若忽略该标志照常 markIngested，一次网关抖动
   * 就把该内容永久标为已摄入（零记忆），下一轮 claim=false 永远学不到。 */
  it('老师瞬时故障（teacherFailed）：不得标记已摄入，内容下一轮可重学', async () => {
    const singleIssue: GitHubIssue[] = [
      { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
    ];
    const onePort = makeReadPort({ listIssues: async (): Promise<GitHubIssue[]> => singleIssue });

    /* 老师挂了：空产出 + teacherFailed=true（注意：**不抛错**）。 */
    const teacherDown = {
      perceive: async (): Promise<PerceptionDistillResult> =>
        ({ memoryIds: [], candidates: [], teacherFailed: true }),
    } as unknown as PerceptionDistiller;

    const r1 = await new GitHubLearningService({
      readPort: onePort, store, distiller: teacherDown,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.equal(r1.ingested, 0, '零记忆不得计为已摄入');

    /* 老师恢复：同一内容必须能被重新学习。 */
    const recovered = makeDistiller();
    const r2 = await new GitHubLearningService({
      readPort: onePort, store, distiller: recovered.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    assert.equal(recovered.calls.length, 1, '老师恢复后内容被重新摄入（未被永久烧掉）');
    assert.equal(r2.ingested, 1);
  });

  /* 对照：老师**成功**但没听出可记的事（teacherFailed=false + 空 memoryIds）是正常
   * 无沉淀，应当标记 ingested——否则每轮都会重复询问老师，白烧额度。 */
  it('老师成功但无有效事实：标记已摄入，不重复询问', async () => {
    const singleIssue: GitHubIssue[] = [
      { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
    ];
    const onePort = makeReadPort({ listIssues: async (): Promise<GitHubIssue[]> => singleIssue });

    const noFacts = {
      perceive: async (): Promise<PerceptionDistillResult> =>
        ({ memoryIds: [], candidates: [], teacherFailed: false }),
    } as unknown as PerceptionDistiller;

    const r1 = await new GitHubLearningService({
      readPort: onePort, store, distiller: noFacts,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.equal(r1.ingested, 1, '正常无沉淀仍算摄入完成');

    const second = makeDistiller();
    await new GitHubLearningService({
      readPort: onePort, store, distiller: second.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.equal(second.calls.length, 0, '不得重复询问老师');
  });

  /* 边界：写第一条就失败 → writtenMemoryIds 为空 → 确无记忆落库 → 必须释放。
   * 这是「不释放」与「释放」的分界点，若判据写成 instanceof 而漏掉长度检查，
   * 该内容会被永久跳过。 */
  it('PartialPerceptionError 但零写入：仍释放占位（内容可重学）', async () => {
    const singleIssue: GitHubIssue[] = [
      { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
    ];
    const onePort = makeReadPort({ listIssues: async (): Promise<GitHubIssue[]> => singleIssue });

    const emptyPartial = {
      perceive: async (): Promise<PerceptionDistillResult> => {
        throw new PartialPerceptionError([], new Error('第一条就失败'));
      },
    } as unknown as PerceptionDistiller;

    await new GitHubLearningService({
      readPort: onePort, store, distiller: emptyPartial,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    const second = makeDistiller();
    const r2 = await new GitHubLearningService({
      readPort: onePort, store, distiller: second.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    assert.equal(second.calls.length, 1, '零写入 → 占位应释放 → 内容可重学');
    assert.equal(r2.ingested, 1);
  });

  /* 同一分界线的另一侧：claim 之后、记忆落库之前的任何失败都必须释放占位。
   * 旧记忆查询就在该窗口内——它若抛错而不释放，内容同样被永久跳过。 */
  it('claim 后、落库前的旧记忆查询失败：释放占位（内容可重学）', async () => {
    const first = makeDistiller();
    let failLookup = true;
    const brittleStore = Object.create(store) as GithubLearnStore;
    brittleStore.findMemoryIdsByDiscussionKey = (): string[] => {
      if (failLookup) throw new Error('旧记忆查询失败（模拟）');
      return [];
    };

    /* 单条 issue 输入：批次里若有第二条，它本来就会在下一轮被摄入，
     * 会把「第一条占位未释放」掩盖成绿灯（Codex 抓到的假绿模式）。 */
    const singleIssue: GitHubIssue[] = [
      { number: 1, title: '登录报错', body: '点登录后白屏', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
    ];
    const onePort = makeReadPort({ listIssues: async (): Promise<GitHubIssue[]> => singleIssue });

    await new GitHubLearningService({
      readPort: onePort, store: brittleStore, distiller: first.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.equal(first.calls.length, 0, '查询在 perceive 之前失败，perceive 未被调用');

    /* 第二轮用正常 store：那条**唯一**内容必须能被重新学习（占位已释放）。 */
    failLookup = false;
    const second = makeDistiller();
    const r2 = await new GitHubLearningService({
      readPort: onePort, store, distiller: second.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);

    assert.equal(second.calls.length, 1, '占位已释放：那条内容下一轮被重新摄入');
    assert.equal(r2.ingested, 1, '真正摄入而非 skipped');
  });

  /* Codex 第三轮补口：以上用例都用手工构造的 PartialPerceptionError，
   * 无法证明**真实** PerceptionDistiller 会在落库后的各失败点正确包装。
   * 这里用真实 distiller + 注入故障，覆盖两个关键边界。 */
  it('真实 distiller：第二条记忆写入失败时，异常携带第一条已写入 ID', async () => {
    const { PerceptionDistiller, PartialPerceptionError: PPE } =
      await import('../../perception/perception-distiller.js');

    let written = 0;
    const memoryGraph = {
      addMemory: (): { id: string } => {
        written += 1;
        if (written === 2) throw new Error('第二条写入失败（模拟基础设施故障）');
        return { id: `m-${written}` };
      },
    };
    const provider = {
      analyze: async (): Promise<unknown> => ({
        facts: [
          { memoryKind: 'episodic', summary: '事实一', valence: 0, salience: 0.5 },
          { memoryKind: 'episodic', summary: '事实二', valence: 0, salience: 0.5 },
        ],
        confidence: 0.8,
        identityHints: [],
      }),
    };
    const distiller = new PerceptionDistiller(
      provider as never, memoryGraph as never,
      { ingest: (): unknown => ({ status: 'pending' }) } as never,
    );

    await assert.rejects(
      () => distiller.perceive({
        personaId: PERSONA, tenantId: TENANT,
        media: { modality: 'audio', mediaSha256: 'sha-x', durationMs: 0, representation: '表征' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PPE, '必须是 PartialPerceptionError');
        assert.deepEqual(
          [...err.writtenMemoryIds], ['m-1'],
          '必须携带失败前已落库的记忆 ID，否则调用方会误判为零写入而重复摄入',
        );
        return true;
      },
    );
  });

  it('真实 distiller：落库后日志抛错同样携带全部已写入 ID', async () => {
    const { PerceptionDistiller, PartialPerceptionError: PPE } =
      await import('../../perception/perception-distiller.js');

    let n = 0;
    const memoryGraph = { addMemory: (): { id: string } => ({ id: `m-${++n}` }) };
    const provider = {
      analyze: async (): Promise<unknown> => ({
        facts: [{ memoryKind: 'episodic', summary: '事实一', valence: 0, salience: 0.5 }],
        confidence: 0.8, identityHints: [],
      }),
    };
    /* 注入会抛错的 logger——它位于「记忆已落库」之后，绝不能逃逸为普通 Error。 */
    const brittleLogger = { info: (): never => { throw new Error('日志后端故障'); } };
    const distiller = new PerceptionDistiller(
      provider as never, memoryGraph as never,
      { ingest: (): unknown => ({ status: 'pending' }) } as never,
      brittleLogger as never,
    );

    await assert.rejects(
      () => distiller.perceive({
        personaId: PERSONA, tenantId: TENANT,
        media: { modality: 'audio', mediaSha256: 'sha-y', durationMs: 0, representation: '表征' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PPE, '落库后的日志失败也必须包装为部分成功');
        assert.deepEqual([...err.writtenMemoryIds], ['m-1']);
        return true;
      },
    );
  });

  /* 与上一条互为镜像：释放只能删 claimed 行，绝不能删已 ingested 的去重记录，
   * 否则「释放」会退化成重复灌记忆的漏洞。 */
  it('释放占位不影响已摄入记录：ingested 行不被删除，仍正常去重', async () => {
    const first = makeDistiller();
    await new GitHubLearningService({
      readPort: makeReadPort(), store, distiller: first.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.ok(first.calls.length >= 1, '首轮正常摄入');

    /* 对已 ingested 的同一条目直接调释放：必须返回 false 且不删行。 */
    const sha = first.calls[0]!.media.mediaSha256;
    const released = store.releaseDigestClaim(PERSONA, REPO, 'issues', sha);
    assert.equal(released, false, '已 ingested 的行不可被释放');

    /* 去重仍然生效：第二轮不再 perceive。 */
    const second = makeDistiller();
    await new GitHubLearningService({
      readPort: makeReadPort(), store, distiller: second.distiller,
      tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
    }).learn(REPO, ['issues']);
    assert.equal(second.calls.length, 0, '已摄入内容仍被去重跳过');
  });

  /* 组织级驻留：轮转推进使单轮成本恒定，不随组织规模膨胀——一个 50 仓库的组织
   * 一次学完就是几百次 API + 几百次 LLM 老师调用，会触发速率限制并烧光额度。 */
  describe('learnOrg 轮转编排', () => {
    /** 造 N 个 repo 的 fake ReadPort；listIssues 按 repo 返回一条可映射内容。 */
    function makeOrgReadPort(repoCount: number): GitHubReadPort {
      const repos = Array.from({ length: repoCount }, (_, i) => `acme/repo-${i}`);
      return makeReadPort({
        listInstallationRepos: async (): Promise<string[]> => repos,
        listIssues: async (repo: string): Promise<GitHubIssue[]> => [
          { number: 1, title: `${repo} 的 issue`, body: '正文', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
        ],
      });
    }

    it('每轮只处理上限个仓库，游标推进并回绕', async () => {
      const { distiller } = makeDistiller();
      const service = new GitHubLearningService({
        readPort: makeOrgReadPort(12), store, distiller,
        tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      const r1 = await service.learnOrg('acme', ['issues'], 5);
      assert.deepEqual(r1.reposProcessed, ['acme/repo-0', 'acme/repo-1', 'acme/repo-2', 'acme/repo-3', 'acme/repo-4']);
      assert.equal(r1.nextCursor, 5, '第一轮后游标 → 5');

      const r2 = await service.learnOrg('acme', ['issues'], 5);
      assert.deepEqual(r2.reposProcessed, ['acme/repo-5', 'acme/repo-6', 'acme/repo-7', 'acme/repo-8', 'acme/repo-9']);
      assert.equal(r2.nextCursor, 10, '第二轮后游标 → 10');

      /* 第三轮只剩 2 个（10, 11），处理完回绕到 0。 */
      const r3 = await service.learnOrg('acme', ['issues'], 5);
      assert.deepEqual(r3.reposProcessed, ['acme/repo-10', 'acme/repo-11']);
      assert.equal(r3.nextCursor, 0, '轮完一圈回绕到 0');
    });

    it('单个 repo 失败不中断整轮，游标仍推进（防坏 repo 永久卡死组织轮转）', async () => {
      const { distiller } = makeDistiller();
      const readPort = makeReadPort({
        listInstallationRepos: async (): Promise<string[]> => ['acme/good-1', 'acme/bad', 'acme/good-2'],
        listIssues: async (repo: string): Promise<GitHubIssue[]> => {
          if (repo === 'acme/bad') throw new Error('该 repo 无权访问');
          return [{ number: 1, title: `${repo} issue`, body: '正文', updatedAt: '2026-01-01T00:00:00Z', comments: 0 }];
        },
      });
      const service = new GitHubLearningService({
        readPort, store, distiller, tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      const r = await service.learnOrg('acme', ['issues'], 5);

      /* learn 内部已逐 resourceType 吞异常，故坏 repo 也算「处理过」（只是零摄入）。 */
      assert.equal(r.reposProcessed.length, 3, '三个 repo 都被处理（坏的不中断整轮）');
      assert.equal(r.nextCursor, 0, '游标推进到尾并回绕（不被坏 repo 卡住）');
    });

    it('空组织（无授权仓库）→ 零处理、游标归零、不抛错', async () => {
      const { distiller } = makeDistiller();
      const service = new GitHubLearningService({
        readPort: makeReadPort({ listInstallationRepos: async (): Promise<string[]> => [] }),
        store, distiller, tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      const r = await service.learnOrg('acme', ['issues'], 5);

      assert.deepEqual(r.reposProcessed, []);
      assert.equal(r.nextCursor, 0);
    });

    it('组织游标与 per-repo 游标互不干扰（哨兵 resource_type 隔离）', async () => {
      const { distiller } = makeDistiller();
      const service = new GitHubLearningService({
        readPort: makeOrgReadPort(3), store, distiller,
        tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      await service.learnOrg('acme', ['issues'], 2);

      assert.equal(store.getCursor(PERSONA, 'acme', '_org_rotation')?.cursor, '2', '组织轮转游标');
      assert.ok(store.getCursor(PERSONA, 'acme/repo-0', 'issues')?.cursor, 'per-repo 游标独立推进');
    });

    it('游标越界（仓库数变少）→ 收敛回 0 重新轮转，不抛错', async () => {
      const { distiller } = makeDistiller();
      /* 先把组织游标推到 99（模拟仓库曾经很多、后来被移除授权）。 */
      store.advanceCursor(PERSONA, 'acme', '_org_rotation', '99', 1000);
      const service = new GitHubLearningService({
        readPort: makeOrgReadPort(3), store, distiller,
        tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      const r = await service.learnOrg('acme', ['issues'], 5);

      assert.deepEqual(r.reposProcessed, ['acme/repo-0', 'acme/repo-1', 'acme/repo-2'], '越界收敛回 0 从头轮');
      assert.equal(r.nextCursor, 0);
    });
  });
});
