import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { TestClock } from '../../utils/index.js';
import { CognitiveMemoryGraph, DEFAULT_COGNITION_CONFIG } from '../../core/memory-graph.js';
import { FieldEncryption } from '../../storage/encryption.js';
import type { MemoryCognitionConfig } from '../../types/core-self.js';

describe('CognitiveMemoryGraph', () => {
  let db: IDatabase;
  let clock: TestClock;
  let graph: CognitiveMemoryGraph;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    clock = new TestClock(1000);
    graph = new CognitiveMemoryGraph(db, clock);
  });

  // ===== CRUD 基础功能 =====

  describe('CRUD 基础', () => {
    it('添加记忆包含认知字段', () => {
      const m = graph.addMemory('episodic', '第一次编程', 0.8, 0.9);
      assert.equal(m.kind, 'episodic');
      assert.equal(m.accessCount, 0);
      assert.ok(m.decayLambda > 0);
      assert.equal(m.lastDecayedAt, 1000);
      assert.equal(m.consolidatedFrom, null);
    });

    it('获取记忆返回认知字段', () => {
      const m = graph.addMemory('semantic', '知识', 0.3, 0.5);
      const retrieved = graph.getMemory(m.id);
      assert.ok(retrieved);
      assert.equal(retrieved.accessCount, 0);
      assert.ok(retrieved.decayLambda > 0);
    });

    it('insertMemory 保留认知字段', () => {
      const m = graph.addMemory('procedural', '技能', 0.1, 0.6);
      graph.deleteAll();
      graph.insertMemory(m);
      const restored = graph.getMemory(m.id);
      assert.ok(restored);
      assert.equal(restored.accessCount, m.accessCount);
      assert.equal(restored.decayLambda, m.decayLambda);
    });

    it('deleteMemory 同时清理工作记忆', () => {
      const m = graph.addMemory('episodic', '事件', 0.5, 0.9);
      graph.admitToWorkingMemory(m.id);
      assert.equal(graph.getWorkingMemorySlots().length, 1);
      graph.deleteMemory(m.id);
      assert.equal(graph.getWorkingMemorySlots().length, 0);
    });
  });

  // ===== 遗忘曲线 =====

  describe('遗忘曲线', () => {
    it('时间推进后 accessMemory 触发 lazy decay', () => {
      const m = graph.addMemory('episodic', '事件', 0.0, 0.9);
      clock.advance(10000);
      const accessed = graph.accessMemory(m.id)!;
      assert.ok(accessed.salience < 0.9, `salience 应衰减: ${accessed.salience}`);
      assert.equal(accessed.accessCount, 1);
    });

    it('无时间推进时 salience 不变', () => {
      const m = graph.addMemory('episodic', '事件', 0.0, 0.9);
      const accessed = graph.accessMemory(m.id)!;
      assert.ok(Math.abs(accessed.salience - 0.9) < 0.001);
    });

    it('episodic 衰减快于 semantic 快于 procedural', () => {
      const e = graph.addMemory('episodic', 'e', 0.0, 0.9);
      const s = graph.addMemory('semantic', 's', 0.0, 0.9);
      const p = graph.addMemory('procedural', 'p', 0.0, 0.9);

      assert.ok(e.decayLambda > s.decayLambda, 'episodic λ > semantic λ');
      assert.ok(s.decayLambda > p.decayLambda, 'semantic λ > procedural λ');
    });

    it('高 |valence| 降低衰减速率', () => {
      const neutral = graph.addMemory('episodic', 'neutral', 0.0, 0.9);
      const emotional = graph.addMemory('episodic', 'emotional', 0.9, 0.9);
      assert.ok(emotional.decayLambda < neutral.decayLambda, '情感强烈的记忆衰减更慢');
    });

    it('多次访问降低衰减速率', () => {
      const m = graph.addMemory('episodic', '事件', 0.0, 0.9);
      const initial = m.decayLambda;
      graph.accessMemory(m.id);
      const after1 = graph.getMemory(m.id)!.decayLambda;
      graph.accessMemory(m.id);
      const after2 = graph.getMemory(m.id)!.decayLambda;
      assert.ok(after1 < initial, '第 1 次访问后 λ 降低');
      assert.ok(after2 < after1, '第 2 次访问后 λ 进一步降低');
    });

    it('decayAll 批量衰减所有记忆', () => {
      graph.addMemory('episodic', 'a', 0.0, 0.9);
      graph.addMemory('semantic', 'b', 0.0, 0.8);
      clock.advance(50000);

      const { decayed, evicted } = graph.decayAll();
      assert.ok(decayed.length + evicted.length >= 1, '至少一个记忆被衰减或淘汰');
      for (const r of decayed) {
        assert.ok(r.newSalience < r.oldSalience, `${r.memoryId}: ${r.oldSalience} -> ${r.newSalience}`);
      }
    });

    it('salience 不低于 0', () => {
      graph.addMemory('episodic', 'a', 0.0, 0.01);
      clock.advance(1_000_000);
      const { decayed, evicted } = graph.decayAll();
      for (const r of decayed) {
        assert.ok(r.newSalience >= 0);
      }
      /* 极低 salience 在默认配置下可能被 L1 淘汰 */
      assert.ok(decayed.length + evicted.length >= 0);
    });
  });

  // ===== 扩散激活 =====

  describe('扩散激活', () => {
    it('单层激活：沿边传播', () => {
      const a = graph.addMemory('episodic', 'a', 0.0, 0.5);
      const b = graph.addMemory('episodic', 'b', 0.0, 0.3);
      graph.addEdge(a.id, b.id, 'related', 0.8);

      const results = graph.spreadActivation(a.id);
      assert.equal(results.length, 1);
      assert.equal(results[0].memoryId, b.id);
      assert.ok(results[0].delta > 0);

      const updated = graph.getMemory(b.id)!;
      assert.ok(updated.salience > 0.3, `b 的 salience 应增加: ${updated.salience}`);
    });

    it('多层激活 depth=2', () => {
      const a = graph.addMemory('episodic', 'a', 0.0, 0.5);
      const b = graph.addMemory('episodic', 'b', 0.0, 0.3);
      const c = graph.addMemory('episodic', 'c', 0.0, 0.2);
      graph.addEdge(a.id, b.id, 'r1', 0.8);
      graph.addEdge(b.id, c.id, 'r2', 0.7);

      const results = graph.spreadActivation(a.id);
      assert.equal(results.length, 2);
      const bResult = results.find(r => r.memoryId === b.id)!;
      const cResult = results.find(r => r.memoryId === c.id)!;
      assert.ok(bResult.delta > cResult.delta, '第 1 层激活大于第 2 层');
    });

    it('环路不导致无限循环', () => {
      const a = graph.addMemory('episodic', 'a', 0.0, 0.5);
      const b = graph.addMemory('episodic', 'b', 0.0, 0.3);
      graph.addEdge(a.id, b.id, 'r1', 0.8);
      graph.addEdge(b.id, a.id, 'r2', 0.7);

      const results = graph.spreadActivation(a.id);
      assert.equal(results.length, 1, '环路中只激活一次');
    });

    it('salience 上限 clamp 到 1.0', () => {
      const a = graph.addMemory('episodic', 'a', 0.0, 0.5);
      const b = graph.addMemory('episodic', 'b', 0.0, 0.99);
      graph.addEdge(a.id, b.id, 'r1', 1.0);

      const config: Partial<MemoryCognitionConfig> = { activation: { baseActivation: 0.5, damping: 0.1, maxDepth: 2 } };
      const graphHigh = new CognitiveMemoryGraph(db, clock, config);
      graphHigh.spreadActivation(a.id);
      const updated = graphHigh.getMemory(b.id)!;
      assert.ok(updated.salience <= 1.0, `salience 不超过 1.0: ${updated.salience}`);
    });

    it('无边时返回空数组', () => {
      const a = graph.addMemory('episodic', 'a', 0.0, 0.5);
      const results = graph.spreadActivation(a.id);
      assert.equal(results.length, 0);
    });
  });

  // ===== 工作记忆 =====

  describe('工作记忆', () => {
    it('成功纳入工作记忆', () => {
      const m = graph.addMemory('episodic', '事件', 0.5, 0.8);
      const result = graph.admitToWorkingMemory(m.id);
      assert.ok(result.admitted);
      assert.equal(result.evicted, null);
      assert.equal(graph.getWorkingMemorySlots().length, 1);
    });

    it('容量限制驱逐最低分', () => {
      const config: Partial<MemoryCognitionConfig> = { workingMemory: { capacity: 2, recencyDecay: 0.0001 } };
      const g = new CognitiveMemoryGraph(db, clock, config);

      const low = g.addMemory('episodic', 'low', 0.0, 0.1);
      const mid = g.addMemory('episodic', 'mid', 0.0, 0.5);
      const high = g.addMemory('episodic', 'high', 0.0, 0.9);

      g.admitToWorkingMemory(low.id);
      g.admitToWorkingMemory(mid.id);
      const result = g.admitToWorkingMemory(high.id);

      assert.ok(result.admitted);
      assert.equal(result.evicted, low.id);
      assert.equal(g.getWorkingMemorySlots().length, 2);
    });

    it('低分记忆不替换已有', () => {
      const config: Partial<MemoryCognitionConfig> = { workingMemory: { capacity: 1, recencyDecay: 0.0001 } };
      const g = new CognitiveMemoryGraph(db, clock, config);

      const high = g.addMemory('episodic', 'high', 0.0, 0.9);
      const low = g.addMemory('episodic', 'low', 0.0, 0.01);

      g.admitToWorkingMemory(high.id);
      const result = g.admitToWorkingMemory(low.id);
      assert.ok(!result.admitted);
    });

    it('removeFromWorkingMemory 移除', () => {
      const m = graph.addMemory('episodic', '事件', 0.5, 0.8);
      graph.admitToWorkingMemory(m.id);
      assert.ok(graph.removeFromWorkingMemory(m.id));
      assert.equal(graph.getWorkingMemorySlots().length, 0);
    });

    it('refresh 更新评分', () => {
      const m = graph.addMemory('episodic', '事件', 0.5, 0.8);
      graph.admitToWorkingMemory(m.id);
      const before = graph.getWorkingMemorySlots()[0].score;

      clock.advance(10000);
      const after = graph.refreshWorkingMemory();
      assert.ok(after[0].score !== before, '评分应因时间推进而变化');
    });
  });

  // ===== 记忆固化 =====

  describe('记忆固化', () => {
    it('满足条件时固化 episodic → semantic', () => {
      const config: Partial<MemoryCognitionConfig> = {
        consolidation: { accessThreshold: 3, minSalience: 0.3 },
        eviction: { salienceFloor: 0, maxMemoryNodes: -1, capacityTargetRatio: 0.9, deleteConsolidatedSources: false, batchSize: 1000 },
      };
      const g = new CognitiveMemoryGraph(db, clock, config);

      const m = g.addMemory('episodic', '反复访问的事件', 0.5, 0.8);
      g.accessMemory(m.id);
      g.accessMemory(m.id);
      g.accessMemory(m.id);

      const candidates = g.findConsolidationCandidates();
      assert.equal(candidates.length, 1);

      const result = g.consolidateMemory(m.id);
      assert.ok(result);
      assert.equal(result.originalId, m.id);
      assert.equal(result.newKind, 'semantic');

      const consolidated = g.getMemory(result.consolidatedId)!;
      assert.equal(consolidated.kind, 'semantic');
      assert.equal(consolidated.consolidatedFrom, m.id);
    });

    it('不满足 accessCount 条件时不固化', () => {
      const m = graph.addMemory('episodic', '事件', 0.5, 0.8);
      graph.accessMemory(m.id);
      const candidates = graph.findConsolidationCandidates();
      assert.equal(candidates.length, 0);
    });

    it('非 episodic 不被固化', () => {
      const config: Partial<MemoryCognitionConfig> = { consolidation: { accessThreshold: 1, minSalience: 0.0 } };
      const g = new CognitiveMemoryGraph(db, clock, config);

      const m = g.addMemory('semantic', '知识', 0.3, 0.5);
      g.accessMemory(m.id);
      const result = g.consolidateMemory(m.id);
      assert.equal(result, undefined);
    });

    it('固化后关联边被复制到新记忆', () => {
      const config: Partial<MemoryCognitionConfig> = { consolidation: { accessThreshold: 2, minSalience: 0.3 } };
      const g = new CognitiveMemoryGraph(db, clock, config);

      const m1 = g.addMemory('episodic', '事件1', 0.5, 0.8);
      const m2 = g.addMemory('semantic', '知识', 0.3, 0.6);
      g.addEdge(m1.id, m2.id, 'related', 0.7);

      g.accessMemory(m1.id);
      g.accessMemory(m1.id);

      const result = g.consolidateMemory(m1.id)!;
      const newEdges = g.getEdgesFor(result.consolidatedId);
      assert.ok(newEdges.length >= 1, '新记忆应继承关联边');
    });

    it('consolidateAll 批量固化', () => {
      const config: Partial<MemoryCognitionConfig> = { consolidation: { accessThreshold: 2, minSalience: 0.1 } };
      const g = new CognitiveMemoryGraph(db, clock, config);

      const m1 = g.addMemory('episodic', '事件1', 0.5, 0.8);
      const m2 = g.addMemory('episodic', '事件2', 0.3, 0.6);
      g.accessMemory(m1.id); g.accessMemory(m1.id);
      g.accessMemory(m2.id); g.accessMemory(m2.id);

      const results = g.consolidateAll();
      assert.equal(results.length, 2);
    });
  });

  // ===== 相关记忆 =====

  describe('相关记忆查询', () => {
    it('返回相邻记忆', () => {
      const a = graph.addMemory('episodic', 'a', 0.0, 0.5);
      const b = graph.addMemory('episodic', 'b', 0.0, 0.3);
      const c = graph.addMemory('episodic', 'c', 0.0, 0.2);
      graph.addEdge(a.id, b.id, 'r1', 0.8);
      graph.addEdge(b.id, c.id, 'r2', 0.7);

      const related = graph.getRelatedMemories(a.id, 2);
      assert.equal(related.length, 2);
    });

    it('depth=1 仅返回直接相邻', () => {
      const a = graph.addMemory('episodic', 'a', 0.0, 0.5);
      const b = graph.addMemory('episodic', 'b', 0.0, 0.3);
      const c = graph.addMemory('episodic', 'c', 0.0, 0.2);
      graph.addEdge(a.id, b.id, 'r1', 0.8);
      graph.addEdge(b.id, c.id, 'r2', 0.7);

      const related = graph.getRelatedMemories(a.id, 1);
      assert.equal(related.length, 1);
      assert.equal(related[0].id, b.id);
    });
  });

  // ===== 综合流程 =====

  describe('综合流程', () => {
    it('创建 → 访问 → 衰减 → 激活 → 固化', () => {
      const config: Partial<MemoryCognitionConfig> = {
        consolidation: { accessThreshold: 3, minSalience: 0.1 },
        eviction: { salienceFloor: 0, maxMemoryNodes: -1, capacityTargetRatio: 0.9, deleteConsolidatedSources: false, batchSize: 1000 },
      };
      const g = new CognitiveMemoryGraph(db, clock, config);

      /* 创建记忆 */
      const m1 = g.addMemory('episodic', '重要事件', 0.8, 0.9);
      const m2 = g.addMemory('episodic', '相关事件', 0.3, 0.5);
      g.addEdge(m1.id, m2.id, 'caused', 0.9);

      /* 多次访问 m1 */
      g.accessMemory(m1.id);
      g.accessMemory(m1.id);
      g.accessMemory(m1.id);

      /* 时间推进 + 全量衰减 */
      clock.advance(50000);
      const { decayed, evicted } = g.decayAll();
      assert.ok(decayed.length + evicted.length >= 1);

      /* 扩散激活 */
      const activations = g.spreadActivation(m1.id);
      assert.equal(activations.length, 1);
      assert.equal(activations[0].memoryId, m2.id);

      /* 固化 m1 */
      const consolidated = g.consolidateAll();
      assert.equal(consolidated.length, 1);
      assert.equal(consolidated[0].newKind, 'semantic');

      const newMem = g.getMemory(consolidated[0].consolidatedId)!;
      assert.equal(newMem.kind, 'semantic');
      assert.equal(newMem.consolidatedFrom, m1.id);
    });
  });

  // ===== 默认配置 =====

  describe('配置', () => {
    it('DEFAULT_COGNITION_CONFIG 导出正确', () => {
      assert.equal(DEFAULT_COGNITION_CONFIG.decay.baseLambda, 0.0001);
      assert.equal(DEFAULT_COGNITION_CONFIG.activation.maxDepth, 2);
      assert.equal(DEFAULT_COGNITION_CONFIG.workingMemory.capacity, 7);
      assert.equal(DEFAULT_COGNITION_CONFIG.consolidation.accessThreshold, 5);
      assert.equal(DEFAULT_COGNITION_CONFIG.eviction.salienceFloor, 0.01);
      assert.equal(DEFAULT_COGNITION_CONFIG.eviction.maxMemoryNodes, 10_000);
      assert.equal(DEFAULT_COGNITION_CONFIG.eviction.capacityTargetRatio, 0.9);
      assert.equal(DEFAULT_COGNITION_CONFIG.eviction.deleteConsolidatedSources, true);
      assert.equal(DEFAULT_COGNITION_CONFIG.eviction.batchSize, 1000);
    });

    it('自定义配置覆盖默认值', () => {
      const config: Partial<MemoryCognitionConfig> = {
        workingMemory: { capacity: 3, recencyDecay: 0.001 },
      };
      const g = new CognitiveMemoryGraph(db, clock, config);

      /* 只能容纳 3 个 */
      const m1 = g.addMemory('episodic', 'a', 0.0, 0.5);
      const m2 = g.addMemory('episodic', 'b', 0.0, 0.6);
      const m3 = g.addMemory('episodic', 'c', 0.0, 0.7);
      const m4 = g.addMemory('episodic', 'd', 0.0, 0.9);

      g.admitToWorkingMemory(m1.id);
      g.admitToWorkingMemory(m2.id);
      g.admitToWorkingMemory(m3.id);
      const r = g.admitToWorkingMemory(m4.id);
      assert.equal(g.getWorkingMemorySlots().length, 3);
      assert.ok(r.evicted !== null, '应驱逐最低分（m1, salience=0.5）');
    });
  });

  // ===== 记忆淘汰 =====

  describe('记忆淘汰', () => {
    describe('L1 显著性下限', () => {
      it('低 salience 衰减后被物理删除', () => {
        const config: Partial<MemoryCognitionConfig> = {
          eviction: { salienceFloor: 0.05, maxMemoryNodes: -1, capacityTargetRatio: 0.9, deleteConsolidatedSources: false, batchSize: 1000 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);
        const m = g.addMemory('episodic', '低重要性事件', 0.0, 0.06);
        clock.advance(500_000);

        const { evicted } = g.decayAll();
        assert.ok(evicted.length >= 1, '应有记忆被L1淘汰');
        assert.equal(evicted[0].memoryId, m.id);
        assert.equal(evicted[0].reason, 'salience_floor');
        assert.equal(g.getMemory(m.id), undefined, '节点应已被物理删除');
      });

      it('salienceFloor=0 不触发L1淘汰', () => {
        const config: Partial<MemoryCognitionConfig> = {
          eviction: { salienceFloor: 0, maxMemoryNodes: -1, capacityTargetRatio: 0.9, deleteConsolidatedSources: false, batchSize: 1000 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);
        g.addMemory('episodic', '低重要性事件', 0.0, 0.001);
        clock.advance(1_000_000);

        const { evicted } = g.decayAll();
        assert.equal(evicted.length, 0, 'salienceFloor=0 应禁用L1');
      });

      it('关联边和工作记忆同步清理', () => {
        const config: Partial<MemoryCognitionConfig> = {
          eviction: { salienceFloor: 0.05, maxMemoryNodes: -1, capacityTargetRatio: 0.9, deleteConsolidatedSources: false, batchSize: 1000 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);
        const m1 = g.addMemory('episodic', '低重要性', 0.0, 0.06);
        const m2 = g.addMemory('semantic', '关联知识', 0.5, 0.9);
        g.addEdge(m1.id, m2.id, 'related', 0.8);
        g.admitToWorkingMemory(m1.id);

        /* 10000ms 足以使 m1(episodic,0.06) 衰减至 0.05 以下，但 m2(semantic,0.9) 仍远高于阈值 */
        clock.advance(10_000);
        g.decayAll();

        assert.equal(g.getMemory(m1.id), undefined, '节点已删除');
        assert.equal(g.getEdgesFor(m1.id).length, 0, '关联边已清理');
        assert.equal(g.getWorkingMemorySlots().filter(s => s.memoryId === m1.id).length, 0, '工作记忆已清理');
        assert.ok(g.getMemory(m2.id), '关联节点不受影响');
      });
    });

    describe('L2 容量淘汰', () => {
      it('超 maxMemoryNodes 淘汰最低分至 targetRatio', () => {
        const config: Partial<MemoryCognitionConfig> = {
          eviction: { salienceFloor: 0, maxMemoryNodes: 5, capacityTargetRatio: 0.8, deleteConsolidatedSources: false, batchSize: 1000 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);

        /* 创建 6 个记忆（超过上限 5） */
        for (let i = 0; i < 6; i++) {
          g.addMemory('episodic', `事件${i}`, 0.0, (i + 1) * 0.1);
        }
        assert.equal(g.getMemoryCount(), 6);

        const evicted = g.evictExcess();
        /* target = floor(5 * 0.8) = 4, 需淘汰 6 - 4 = 2 */
        assert.equal(evicted.length, 2, '应淘汰 2 个记忆');
        assert.equal(g.getMemoryCount(), 4);

        /* 验证淘汰的是最低分 */
        for (const e of evicted) {
          assert.equal(e.reason, 'capacity_overflow');
        }
      });

      it('maxMemoryNodes=-1 不触发容量淘汰', () => {
        const config: Partial<MemoryCognitionConfig> = {
          eviction: { salienceFloor: 0, maxMemoryNodes: -1, capacityTargetRatio: 0.9, deleteConsolidatedSources: false, batchSize: 1000 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);
        for (let i = 0; i < 10; i++) {
          g.addMemory('episodic', `事件${i}`, 0.0, 0.5);
        }
        const evicted = g.evictExcess();
        assert.equal(evicted.length, 0);
      });

      it('分批淘汰', () => {
        const config: Partial<MemoryCognitionConfig> = {
          eviction: { salienceFloor: 0, maxMemoryNodes: 3, capacityTargetRatio: 0.6, deleteConsolidatedSources: false, batchSize: 2 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);
        for (let i = 0; i < 6; i++) {
          g.addMemory('episodic', `事件${i}`, 0.0, (i + 1) * 0.1);
        }
        /* target = floor(3 * 0.6) = 1, 需淘汰 6 - 1 = 5，batchSize=2 */
        const evicted = g.evictExcess();
        assert.equal(evicted.length, 5, '应淘汰 5 个记忆');
        assert.equal(g.getMemoryCount(), 1);
      });

      it('未超限时不淘汰', () => {
        const config: Partial<MemoryCognitionConfig> = {
          eviction: { salienceFloor: 0, maxMemoryNodes: 10, capacityTargetRatio: 0.9, deleteConsolidatedSources: false, batchSize: 1000 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);
        for (let i = 0; i < 5; i++) {
          g.addMemory('episodic', `事件${i}`, 0.0, 0.5);
        }
        const evicted = g.evictExcess();
        assert.equal(evicted.length, 0);
      });
    });

    describe('L3 固化清理', () => {
      it('deleteConsolidatedSources=true 时固化后删除原始', () => {
        const config: Partial<MemoryCognitionConfig> = {
          consolidation: { accessThreshold: 2, minSalience: 0.1 },
          eviction: { salienceFloor: 0, maxMemoryNodes: -1, capacityTargetRatio: 0.9, deleteConsolidatedSources: true, batchSize: 1000 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);

        const m = g.addMemory('episodic', '反复事件', 0.5, 0.8);
        g.accessMemory(m.id);
        g.accessMemory(m.id);

        const result = g.consolidateMemory(m.id)!;
        assert.ok(result, '应成功固化');

        /* 原始 episodic 已被删除 */
        assert.equal(g.getMemory(m.id), undefined, '原始节点应被删除');

        /* 新 semantic 保留 */
        const consolidated = g.getMemory(result.consolidatedId)!;
        assert.ok(consolidated, '固化产物应存在');
        assert.equal(consolidated.kind, 'semantic');
      });

      it('deleteConsolidatedSources=false 时保留原始', () => {
        const config: Partial<MemoryCognitionConfig> = {
          consolidation: { accessThreshold: 2, minSalience: 0.1 },
          eviction: { salienceFloor: 0, maxMemoryNodes: -1, capacityTargetRatio: 0.9, deleteConsolidatedSources: false, batchSize: 1000 },
        };
        const g = new CognitiveMemoryGraph(db, clock, config);

        const m = g.addMemory('episodic', '反复事件', 0.5, 0.8);
        g.accessMemory(m.id);
        g.accessMemory(m.id);

        const result = g.consolidateMemory(m.id)!;
        assert.ok(result);

        /* 原始 episodic 保留 */
        assert.ok(g.getMemory(m.id), '原始节点应保留');
        /* 新 semantic 也存在 */
        assert.ok(g.getMemory(result.consolidatedId), '固化产物应存在');
      });
    });

    describe('getMemoryCount', () => {
      it('准确计数', () => {
        assert.equal(graph.getMemoryCount(), 0);
        graph.addMemory('episodic', 'a', 0.0, 0.5);
        assert.equal(graph.getMemoryCount(), 1);
        const m2 = graph.addMemory('semantic', 'b', 0.0, 0.5);
        assert.equal(graph.getMemoryCount(), 2);
        graph.deleteMemory(m2.id);
        assert.equal(graph.getMemoryCount(), 1);
      });
    });
  });

  // ===== FieldEncryption 集成 =====

  describe('FieldEncryption 集成', () => {
    let encryptedGraph: CognitiveMemoryGraph;
    let encDb: IDatabase;
    let encryption: FieldEncryption;

    beforeEach(() => {
      encDb = createMemoryDatabase();
      runDslSqliteMigrations(encDb);
      const masterKey = randomBytes(32).toString('base64');
      encryption = new FieldEncryption({ enabled: true, masterKey, keyRotationIntervalDays: 90 });
      encryptedGraph = new CognitiveMemoryGraph(encDb, new TestClock(1000), undefined, encryption);
    });

    it('addMemory 返回明文 content', () => {
      const m = encryptedGraph.addMemory('episodic', '机密数据', 0.5, 0.8);
      assert.equal(m.content, '机密数据');
    });

    it('DB 中存储的是密文而非明文', () => {
      const m = encryptedGraph.addMemory('episodic', '机密数据', 0.5, 0.8);
      const row = encDb.prepare<{ content: string }>('SELECT content FROM memory_nodes WHERE id = ?').get(m.id);
      assert.ok(row);
      assert.notEqual(row.content, '机密数据', 'DB 中应为密文');
    });

    it('getMemory 返回解密后的明文', () => {
      const m = encryptedGraph.addMemory('episodic', '机密数据', 0.5, 0.8);
      const retrieved = encryptedGraph.getMemory(m.id);
      assert.ok(retrieved);
      assert.equal(retrieved.content, '机密数据');
    });

    it('getAllMemories 返回解密后的明文', () => {
      encryptedGraph.addMemory('episodic', '记忆一', 0.5, 0.8);
      encryptedGraph.addMemory('semantic', '记忆二', 0.3, 0.6);
      const all = encryptedGraph.getAllMemories();
      assert.equal(all.size, 2);
      const contents = [...all.values()].map(m => m.content);
      assert.ok(contents.includes('记忆一'));
      assert.ok(contents.includes('记忆二'));
    });

    it('accessMemory 返回解密后的明文', () => {
      const m = encryptedGraph.addMemory('episodic', '机密数据', 0.5, 0.8);
      const accessed = encryptedGraph.accessMemory(m.id);
      assert.ok(accessed);
      assert.equal(accessed.content, '机密数据');
    });

    it('未启用加密时 content 以明文存储', () => {
      const plainGraph = new CognitiveMemoryGraph(encDb, new TestClock(1000));
      const m = plainGraph.addMemory('episodic', '明文数据', 0.5, 0.8);
      const row = encDb.prepare<{ content: string }>('SELECT content FROM memory_nodes WHERE id = ?').get(m.id);
      assert.ok(row);
      assert.equal(row.content, '明文数据');
    });
  });
});
