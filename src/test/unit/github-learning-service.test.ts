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
