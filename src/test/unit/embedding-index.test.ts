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
});
