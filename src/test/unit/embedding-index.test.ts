import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import type { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { InMemoryEmbeddingIndex } from '../../intelligence/embedding-index-memory.js';
import { ModelRouter } from '../../intelligence/model-router.js';

describe('EmbeddingIndex', () => {
  let db: IDatabase;
  let clock: TestClock;
  let core: CoreRhythmLayer;
  let llm: ModelRouter;
  let index: EmbeddingIndex;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    clock = new TestClock(1000);
    core = new CoreRhythmLayer(db, new EventBus(), clock, new SilentLogger());
    llm = new ModelRouter({
      provider: 'mock',
      model: 'test',
      embeddingModel: 'mock-embed',
    });
    index = new InMemoryEmbeddingIndex(db, clock, llm, 'mock-embed');
  });

  /** 创建真实记忆节点（满足 FK 约束）并返回 ID */
  function createMemory(content: string): string {
    return core.addMemory('episodic', content, 0.5, 0.5).id;
  }

  describe('indexMemory', () => {
    it('成功索引记忆并返回 true', async () => {
      const memId = createMemory('学习编程是有趣的体验');
      const ok = await index.indexMemory(memId, '学习编程是有趣的体验');
      assert.equal(ok, true);
    });

    it('重复索引同一记忆执行 upsert', async () => {
      const memId = createMemory('初始内容');
      await index.indexMemory(memId, '初始内容');
      clock.advance(100);
      const ok = await index.indexMemory(memId, '更新内容');
      assert.equal(ok, true);

      const rows = db.prepare<{ cnt: number }>('SELECT count(*) as cnt FROM memory_embeddings').all();
      assert.equal(rows[0].cnt, 1);
    });
  });

  describe('search', () => {
    it('空查询向量返回空数组', () => {
      const results = index.search([], 5);
      assert.equal(results.length, 0);
    });

    it('无索引数据时返回空数组', async () => {
      const vec = (await llm.embed(['查询']))[0];
      const results = index.search(vec, 5);
      assert.equal(results.length, 0);
    });

    it('检索返回按相似度排序的结果', async () => {
      const idA = createMemory('编程和算法');
      const idB = createMemory('烹饪和美食');
      const idC = createMemory('编程和软件工程');
      await index.indexMemory(idA, '编程和算法');
      await index.indexMemory(idB, '烹饪和美食');
      await index.indexMemory(idC, '编程和软件工程');

      const queryVec = (await llm.embed(['编程和算法']))[0];
      const results = index.search(queryVec, 3);

      assert.ok(results.length > 0);
      assert.ok(results.length <= 3);
      /* 完全匹配的 idA 余弦相似度 = 1 */
      assert.equal(results[0].memoryId, idA);
      assert.ok(Math.abs(results[0].score - 1.0) < 0.001);
    });

    it('topK 限制返回数量', async () => {
      const ids = [createMemory('内容一'), createMemory('内容二'), createMemory('内容三')];
      for (const [i, id] of ids.entries()) {
        await index.indexMemory(id, `内容${'一二三'[i]}`);
      }

      const queryVec = (await llm.embed(['查询']))[0];
      const results = index.search(queryVec, 2);
      assert.equal(results.length, 2);
    });

    it('不同 model 的嵌入不互相干扰', async () => {
      const otherIndex = new InMemoryEmbeddingIndex(db, clock, llm, 'other-model');
      const idA = createMemory('测试内容');
      const idB = createMemory('其他内容');
      await index.indexMemory(idA, '测试内容');
      await otherIndex.indexMemory(idB, '其他内容');

      const queryVec = (await llm.embed(['查询']))[0];
      const results = index.search(queryVec, 10);
      /* index 使用 mock-embed model，只能看到 idA */
      assert.equal(results.length, 1);
      assert.equal(results[0].memoryId, idA);
    });
  });

  /* ── issue #376：TTL 判定必须走注入的时钟 ─────────────────────── */
  describe('缓存 TTL 走注入时钟（issue #376）', () => {
    /**
     * 缺陷：构造器收了 `clock`，但五处**时间判定**（accessOrder / refreshCache 的
     * CACHE_TTL_MS / IVF builtAt 与 IVF_MAX_AGE_MS / touchResults）全是裸 `Date.now()`。
     *
     * 后果：注入 `TestClock` 的测试**以为自己控制了时间，其实没有** ——
     * 推进 TestClock 不会让缓存过期。这类「假测试」比没有测试更危险。
     *
     * ⚠️ 必须**绕过 `indexMemory` 直接写库**：`indexMemory` 会同步把向量塞进
     * vectorCache（见其实现末尾），走它就永远看不到「缓存是否重建」这件事。
     * 初版用例正是走了 indexMemory，导致两条用例都在测别的东西。
     */
    function insertRaw(memoryId: string, vector: number[]): void {
      db.prepare<void>(
        `INSERT INTO memory_embeddings (memory_id, tenant_id, model, embedding_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(memoryId, 'default', 'mock-embed', JSON.stringify(vector), clock.now());
    }

    it('推进超过 CACHE_TTL_MS 后，search 能看到直接入库的新向量', async () => {
      const idA = createMemory('第一条记忆');
      assert.ok(await index.indexMemory(idA, '第一条记忆'));
      const queryVec = (await llm.embed(['第一条记忆']))[0];
      assert.equal(index.search(queryVec, 10).length, 1, '前置：首次可检索到 1 条');

      /* 绕过 indexMemory 直接入库：只有缓存过期重建才看得到。 */
      const idB = createMemory('第二条记忆');
      insertRaw(idB, (await llm.embed(['第二条记忆']))[0]);
      assert.equal(index.search(queryVec, 10).length, 1, 'TTL 内仍只看到 1 条（缓存未重建）');

      clock.advance(10 * 60 * 1000); // > CACHE_TTL_MS (5min)
      assert.equal(index.search(queryVec, 10).length, 2,
        '推进注入时钟超过 TTL 后，缓存必须重建并看到两条');
    });

    it('⚠️ 对照：未超过 TTL 时不得重建（防「每次都重建」的假修复）', async () => {
      const idA = createMemory('第一条记忆');
      assert.ok(await index.indexMemory(idA, '第一条记忆'));
      const queryVec = (await llm.embed(['第一条记忆']))[0];

      /* ⚠️ 必须先触发一次 search 把 cacheLoadedAt 置上：它初值为 0，而 refreshCache 的
       * 短路条件是 `cacheLoadedAt > 0 && ...`，故**首次** search 必然重建。
       * 不先建立基线的话，下面的断言测的是「首次重建」而不是「TTL 内不重建」。 */
      assert.equal(index.search(queryVec, 10).length, 1, '前置：建立缓存基线');

      const idB = createMemory('第二条记忆');
      insertRaw(idB, (await llm.embed(['第二条记忆']))[0]);

      /* 只推进 1 分钟（< 5 分钟 TTL）：缓存仍有效，看不到直接入库的那条。
       * 若把 TTL 判定改成恒过期，本条转红 —— 钉死时钟不能把被测行为一起钉没。 */
      clock.advance(60 * 1000);
      assert.equal(index.search(queryVec, 10).length, 1, 'TTL 内不得重建缓存（否则 TTL 形同虚设）');
    });
  });
});
