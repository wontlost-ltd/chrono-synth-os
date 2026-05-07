import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { OnboardingService } from '../../onboarding/onboarding-service.js';
import { DecisionEngine } from '../../intelligence/decision-engine.js';
import { InMemoryEmbeddingIndex } from '../../intelligence/embedding-index-memory.js';
import { RetrievalService } from '../../intelligence/retrieval-service.js';
import { ModelRouter } from '../../intelligence/model-router.js';

describe('OnboardingService', () => {
  let db: IDatabase;
  let bus: EventBus;
  let clock: TestClock;
  let logger: SilentLogger;
  let core: CoreRhythmLayer;
  let onboarding: OnboardingService;
  let snapshotCount: number;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    bus = new EventBus();
    clock = new TestClock(1000);
    logger = new SilentLogger();
    core = new CoreRhythmLayer(db, bus, clock, logger);
    snapshotCount = 0;

    const llm = new ModelRouter({ provider: 'mock', model: 'test', embeddingModel: 'mock-embed' });
    const embeddingIndex = new InMemoryEmbeddingIndex(db, clock, llm, 'mock-embed');
    const retrieval = new RetrievalService(core.memories, embeddingIndex);
    const engine = new DecisionEngine(core, retrieval, llm, clock, logger, { rollouts: 1, maxOptions: 2 });

    onboarding = new OnboardingService(
      core, engine, bus, clock, logger,
      (reason) => {
        snapshotCount++;
        return {
          id: `snap_test_${snapshotCount}`,
          coreSelf: core.getState(),
          personas: [],
          activeConflicts: [],
          allocations: [],
          createdAt: clock.now(),
          reason,
        };
      },
    );
  });

  describe('createSession', () => {
    it('创建会话并返回 id', () => {
      const session = onboarding.createSession();
      assert.ok(session.id.startsWith('onb_'));
      assert.equal(session.currentStep, 1);
      assert.equal(session.completedSteps.length, 0);
    });

    it('触发 session-started 事件', () => {
      let emitted = false;
      bus.on('onboarding:session-started', () => { emitted = true; });
      onboarding.createSession();
      assert.ok(emitted);
    });
  });

  describe('getSession', () => {
    it('获取已有会话', () => {
      const session = onboarding.createSession();
      const retrieved = onboarding.getSession(session.id);
      assert.ok(retrieved);
      assert.equal(retrieved.id, session.id);
    });

    it('不存在的会话返回 undefined', () => {
      assert.equal(onboarding.getSession('nonexistent'), undefined);
    });
  });

  describe('submitStep', () => {
    it('Step 1: 记录决策问题', async () => {
      const session = onboarding.createSession();
      const updated = await onboarding.submitStep(session.id, 1, { title: '职业选择', description: '是否换工作' });
      assert.ok(updated.decision);
      assert.equal(updated.decision.title, '职业选择');
      assert.ok(updated.completedSteps.includes(1));
      assert.equal(updated.currentStep, 2);
    });

    it('Step 2: 初始化 L1 价值', async () => {
      const session = onboarding.createSession();
      await onboarding.submitStep(session.id, 2, { values: ['诚信', '勇气', '创造力'] });
      const values = [...core.values.getAll().values()];
      assert.equal(values.length, 3);
      /* 首个值权重最高 */
      const sorted = values.sort((a, b) => b.weight - a.weight);
      assert.equal(sorted[0].label, '诚信');
    });

    it('Step 3: 创建记忆种子', async () => {
      const session = onboarding.createSession();
      await onboarding.submitStep(session.id, 3, {
        memories: [
          { description: '辞去稳定工作创业', valence: 0.8, salience: 0.9 },
          { description: '帮助朋友度过难关' },
        ],
      });
      const memories = core.memories.getAllMemories();
      assert.equal(memories.size, 2);
    });

    it('Step 4: 运行首次模拟', async () => {
      const session = onboarding.createSession();
      await onboarding.submitStep(session.id, 1, { title: '测试决策', description: '测试描述' });
      core.addValue('诚信', 0.8);
      const updated = await onboarding.submitStep(session.id, 4, {});
      assert.ok(updated.simulationResult);
      assert.ok(updated.simulationResult.rankedOptions.length > 0);
    });

    it('Step 5: 保存基线快照', async () => {
      const session = onboarding.createSession();
      await onboarding.submitStep(session.id, 1, { title: '测试', description: '描述' });
      core.addValue('诚信', 0.8);
      await onboarding.submitStep(session.id, 4, {});
      const updated = await onboarding.submitStep(session.id, 5, {});
      assert.ok(updated.snapshotId);
      assert.equal(snapshotCount, 1);
    });

    it('无效步骤抛出 RangeError', async () => {
      const session = onboarding.createSession();
      await assert.rejects(
        () => onboarding.submitStep(session.id, 99, {}),
        { name: 'RangeError' },
      );
    });

    it('不存在的会话抛出错误', async () => {
      await assert.rejects(() => onboarding.submitStep('nonexistent', 1, {}));
    });

    it('触发 step-completed 事件', async () => {
      let stepEvent: { sessionId: string; step: number } | undefined;
      bus.on('onboarding:step-completed', (e) => { stepEvent = e; });
      const session = onboarding.createSession();
      await onboarding.submitStep(session.id, 1, { title: '测试', description: '描述' });
      assert.ok(stepEvent);
      assert.equal(stepEvent.step, 1);
    });

    it('Step 5 触发 onboarding:completed 事件', async () => {
      let completedEvent: { sessionId: string; snapshotId: string } | undefined;
      bus.on('onboarding:completed', (e) => { completedEvent = e; });
      const session = onboarding.createSession();
      await onboarding.submitStep(session.id, 1, { title: '测试', description: '描述' });
      core.addValue('诚信', 0.8);
      await onboarding.submitStep(session.id, 4, {});
      await onboarding.submitStep(session.id, 5, {});
      assert.ok(completedEvent);
      assert.equal(completedEvent.sessionId, session.id);
      assert.ok(completedEvent.snapshotId);
    });
  });
});
