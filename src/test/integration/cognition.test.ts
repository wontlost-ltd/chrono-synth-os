import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';

describe('认知记忆集成测试', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({
      clock,
      logger: new SilentLogger(),
      cognitionConfig: {
        consolidation: { accessThreshold: 3, minSalience: 0.2 },
      },
    });
    os.start();
  });

  afterEach(() => {
    os.close();
  });

  describe('runCognitionCycle', () => {
    it('衰减 + 固化 + 刷新工作记忆', () => {
      const m1 = os.core.addMemory('episodic', '重要事件', 0.8, 0.9);
      const m2 = os.core.addMemory('episodic', '日常事件', 0.1, 0.3);

      /* 多次访问 m1 使其可固化 */
      os.core.accessMemory(m1.id);
      os.core.accessMemory(m1.id);
      os.core.accessMemory(m1.id);

      /* 纳入工作记忆 */
      os.core.memories.admitToWorkingMemory(m1.id);
      os.core.memories.admitToWorkingMemory(m2.id);

      /* 时间推进 */
      clock.advance(100000);

      const { decayedCount, consolidatedCount } = os.runCognitionCycle();
      assert.ok(decayedCount >= 1, `应有记忆被衰减: ${decayedCount}`);
      assert.ok(consolidatedCount >= 1, `应有记忆被固化: ${consolidatedCount}`);
    });
  });

  describe('事件发射', () => {
    it('衰减触发 core:memory-decayed 事件', () => {
      const events: Array<{ memoryId: string; oldSalience: number; newSalience: number }> = [];
      os.bus.on('core:memory-decayed', (e) => events.push(e));

      os.core.addMemory('episodic', '事件', 0.0, 0.9);
      clock.advance(50000);
      os.core.runMemoryDecay();

      assert.ok(events.length >= 1);
      assert.ok(events[0].newSalience < events[0].oldSalience);
    });

    it('激活触发 core:memory-activated 事件', () => {
      let activated = false;
      os.bus.on('core:memory-activated', () => { activated = true; });

      const m1 = os.core.addMemory('episodic', 'a', 0.0, 0.5);
      const m2 = os.core.addMemory('episodic', 'b', 0.0, 0.3);
      os.core.linkMemories(m1.id, m2.id, 'related', 0.8);
      os.core.activateMemory(m1.id);

      assert.ok(activated);
    });

    it('固化触发 core:memory-consolidated 事件', () => {
      let consolidated = false;
      os.bus.on('core:memory-consolidated', () => { consolidated = true; });

      const m = os.core.addMemory('episodic', '事件', 0.5, 0.8);
      os.core.accessMemory(m.id);
      os.core.accessMemory(m.id);
      os.core.accessMemory(m.id);
      os.core.runConsolidation();

      assert.ok(consolidated);
    });
  });

  describe('快照恢复兼容', () => {
    it('认知字段在快照中保留并恢复', () => {
      const m = os.core.addMemory('episodic', '事件', 0.8, 0.9);
      os.core.accessMemory(m.id);
      os.core.accessMemory(m.id);

      const snap = os.createSnapshot('manual');
      const memInSnap = snap.coreSelf.memories.get(m.id)!;
      assert.equal(memInSnap.accessCount, 2);

      /* 清空状态 */
      os.core.memories.deleteAll();
      assert.equal(os.core.getState().memories.size, 0);

      /* 恢复 */
      os.restoreFromSnapshot(snap.id);
      const restored = os.core.memories.getMemory(m.id)!;
      assert.equal(restored.accessCount, 2);
      assert.ok(restored.decayLambda > 0);
    });
  });

  describe('端到端认知流程', () => {
    it('完整的认知生命周期', () => {
      /* 1. 创建记忆网络 */
      const core = os.core.addMemory('episodic', '核心事件', 0.9, 0.95);
      const related1 = os.core.addMemory('episodic', '相关事件1', 0.5, 0.6);
      const related2 = os.core.addMemory('semantic', '背景知识', 0.2, 0.7);
      os.core.linkMemories(core.id, related1.id, 'caused', 0.9);
      os.core.linkMemories(core.id, related2.id, 'context', 0.6);

      /* 2. 多次访问核心事件 */
      for (let i = 0; i < 3; i++) {
        os.core.accessMemory(core.id);
      }

      /* 3. 扩散激活 */
      const activations = os.core.activateMemory(core.id);
      assert.ok(activations.length >= 1, '应有相邻记忆被激活');

      /* 4. 验证 related1 的 salience 增加 */
      const r1After = os.core.memories.getMemory(related1.id)!;
      assert.ok(r1After.salience > related1.salience);

      /* 5. 工作记忆 */
      os.core.memories.admitToWorkingMemory(core.id);
      const wm = os.core.getWorkingMemory();
      assert.equal(wm.length, 1);

      /* 6. 时间推进 + 认知周期 */
      clock.advance(100000);
      const { decayedCount, consolidatedCount } = os.runCognitionCycle();
      assert.ok(decayedCount >= 1);
      assert.ok(consolidatedCount >= 1);

      /* 7. 验证固化结果 */
      const allMems = os.core.getState().memories;
      const semantics = [...allMems.values()].filter(m => m.kind === 'semantic');
      assert.ok(semantics.length >= 2, '应有新的 semantic 记忆（原有 1 + 固化 1）');
    });
  });
});
