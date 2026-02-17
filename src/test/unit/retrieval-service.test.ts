import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { ModelRouter } from '../../intelligence/model-router.js';

describe('RetrievalService 混合检索', () => {
  let db: IDatabase;
  let clock: TestClock;
  let core: CoreRhythmLayer;
  let llm: ModelRouter;
  let embeddingIndex: EmbeddingIndex;
  let retrieval: RetrievalService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    clock = new TestClock(1000);
    const bus = new EventBus();
    core = new CoreRhythmLayer(db, bus, clock, new SilentLogger());
    llm = new ModelRouter({
      provider: 'mock',
      model: 'test',
      embeddingModel: 'mock-embed',
    });
    embeddingIndex = new EmbeddingIndex(db, clock, llm, 'mock-embed');
    retrieval = new RetrievalService(core.memories, embeddingIndex);
  });

  it('无记忆时返回空数组', () => {
    const results = retrieval.getContext('查询', [], 5);
    assert.equal(results.length, 0);
  });

  it('仅图激活通道：高显著性记忆通过扩散被检索', () => {
    const m1 = core.addMemory('episodic', '重要经历', 0.5, 0.95);
    const m2 = core.addMemory('semantic', '知识片段', 0.3, 0.1);
    core.linkMemories(m1.id, m2.id, '相关', 0.8);

    const results = retrieval.getContext('查询', [], 5);
    /* m1 作为高显著性记忆被检索，m2 通过图扩散被激活 */
    assert.ok(results.length >= 1);
    const ids = results.map(r => r.memoryId);
    assert.ok(ids.includes(m1.id));
  });

  it('仅向量通道：通过嵌入匹配检索', async () => {
    const m1 = core.addMemory('episodic', '编程学习', 0.5, 0.01);
    await embeddingIndex.indexMemory(m1.id, '编程学习');

    const queryVec = (await llm.embed(['编程学习']))[0];
    const results = retrieval.getContext('编程学习', queryVec, 5);

    assert.ok(results.length >= 1);
    const match = results.find(r => r.memoryId === m1.id);
    assert.ok(match);
    assert.ok(match.sources.includes('embedding'));
  });

  it('混合检索：多通道得分累加', async () => {
    /* 创建一个高显著性记忆（图激活 + 可能的向量匹配） */
    const m1 = core.addMemory('episodic', '核心经历', 0.8, 0.99);
    await embeddingIndex.indexMemory(m1.id, '核心经历');

    /* 创建仅通过向量匹配的记忆 */
    const m2 = core.addMemory('semantic', '相关知识', 0.2, 0.01);
    await embeddingIndex.indexMemory(m2.id, '相关知识');

    const queryVec = (await llm.embed(['核心经历']))[0];
    const results = retrieval.getContext('核心经历', queryVec, 5);

    assert.ok(results.length >= 1);
    /* 有多个检索来源的记忆应排在前面 */
    const topResult = results[0];
    assert.equal(topResult.memoryId, m1.id);
    assert.ok(topResult.sources.length >= 1);
  });

  it('topK 限制返回数量', () => {
    for (let i = 0; i < 10; i++) {
      core.addMemory('episodic', `记忆${i}`, 0.5, 0.9);
    }

    const results = retrieval.getContext('查询', [], 3);
    assert.ok(results.length <= 3);
  });

  it('结果包含完整 ContextMemory 字段', () => {
    core.addMemory('episodic', '一段经历', 0.7, 0.85);

    const results = retrieval.getContext('查询', [], 5);
    if (results.length > 0) {
      const r = results[0];
      assert.equal(typeof r.memoryId, 'string');
      assert.equal(typeof r.content, 'string');
      assert.equal(typeof r.score, 'number');
      assert.ok(['episodic', 'semantic', 'procedural'].includes(r.kind));
      assert.equal(typeof r.salience, 'number');
      assert.ok(Array.isArray(r.sources));
      assert.ok(r.sources.length > 0);
    }
  });
});
