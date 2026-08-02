/**
 * GitHub 学习段 storage（GithubLearnStore）：增量同步游标读写 + 摄入幂等账本的原子 claim。
 *
 * 断言重点（spec ⑦b——防并发/崩溃重复灌记忆的关键机制）：
 *   1. claimDigest 原子去重：同一 content_sha 首次 claim 返 true（抢到未摄入过），二次同 sha 返 false
 *      （已被抢/已摄入）。执行器用 INSERT ON CONFLICT DO NOTHING，以受影响行数判定——绝非
 *      check-then-act（先 SELECT 再 INSERT 非并发安全）。
 *   2. advanceCursor upsert：写后 getCursor 读回；再 advance 覆盖（四键 CAS upsert）。
 *   3. 游标按 (persona, repo, resource_type) 隔离：同一 (tenant, persona, repo) 下不同 resource_type
 *      各自独立游标，互不污染。
 *   4. markIngested：claim 后标记 ingested（直查 status 列断言两态迁移 claimed → ingested）。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { GithubLearnStore } from '../../storage/github-learn-store.js';
import type { IDatabase } from '../../storage/index.js';

const TENANT = 'tenant_a';
const PERSONA = 'persona_1';
const REPO = 'acme/repo';

describe('GitHub 学习段 storage（GithubLearnStore）', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
  });

  describe('claimDigest（原子去重——INSERT ON CONFLICT DO NOTHING）', () => {
    it('同一 content_sha：首次 claim 返 true，二次同 sha 返 false（抢占幂等窗口）', () => {
      const store = new GithubLearnStore(db, TENANT);
      const sha = 'sha-content-abc';

      /* 首个 claim 者独占 → true。 */
      assert.equal(store.claimDigest(PERSONA, REPO, 'issues', sha, 1000), true, '首次 claim 抢到');
      /* 重复 claim 同 sha → false（已被抢/已摄入，rowsAffected=0）。 */
      assert.equal(store.claimDigest(PERSONA, REPO, 'issues', sha, 2000), false, '二次同 sha 抢不到');

      /* 库里只有一行（ON CONFLICT DO NOTHING 不新增，也不覆盖 claimed_at）。 */
      const cnt = db.prepare<{ c: number }>(
        'SELECT COUNT(*) AS c FROM github_ingest_digests WHERE tenant_id=? AND persona_id=? AND repo=? AND resource_type=? AND content_sha=?',
      ).get(TENANT, PERSONA, REPO, 'issues', sha)?.c;
      assert.equal(cnt, 1, '幂等主键防重复：只落一行');
    });

    it('不同 content_sha 各自独立 claim（都返 true）', () => {
      const store = new GithubLearnStore(db, TENANT);
      assert.equal(store.claimDigest(PERSONA, REPO, 'commits', 'sha-1', 1000), true);
      assert.equal(store.claimDigest(PERSONA, REPO, 'commits', 'sha-2', 1000), true, '不同指纹互不影响');
    });

    it('跨租户隔离：A 已 claim 的 sha，B 在同 (persona,repo,resource,sha) 仍能 claim（tenant_id 参与幂等键）', () => {
      new GithubLearnStore(db, 'tenant_A').claimDigest(PERSONA, REPO, 'pulls', 'sha-x', 1000);
      const claimedByB = new GithubLearnStore(db, 'tenant_B').claimDigest(PERSONA, REPO, 'pulls', 'sha-x', 1000);
      assert.equal(claimedByB, true, 'B 与 A 幂等键不同（tenant_id 在键内），B 独立抢到');
    });
  });

  describe('markIngested（status: claimed → ingested）', () => {
    it('claim 后 markIngested：status 由 claimed 置 ingested，记录 ingested_at', () => {
      const store = new GithubLearnStore(db, TENANT);
      const sha = 'sha-ingest';
      assert.equal(store.claimDigest(PERSONA, REPO, 'code', sha, 1000), true);

      /* claim 后直查：status=claimed，ingested_at 尚空。 */
      const beforeRow = db.prepare<{ status: string; ingested_at: number | null }>(
        'SELECT status, ingested_at FROM github_ingest_digests WHERE tenant_id=? AND persona_id=? AND repo=? AND resource_type=? AND content_sha=?',
      ).get(TENANT, PERSONA, REPO, 'code', sha);
      assert.equal(beforeRow!.status, 'claimed');
      assert.equal(beforeRow!.ingested_at, null);

      store.markIngested(PERSONA, REPO, 'code', sha, 5000);

      /* markIngested 后：status=ingested，ingested_at=5000。 */
      const afterRow = db.prepare<{ status: string; ingested_at: number | null }>(
        'SELECT status, ingested_at FROM github_ingest_digests WHERE tenant_id=? AND persona_id=? AND repo=? AND resource_type=? AND content_sha=?',
      ).get(TENANT, PERSONA, REPO, 'code', sha);
      assert.equal(afterRow!.status, 'ingested', 'status 迁移到 ingested');
      assert.equal(afterRow!.ingested_at, 5000, 'ingested_at 记录完成时间');
    });
  });

  describe('advanceCursor / getCursor（游标 upsert 读回）', () => {
    it('无游标行 → getCursor 返 undefined', () => {
      const store = new GithubLearnStore(db, TENANT);
      assert.equal(store.getCursor(PERSONA, REPO, 'issues'), undefined);
    });

    it('advanceCursor 写后 getCursor 读回；再 advance 覆盖（四键 CAS upsert）', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.advanceCursor(PERSONA, REPO, 'issues', 'cursor-v1', 1000);

      const c1 = store.getCursor(PERSONA, REPO, 'issues');
      assert.deepEqual(c1, { cursor: 'cursor-v1', cursorAdvancedAt: 1000 }, '写后读回');

      /* 再次 advance 同四键 → 覆盖（upsert，不新增行）。 */
      store.advanceCursor(PERSONA, REPO, 'issues', 'cursor-v2', 2000);
      const c2 = store.getCursor(PERSONA, REPO, 'issues');
      assert.deepEqual(c2, { cursor: 'cursor-v2', cursorAdvancedAt: 2000 }, '再 advance 覆盖');

      const cnt = db.prepare<{ c: number }>(
        'SELECT COUNT(*) AS c FROM github_learn_state WHERE tenant_id=? AND persona_id=? AND repo=? AND resource_type=?',
      ).get(TENANT, PERSONA, REPO, 'issues')?.c;
      assert.equal(cnt, 1, '四键 upsert：覆盖不多行');
    });
  });

  describe('游标隔离（按 persona, repo, resource_type）', () => {
    it('不同 resource_type 各自独立游标（互不污染）', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.advanceCursor(PERSONA, REPO, 'issues', 'cur-issues', 1000);
      store.advanceCursor(PERSONA, REPO, 'commits', 'cur-commits', 2000);

      assert.deepEqual(store.getCursor(PERSONA, REPO, 'issues'), { cursor: 'cur-issues', cursorAdvancedAt: 1000 });
      assert.deepEqual(store.getCursor(PERSONA, REPO, 'commits'), { cursor: 'cur-commits', cursorAdvancedAt: 2000 });
    });

    it('不同 repo 各自独立游标', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.advanceCursor(PERSONA, 'acme/repo-a', 'pulls', 'cur-a', 1000);
      store.advanceCursor(PERSONA, 'acme/repo-b', 'pulls', 'cur-b', 2000);

      assert.deepEqual(store.getCursor(PERSONA, 'acme/repo-a', 'pulls'), { cursor: 'cur-a', cursorAdvancedAt: 1000 });
      assert.deepEqual(store.getCursor(PERSONA, 'acme/repo-b', 'pulls'), { cursor: 'cur-b', cursorAdvancedAt: 2000 });
    });

    it('不同 persona 各自独立游标', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.advanceCursor('persona_x', REPO, 'code', 'cur-x', 1000);
      store.advanceCursor('persona_y', REPO, 'code', 'cur-y', 2000);

      assert.deepEqual(store.getCursor('persona_x', REPO, 'code'), { cursor: 'cur-x', cursorAdvancedAt: 1000 });
      assert.deepEqual(store.getCursor('persona_y', REPO, 'code'), { cursor: 'cur-y', cursorAdvancedAt: 2000 });
    });

    it('跨租户隔离：A 的游标不被 B 读到（getCursor 带 tenant_id 过滤）', () => {
      new GithubLearnStore(db, 'tenant_A').advanceCursor(PERSONA, REPO, 'issues', 'cur-A', 1000);
      const cursorForB = new GithubLearnStore(db, 'tenant_B').getCursor(PERSONA, REPO, 'issues');
      assert.equal(cursorForB, undefined, 'B 读不到 A 的游标（tenant scoped）');
    });
  });

  /* 演进式取代（讨论内容摄入设计 §3.3）：讨论演进时新记忆取代旧记忆，靠稳定讨论键
   * 反查上一版记忆指针。contentSha 随评论变化，故不能用它定位「同一个 issue 的上一版」。 */
  describe('讨论键与记忆指针（演进式取代）', () => {
    const DISCUSSION = 'issues:acme/repo#42';

    it('claim 时带 discussionKey、回写 memoryId 后可按讨论键反查', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.claimDigest(PERSONA, REPO, 'issues', 'sha-v1', 1000, DISCUSSION);
      store.recordMemoryIds(PERSONA, REPO, 'issues', 'sha-v1', ['mem_first'], 1001);

      assert.deepEqual(store.findMemoryIdsByDiscussionKey(PERSONA, DISCUSSION), ['mem_first']);
    });

    it('整组记忆 ID 往返：perceive 把一条表征切成多条事实记忆，须整组记录与反查', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.claimDigest(PERSONA, REPO, 'issues', 'sha-multi', 1000, DISCUSSION);
      /* 真实形态：标题/正文/讨论结论各一条记忆——只记第一条会导致取代时漏删其余。 */
      store.recordMemoryIds(PERSONA, REPO, 'issues', 'sha-multi', ['mem_a', 'mem_b', 'mem_c'], 1001);

      assert.deepEqual(store.findMemoryIdsByDiscussionKey(PERSONA, DISCUSSION), ['mem_a', 'mem_b', 'mem_c']);
    });

    it('空 ID 组不写入（保持 NULL，反查不命中）', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.claimDigest(PERSONA, REPO, 'issues', 'sha-empty', 1000, DISCUSSION);
      store.recordMemoryIds(PERSONA, REPO, 'issues', 'sha-empty', [], 1001);

      assert.deepEqual(store.findMemoryIdsByDiscussionKey(PERSONA, DISCUSSION), []);
    });

    it('未知讨论键返回 undefined', () => {
      const store = new GithubLearnStore(db, TENANT);
      assert.deepEqual(store.findMemoryIdsByDiscussionKey(PERSONA, 'issues:acme/repo#999'), []);
    });

    it('尚未回写 memoryId 的占位行不被反查到（memory_id IS NULL 排除）', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.claimDigest(PERSONA, REPO, 'issues', 'sha-v1', 1000, DISCUSSION);
      /* 只 claim 未 recordMemoryId：还没有记忆可取代，反查应为空。 */
      assert.deepEqual(store.findMemoryIdsByDiscussionKey(PERSONA, DISCUSSION), []);
    });

    it('同讨论新版本：反查返回最新回写的 memoryId（取代语义的存储侧基础）', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.claimDigest(PERSONA, REPO, 'issues', 'sha-v1', 1000, DISCUSSION);
      store.recordMemoryIds(PERSONA, REPO, 'issues', 'sha-v1', ['mem_first'], 1001);
      /* 讨论新增评论 → 表征变 → 新 sha，同一讨论键。 */
      store.claimDigest(PERSONA, REPO, 'issues', 'sha-v2', 2000, DISCUSSION);
      store.recordMemoryIds(PERSONA, REPO, 'issues', 'sha-v2', ['mem_second'], 2001);

      assert.deepEqual(store.findMemoryIdsByDiscussionKey(PERSONA, DISCUSSION), ['mem_second'], '取最新回写那条');
    });

    it('跨租户隔离：A 的讨论记忆指针不被 B 读到', () => {
      new GithubLearnStore(db, 'tenant_A').claimDigest(PERSONA, REPO, 'issues', 'sha-a', 1000, DISCUSSION);
      new GithubLearnStore(db, 'tenant_A').recordMemoryIds(PERSONA, REPO, 'issues', 'sha-a', ['mem_A'], 1001);

      assert.deepEqual(new GithubLearnStore(db, 'tenant_B').findMemoryIdsByDiscussionKey(PERSONA, DISCUSSION), []);
    });
  });

  /* 组织轮转游标（组织级驻留设计 §3.2）：组织级同步每轮只处理 N 个仓库，需一条
   * 「下一个起始下标」游标记进度。该游标本质即学习进度游标，故复用本表——
   * repo 存组织标识、resource_type 存哨兵 _org_rotation、cursor 存下标。 */
  describe('组织轮转游标（_org_rotation 哨兵）', () => {
    it('哨兵 resource_type 可写入并读回（CHECK 已扩容）', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.advanceCursor(PERSONA, 'acme', '_org_rotation', '5', 1000);

      assert.deepEqual(
        store.getCursor(PERSONA, 'acme', '_org_rotation'),
        { cursor: '5', cursorAdvancedAt: 1000 },
      );
    });

    it('四类真实资源类型仍可写入（CHECK 是超集，无回归）', () => {
      const store = new GithubLearnStore(db, TENANT);
      for (const rt of ['code', 'issues', 'pulls', 'commits']) {
        store.advanceCursor(PERSONA, REPO, rt, `cur-${rt}`, 1000);
        assert.equal(store.getCursor(PERSONA, REPO, rt)?.cursor, `cur-${rt}`, `${rt} 应可写`);
      }
    });

    it('重建表后唯一索引真实存在（PRAGMA 内省，防重建静默丢索引）', () => {
      /* 独立于 parity 的直验：parity 的 legacy fixture 可能从同样 buggy 的迁移手抄，
       * 两库同错仍 deepEqual 通过，抓不到丢索引。故此处直接内省 SQLite 元数据。 */
      const indexes = db.prepare<{ name: string; unique: number }>(
        `SELECT name, "unique" FROM pragma_index_list('github_learn_state')`,
      ).all();
      const key = indexes.find((i) => i.name === 'idx_github_learn_state_key');
      assert.ok(key, 'idx_github_learn_state_key 必须存在（重建表后未丢）');
      assert.equal(key.unique, 1, '该索引必须是唯一索引');
    });

    it('唯一约束仍生效：同四键重复 advance 覆盖不新增行', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.advanceCursor(PERSONA, 'acme', '_org_rotation', '5', 1000);
      store.advanceCursor(PERSONA, 'acme', '_org_rotation', '10', 2000);

      const cnt = db.prepare<{ c: number }>(
        'SELECT COUNT(*) AS c FROM github_learn_state WHERE tenant_id=? AND persona_id=? AND repo=? AND resource_type=?',
      ).get(TENANT, PERSONA, 'acme', '_org_rotation')?.c;
      assert.equal(cnt, 1, '唯一约束生效：覆盖不多行');
      assert.equal(store.getCursor(PERSONA, 'acme', '_org_rotation')?.cursor, '10');
    });
  });
});
