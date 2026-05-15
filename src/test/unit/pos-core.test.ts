import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { SurvivalAnchorStore } from '../../core/survival-anchor-store.js';
import { ValueStore } from '../../core/value-store.js';
import { DecisionStyleStore, DEFAULT_DECISION_STYLE } from '../../core/decision-style-store.js';
import { CognitiveModelStore } from '../../core/cognitive-model-store.js';
import { compilePersonaState, summarizeForPrompt } from '../../intelligence/persona-state.js';

describe('P-OS v0.1 五层人格模型', () => {
  let db: IDatabase;
  let clock: TestClock;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    clock = new TestClock(1000);
  });

  describe('ValueStore 直接构造自注册', () => {
    it('无需外部注册即可直接创建和查询', () => {
      const store = new ValueStore(db, clock);
      const val = store.create('诚实', 0.8);
      assert.ok(val.id.startsWith('val_'));
      assert.equal(val.label, '诚实');
      assert.equal(val.weight, 0.8);
      const found = store.getById(val.id);
      assert.deepEqual(found, val);
    });
  });

  describe('SurvivalAnchorStore (L0)', () => {
    let store: SurvivalAnchorStore;
    beforeEach(() => { store = new SurvivalAnchorStore(db, clock); });

    it('创建和获取锚点', () => {
      const anchor = store.create('风险底线', 'threshold', 0.2, 4);
      assert.ok(anchor.id.startsWith('anchor_'));
      assert.equal(anchor.label, '风险底线');
      assert.equal(anchor.kind, 'threshold');
      assert.equal(anchor.value, 0.2);
      assert.equal(anchor.severity, 4);

      const loaded = store.getById(anchor.id);
      assert.deepEqual(loaded, anchor);
    });

    it('获取全部锚点', () => {
      store.create('禁区1', 'constraint', 'no_harm', 5);
      store.create('阈值1', 'threshold', 0.1, 3);
      const all = store.getAll();
      assert.equal(all.length, 2);
    });

    it('更新锚点', () => {
      const a = store.create('底线', 'constraint', null, 3);
      clock.advance(100);
      const updated = store.update(a.id, { severity: 5, label: '核心底线' });
      assert.ok(updated);
      assert.equal(updated!.severity, 5);
      assert.equal(updated!.label, '核心底线');
      assert.equal(updated!.updatedAt, 1100);
    });

    it('更新不存在的锚点返回 undefined', () => {
      assert.equal(store.update('nonexistent', { severity: 1 }), undefined);
    });

    it('删除锚点', () => {
      const a = store.create('临时', 'must_have', true, 1);
      assert.ok(store.delete(a.id));
      assert.equal(store.getById(a.id), undefined);
      assert.ok(!store.delete('nonexistent'));
    });

    it('kind 校验', () => {
      assert.throws(
        () => store.create('bad', 'invalid' as never, null, 1),
        { name: 'RangeError' },
      );
    });

    it('severity 校验', () => {
      assert.throws(() => store.create('bad', 'constraint', null, 0), { name: 'RangeError' });
      assert.throws(() => store.create('bad', 'constraint', null, 6), { name: 'RangeError' });
      assert.throws(() => store.create('bad', 'constraint', null, 2.5), { name: 'RangeError' });
    });

    it('insert 恢复用', () => {
      const original = store.create('原始', 'threshold', 42, 2);
      store.deleteAll();
      assert.equal(store.getAll().length, 0);
      store.insert(original);
      const restored = store.getById(original.id);
      assert.deepEqual(restored, original);
    });
  });

  describe('DecisionStyleStore (L2)', () => {
    let store: DecisionStyleStore;
    beforeEach(() => { store = new DecisionStyleStore(db, clock); });

    it('未设置时返回默认值', () => {
      const style = store.get();
      assert.equal(style.riskAppetite, DEFAULT_DECISION_STYLE.riskAppetite);
      assert.equal(style.deliberationDepth, DEFAULT_DECISION_STYLE.deliberationDepth);
      assert.equal(style.updatedAt, 0);
    });

    it('设置和获取', () => {
      const style = store.set({ riskAppetite: 0.9, lossAversion: 3.0 });
      assert.equal(style.riskAppetite, 0.9);
      assert.equal(style.lossAversion, 3.0);
      assert.equal(style.timeHorizon, DEFAULT_DECISION_STYLE.timeHorizon);
      assert.equal(style.updatedAt, 1000);

      const loaded = store.get();
      assert.equal(loaded.riskAppetite, 0.9);
    });

    it('riskAppetite 超范围', () => {
      assert.throws(() => store.set({ riskAppetite: 1.5 }), { name: 'RangeError' });
      assert.throws(() => store.set({ riskAppetite: -0.1 }), { name: 'RangeError' });
    });

    it('lossAversion 必须 >= 1', () => {
      assert.throws(() => store.set({ lossAversion: 0.5 }), { name: 'RangeError' });
    });

    it('deliberationDepth 必须为 1-5 整数', () => {
      assert.throws(() => store.set({ deliberationDepth: 0 }), { name: 'RangeError' });
      assert.throws(() => store.set({ deliberationDepth: 6 }), { name: 'RangeError' });
      assert.throws(() => store.set({ deliberationDepth: 2.5 }), { name: 'RangeError' });
    });
  });

  describe('CognitiveModelStore (L3)', () => {
    let store: CognitiveModelStore;
    beforeEach(() => { store = new CognitiveModelStore(db, clock); });

    it('未设置时返回默认值', () => {
      const model = store.get();
      assert.equal(model.beliefs.size, 0);
      assert.equal(model.attributionStyle, 0.5);
      assert.equal(model.growthMindset, 0.5);
      assert.equal(model.updatedAt, 0);
    });

    it('设置信念和偏误', () => {
      const beliefs = new Map([['努力有回报', 0.8], ['世界公平', 0.3]]);
      const biasWeights = new Map([['确认偏误', 0.6]]);
      const model = store.set({ beliefs, biasWeights, attributionStyle: 0.3 });
      assert.equal(model.beliefs.size, 2);
      assert.equal(model.beliefs.get('努力有回报'), 0.8);
      assert.equal(model.biasWeights.get('确认偏误'), 0.6);
      assert.equal(model.attributionStyle, 0.3);

      const loaded = store.get();
      assert.equal(loaded.beliefs.get('世界公平'), 0.3);
    });

    it('attributionStyle 超范围', () => {
      assert.throws(() => store.set({ attributionStyle: 1.5 }), { name: 'RangeError' });
    });

    it('growthMindset 超范围', () => {
      assert.throws(() => store.set({ growthMindset: -0.1 }), { name: 'RangeError' });
    });
  });

  describe('CoreRhythmLayer P-OS facade', () => {
    let bus: EventBus;
    let core: CoreRhythmLayer;

    beforeEach(() => {
      bus = new EventBus();
      core = new CoreRhythmLayer(db, bus, clock, new SilentLogger());
    });

    it('添加和更新生存锚点触发事件', () => {
      const events: unknown[] = [];
      bus.on('core:survival-updated', (e) => events.push(e));

      const anchor = core.addSurvivalAnchor('底线', 'constraint', null, 5);
      assert.equal(events.length, 1);

      core.updateSurvivalAnchor(anchor.id, { severity: 3 });
      assert.equal(events.length, 2);
    });

    it('设置决策风格触发事件', () => {
      const events: unknown[] = [];
      bus.on('core:decision-style-updated', (e) => events.push(e));

      core.setDecisionStyle({ riskAppetite: 0.1 });
      assert.equal(events.length, 1);
    });

    it('设置认知模型触发事件', () => {
      const events: unknown[] = [];
      bus.on('core:cognitive-model-updated', (e) => events.push(e));

      core.setCognitiveModel({ growthMindset: 0.9 });
      assert.equal(events.length, 1);
    });

    it('getState 包含 P-OS 字段', () => {
      core.addSurvivalAnchor('底线', 'constraint', null, 5);
      core.setDecisionStyle({ riskAppetite: 0.1 });
      core.setCognitiveModel({ growthMindset: 0.9 });

      const state = core.getState();
      assert.equal(state.survivalAnchors.length, 1);
      assert.equal(state.decisionStyle.riskAppetite, 0.1);
      assert.equal(state.cognitiveModel.growthMindset, 0.9);
    });

    it('restore 方法恢复 P-OS 状态', () => {
      const anchor = core.addSurvivalAnchor('底线', 'constraint', null, 5);
      core.setDecisionStyle({ riskAppetite: 0.8 });
      core.setCognitiveModel({ beliefs: new Map([['test', 0.7]]) });

      const state = core.getState();

      /* 清空后恢复 */
      core.survival.deleteAll();
      assert.equal(core.survival.getAll().length, 0);

      core.restoreSurvivalAnchors(state.survivalAnchors);
      assert.equal(core.survival.getAll().length, 1);
      assert.equal(core.survival.getById(anchor.id)!.severity, 5);

      core.restoreDecisionStyle(state.decisionStyle);
      assert.equal(core.decisionStyle.get().riskAppetite, 0.8);

      core.restoreCognitiveModel(state.cognitiveModel);
      assert.equal(core.cognitiveModel.get().beliefs.get('test'), 0.7);
    });
  });

  describe('PersonaState 编译器', () => {
    let bus: EventBus;
    let core: CoreRhythmLayer;

    beforeEach(() => {
      bus = new EventBus();
      core = new CoreRhythmLayer(db, bus, clock, new SilentLogger());
    });

    it('compilePersonaState 组装完整 L0-L4', () => {
      core.addValue('诚实', 0.8);
      core.addSurvivalAnchor('底线', 'constraint', null, 5);
      core.setDecisionStyle({ riskAppetite: 0.2 });
      core.setCognitiveModel({ growthMindset: 0.8 });
      core.addMemory('episodic', '重要回忆', 0.5, 0.9);
      core.updateNarrative('测试叙事');

      const state = compilePersonaState(core);
      assert.equal(state.L0.length, 1);
      assert.equal(state.L1.size, 1);
      assert.equal(state.L2.riskAppetite, 0.2);
      assert.equal(state.L3.growthMindset, 0.8);
      assert.equal(state.L4.memories.size, 1);
      assert.equal(state.L4.narrative, '测试叙事');
    });

    it('summarizeForPrompt 生成可读文本', () => {
      core.addValue('诚实', 0.8);
      core.addSurvivalAnchor('底线', 'constraint', null, 5);
      core.setDecisionStyle({ riskAppetite: 0.2 });
      core.setCognitiveModel({ beliefs: new Map([['努力有回报', 0.7]]), growthMindset: 0.8 });
      core.updateNarrative('我是一个诚实的人');

      const state = compilePersonaState(core);
      const summary = summarizeForPrompt(state);

      assert.ok(summary.includes('底线约束 (L0)'));
      assert.ok(summary.includes('核心价值 (L1)'));
      assert.ok(summary.includes('决策风格 (L2)'));
      assert.ok(summary.includes('认知模型 (L3)'));
      assert.ok(summary.includes('自我叙事 (L4)'));
      assert.ok(summary.includes('诚实'));
      assert.ok(summary.includes('努力有回报'));
    });
  });
});
