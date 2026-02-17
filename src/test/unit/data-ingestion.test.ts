import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { EmbeddingIndex } from '../../intelligence/embedding-index.js';
import { ModelRouter } from '../../intelligence/model-router.js';
import { DataIngestion } from '../../onboarding/data-ingestion.js';

describe('DataIngestion', () => {
  let db: IDatabase;
  let core: CoreRhythmLayer;
  let ingestion: DataIngestion;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    const clock = new TestClock(1000);
    core = new CoreRhythmLayer(db, new EventBus(), clock, new SilentLogger());
    const llm = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
    const embeddingIndex = new EmbeddingIndex(db, clock, llm, 'mock-embed');
    ingestion = new DataIngestion(core, embeddingIndex);
  });

  describe('importJournalEntries', () => {
    it('导入日记条目创建情景记忆', async () => {
      const result = await ingestion.importJournalEntries([
        { content: '今天开始了新项目', valence: 0.5, salience: 0.7 },
        { content: '完成了重要的里程碑' },
      ]);
      assert.equal(result.imported, 2);
      assert.equal(result.memoryIds.length, 2);
      assert.equal(core.memories.getAllMemories().size, 2);
    });

    it('默认 valence 和 salience', async () => {
      const result = await ingestion.importJournalEntries([{ content: '普通一天' }]);
      const mem = core.memories.getMemory(result.memoryIds[0]);
      assert.ok(mem);
      assert.equal(mem.valence, 0);
      assert.equal(mem.salience, 0.5);
    });

    it('空数组返回 0 导入', async () => {
      const result = await ingestion.importJournalEntries([]);
      assert.equal(result.imported, 0);
    });
  });

  describe('importDecisionRecords', () => {
    it('导入决策记录创建语义记忆', async () => {
      const result = await ingestion.importDecisionRecords([
        { title: '职业选择', description: '换到新公司', outcome: '薪资提升30%' },
        { title: '投资决策', description: '投资了科技基金' },
      ]);
      assert.equal(result.imported, 2);
      assert.equal(result.caseIds.length, 2);
    });

    it('包含 outcome 时内容包含结果', async () => {
      const result = await ingestion.importDecisionRecords([
        { title: '测试', description: '描述', outcome: '成功' },
      ]);
      const mem = core.memories.getMemory(result.caseIds[0]);
      assert.ok(mem);
      assert.ok(mem.content.includes('结果: 成功'));
    });

    it('不包含 outcome 时内容不含结果', async () => {
      const result = await ingestion.importDecisionRecords([
        { title: '测试', description: '描述' },
      ]);
      const mem = core.memories.getMemory(result.caseIds[0]);
      assert.ok(mem);
      assert.ok(!mem.content.includes('结果'));
    });
  });
});
