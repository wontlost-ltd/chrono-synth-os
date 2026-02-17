import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { TestClock } from '../../utils/index.js';
import { UpdateGate } from '../../meta/update-gate.js';

describe('UpdateGate', () => {
  let db: IDatabase;
  let clock: TestClock;
  let gate: UpdateGate;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    clock = new TestClock(1000);
    gate = new UpdateGate(db, clock);
  });

  describe('requiresConfirmation', () => {
    it('L0 默认总是需要确认', () => {
      assert.equal(gate.requiresConfirmation('L0', 0), true);
      assert.equal(gate.requiresConfirmation('L0', 0.01), true);
      assert.equal(gate.requiresConfirmation('L0', 1), true);
    });

    it('L1 小 delta 不需要确认', () => {
      assert.equal(gate.requiresConfirmation('L1', 0.1), false);
      assert.equal(gate.requiresConfirmation('L1', 0.15), false);
    });

    it('L1 大 delta 需要确认', () => {
      assert.equal(gate.requiresConfirmation('L1', 0.16), true);
      assert.equal(gate.requiresConfirmation('L1', 0.5), true);
    });

    it('L1 负 delta 使用绝对值', () => {
      assert.equal(gate.requiresConfirmation('L1', -0.1), false);
      assert.equal(gate.requiresConfirmation('L1', -0.2), true);
    });

    it('自定义 L0 配置', () => {
      const custom = new UpdateGate(db, clock, { l0RequiresConfirmation: false });
      assert.equal(custom.requiresConfirmation('L0', 0), false);
    });

    it('自定义 L1 阈值', () => {
      const custom = new UpdateGate(db, clock, { l1ConfirmationThreshold: 0.5 });
      assert.equal(custom.requiresConfirmation('L1', 0.4), false);
      assert.equal(custom.requiresConfirmation('L1', 0.6), true);
    });
  });

  describe('propose/approve/reject 生命周期', () => {
    it('propose 创建 pending 状态更新', () => {
      const pending = gate.propose({
        layer: 'L1', trigger: 'user_confirmation', targetId: 'v1',
        currentValue: '0.5', proposedValue: '0.8', delta: 0.3, reason: '测试',
      });
      assert.ok(pending.id.startsWith('upd_'));
      assert.equal(pending.status, 'pending');
      assert.equal(pending.layer, 'L1');
      assert.equal(pending.createdAt, 1000);
    });

    it('approve 改变状态为 approved', () => {
      const pending = gate.propose({
        layer: 'L1', trigger: 'statistical_drift', targetId: 'v1',
        currentValue: '0.5', proposedValue: '0.8', delta: 0.3, reason: '漂移',
      });
      const approved = gate.approve(pending.id);
      assert.ok(approved);
      assert.equal(approved!.status, 'approved');
    });

    it('reject 改变状态为 rejected', () => {
      const pending = gate.propose({
        layer: 'L0', trigger: 'emotional_event', targetId: 'a1',
        currentValue: '3', proposedValue: '5', delta: 2, reason: '情绪事件',
      });
      const rejected = gate.reject(pending.id);
      assert.ok(rejected);
      assert.equal(rejected!.status, 'rejected');
    });

    it('approve 不存在的 id 返回 undefined', () => {
      assert.equal(gate.approve('nonexistent'), undefined);
    });

    it('reject 不存在的 id 返回 undefined', () => {
      assert.equal(gate.reject('nonexistent'), undefined);
    });

    it('重复 approve 已批准的更新返回 undefined', () => {
      const pending = gate.propose({
        layer: 'L1', trigger: 'user_confirmation', targetId: 'v1',
        currentValue: '0.5', proposedValue: '0.8', delta: 0.3, reason: '测试',
      });
      gate.approve(pending.id);
      assert.equal(gate.approve(pending.id), undefined);
    });
  });

  describe('getPending', () => {
    it('返回所有 pending 状态的更新', () => {
      gate.propose({
        layer: 'L1', trigger: 'user_confirmation', targetId: 'v1',
        currentValue: '0.5', proposedValue: '0.8', delta: 0.3, reason: '测试1',
      });
      clock.advance(100);
      gate.propose({
        layer: 'L0', trigger: 'emotional_event', targetId: 'a1',
        currentValue: '3', proposedValue: '5', delta: 2, reason: '测试2',
      });
      const pendings = gate.getPending();
      assert.equal(pendings.length, 2);
    });

    it('按 created_at 排序', () => {
      gate.propose({
        layer: 'L1', trigger: 'user_confirmation', targetId: 'v1',
        currentValue: '0.5', proposedValue: '0.8', delta: 0.3, reason: '先',
      });
      clock.advance(100);
      gate.propose({
        layer: 'L1', trigger: 'user_confirmation', targetId: 'v2',
        currentValue: '0.3', proposedValue: '0.6', delta: 0.3, reason: '后',
      });
      const pendings = gate.getPending();
      assert.ok(pendings[0].createdAt <= pendings[1].createdAt);
    });

    it('已批准的不在 pending 列表中', () => {
      const p = gate.propose({
        layer: 'L1', trigger: 'user_confirmation', targetId: 'v1',
        currentValue: '0.5', proposedValue: '0.8', delta: 0.3, reason: '测试',
      });
      gate.approve(p.id);
      assert.equal(gate.getPending().length, 0);
    });
  });

  describe('tryApply', () => {
    it('不需要确认时直接应用', () => {
      let applied = false;
      const result = gate.tryApply('L1', 'user_confirmation', 'v1', '0.5', '0.6', 0.1, '小幅调整', () => {
        applied = true;
      });
      assert.equal(result.applied, true);
      assert.equal(result.pendingUpdate, undefined);
      assert.ok(applied);
    });

    it('需要确认时创建 pending', () => {
      let applied = false;
      const result = gate.tryApply('L1', 'user_confirmation', 'v1', '0.5', '0.8', 0.3, '大幅调整', () => {
        applied = true;
      });
      assert.equal(result.applied, false);
      assert.ok(result.pendingUpdate);
      assert.equal(result.pendingUpdate!.status, 'pending');
      assert.ok(!applied);
    });

    it('L0 总是创建 pending', () => {
      let applied = false;
      const result = gate.tryApply('L0', 'user_confirmation', 'a1', '3', '4', 1, '更新锚点', () => {
        applied = true;
      });
      assert.equal(result.applied, false);
      assert.ok(result.pendingUpdate);
      assert.ok(!applied);
    });
  });

  describe('getById', () => {
    it('返回指定 id 的更新', () => {
      const p = gate.propose({
        layer: 'L1', trigger: 'system_integration', targetId: 'v1',
        currentValue: '0.5', proposedValue: '0.8', delta: 0.3, reason: '集成',
      });
      const found = gate.getById(p.id);
      assert.ok(found);
      assert.equal(found!.id, p.id);
      assert.equal(found!.trigger, 'system_integration');
    });

    it('不存在返回 undefined', () => {
      assert.equal(gate.getById('nonexistent'), undefined);
    });
  });
});
