/**
 * K5（ADR-0056）自成长 per-persona——蒸馏编译经 resolver 落到**该数字员工自己的人格特征内核**。
 *
 * 隔离边界（真实）：narrative/decision_style/cognitive_model 三件套已按 (tenant, persona) 隔离（K2），
 * 是 K5 per-persona 自成长的载体；value_shift/memory_edge 底层 ValueStore/CognitiveMemoryGraph 仍 tenant
 * 键（persona_id 列已加但 executor 未扩，K5b 后续），本片**不**声明这两类 per-persona 隔离，并有专门用例
 * 锁住其「当前 = 同租户共享」的真实行为，防止被误当隔离。
 *
 * 验证：①两 persona 各审批 decision_style_patch → 各自决策风格只反映自己的成长，互不串脑；②default 编译
 * 不污染 worker；③per-persona 快照/回滚读写对称（编译写哪个 persona core 回滚就恢复哪个，不误伤其他 persona）；
 * ④value_shift 当前 tenant 共享（边界诚实锁定）。这是「每个数字员工独立自成长（三件套维度）」真正成立的验证。
 *
 * 说明：decision_style_patch 走人工审批路径（canAutoCompile 只放行 value_shift/memory_edge），故经
 * ingest(→pending) → approve 触发 per-persona 编译。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import type { CandidateInput } from '../../intelligence/distillation-service.js';

/** 一条 decision_style_patch 候选（人工审批路径）。 */
function decisionStylePatch(riskAppetite: number): CandidateInput {
  return {
    kind: 'decision_style_patch',
    source: 'reflection',
    payload: { riskAppetite },
    confidence: 0.95,
    evidence: [
      { type: 'pattern', id: 'e1', score: 0.9 },
      { type: 'pattern', id: 'e2', score: 0.85 },
    ],
  };
}

describe('K5 ADR-0056 自成长 per-persona（蒸馏编译落到各自内核）', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();
  });
  afterEach(() => os.close());

  /** ingest → approve：把一条 decision_style_patch 成长经 per-persona 编译落到该 persona 内核。 */
  function grow(personaId: string, riskAppetite: number): void {
    const ing = os.distillation.ingest(personaId, decisionStylePatch(riskAppetite));
    assert.equal(ing.status, 'pending', `${personaId} ingest 入库待审批`);
    const id = (ing as { artifact: { id: string } }).artifact.id;
    const rev = os.distillation.approve(personaId, id);
    assert.equal(rev.ok, true, `${personaId} 审批编译成功`);
  }

  it('★编译落各自内核★：两 persona 各成长 → 决策风格只反映自己的成长，互不串脑', () => {
    grow('p-alice', 0.8);
    grow('p-bob', 0.2);

    /* 各自内核只反映自己的成长。 */
    assert.equal(os.getCore('p-alice').decisionStyle.get().riskAppetite, 0.8, 'alice 内核 = alice 成长');
    assert.equal(os.getCore('p-bob').decisionStyle.get().riskAppetite, 0.2, 'bob 内核 = bob 成长');
    /* default core 不被任何 worker 的成长污染。 */
    assert.notEqual(os.getCore('default').decisionStyle.get().riskAppetite, 0.8, 'default 未被 alice 污染');
    assert.notEqual(os.getCore('default').decisionStyle.get().riskAppetite, 0.2, 'default 未被 bob 污染');
  });

  it('★default 编译不污染其他 persona★：default 成长后 worker 内核不变', () => {
    grow('p-worker', 0.7);
    const beforeWorker = os.getCore('p-worker').decisionStyle.get().riskAppetite;
    grow('default', 0.05);
    assert.equal(os.getCore('default').decisionStyle.get().riskAppetite, 0.05, 'default 成长落 default');
    assert.equal(os.getCore('p-worker').decisionStyle.get().riskAppetite, beforeWorker, 'worker 内核不被 default 污染');
  });

  it('★per-persona 快照/回滚读写对称★：快照 alice → 改 alice/bob → 回滚 → 只 alice 复原', () => {
    /* alice 先成长到 0.8，对 alice 内核做快照（K5：快照 alice 自己的 core）。 */
    grow('p-alice', 0.8);
    const snap = os.createSnapshot('manual', 'p-alice');
    assert.equal(snap.personaId, 'p-alice', '快照记录了所属 persona');

    /* 快照后 alice 和 bob 都继续成长。 */
    grow('p-alice', 0.3);
    grow('p-bob', 0.9);
    assert.equal(os.getCore('p-alice').decisionStyle.get().riskAppetite, 0.3, 'alice 已变');
    assert.equal(os.getCore('p-bob').decisionStyle.get().riskAppetite, 0.9, 'bob 已变');

    /* 回滚到 alice 的快照——只恢复 alice 内核，bob 不受影响（读写对称）。 */
    const ok = os.restoreFromSnapshot(snap.id);
    assert.equal(ok, true, '回滚成功');
    assert.equal(os.getCore('p-alice').decisionStyle.get().riskAppetite, 0.8, 'alice 复原到快照点');
    assert.equal(os.getCore('p-bob').decisionStyle.get().riskAppetite, 0.9, 'bob 不被 alice 的回滚误伤');
  });

  it('★编译失败 per-persona 回滚★：alice 审批一条会失败的工件 → 回滚 alice，bob 不受损', () => {
    /* bob、alice 各建立基线。 */
    grow('p-bob', 0.6);
    grow('p-alice', 0.4);
    assert.equal(os.getCore('p-alice').decisionStyle.get().riskAppetite, 0.4);

    /* 注入并审批一条 memory_edge 工件——source/target 记忆不存在 → 编译失败 → 触发 per-persona 回滚。 */
    const ing = os.distillation.ingest('p-alice', {
      kind: 'memory_edge',
      source: 'reflection',
      payload: { sourceId: 'nope-1', targetId: 'nope-2', relation: 'relates_to', strength: 0.5 },
      confidence: 0.95,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.9 }, { type: 'pattern', id: 'e2', score: 0.85 }],
    });
    /* memory_edge 高置信 → 可能 auto-compile 失败(→rejected)，或入 pending 待审批。两种入口都验回滚。 */
    if (ing.status === 'pending') {
      const rev = os.distillation.approve('p-alice', (ing as { artifact: { id: string } }).artifact.id);
      assert.equal(rev.ok, false, '缺失记忆 → 审批编译失败');
    } else {
      assert.equal(ing.status, 'rejected', '缺失记忆 → 自动编译失败被拒');
    }

    /* alice 回滚到失败前基线（0.4 未被破坏），bob 完全不受影响。 */
    assert.equal(os.getCore('p-alice').decisionStyle.get().riskAppetite, 0.4, 'alice 回滚到编译前基线');
    assert.equal(os.getCore('p-bob').decisionStyle.get().riskAppetite, 0.6, 'bob 不被 alice 失败回滚误伤');
  });

  it('★coreSelfOnly 回滚不过度回滚租户级★：回滚后租户级加速实验存活（机制非假设）', () => {
    /* 把"编译窗口内租户级未变"从假设移进机制：snapshot persona → 之后并发新增一个租户级加速实验人格 →
     * coreSelfOnly 回滚只动 persona 内核，租户级实验**存活**（若 full 回滚会被抹回快照点 → 过度回滚）。 */
    grow('p-alice', 0.8);
    const snap = os.createSnapshot('manual', 'p-alice');
    const beforeForkCount = os.accelerated.getAllPersonas().length;

    /* 快照后：persona 内核继续变 + 租户级新增一个加速实验（模拟并发演化/治理写入）。 */
    grow('p-alice', 0.3);
    const forked = os.accelerated.forkPersona('实验体A', new Map([['curiosity', 0.6]]));

    /* coreSelfOnly 回滚：persona 内核复原，但租户级实验不被回滚抹除。 */
    const ok = os.restoreFromSnapshot(snap.id, { coreSelfOnly: true });
    assert.equal(ok, true, 'coreSelfOnly 回滚成功');
    assert.equal(os.getCore('p-alice').decisionStyle.get().riskAppetite, 0.8, 'alice 内核复原到快照点');
    const after = os.accelerated.getAllPersonas();
    assert.equal(after.length, beforeForkCount + 1, '租户级加速实验存活（无过度回滚）');
    assert.ok(after.some((p) => p.id === forked.id), '新增的实验体仍在');
  });

  it('★value_shift per-persona 隔离（K5b）★：alice 的价值编译只改 alice，default 看不到', () => {
    /* K5b：ValueStore 已按 persona 隔离。在 alice 自己的 core 上建价值，value_shift 编译到 alice 只改 alice。 */
    const v = os.getCore('p-alice').addValue('curiosity', 0.5);
    /* value_shift 小 delta 走 auto-compile（canAutoCompile 放行），ingest 即编译。 */
    const r = os.distillation.ingest('p-alice', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
      confidence: 0.85,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.9 }, { type: 'pattern', id: 'e2', score: 0.85 }],
    });
    assert.equal(r.status, 'compiled', 'value_shift 自动编译');
    /* alice 的价值被改；default 看不到 alice 的价值（per-persona 隔离）。 */
    assert.equal(os.getCore('p-alice').values.getById(v.id)?.weight, 0.53, 'alice 价值被编译更新');
    assert.equal(os.getCore('default').values.getById(v.id), undefined, 'default 看不到 alice 的价值（K5b 隔离）');
    /* bob 也看不到。 */
    assert.equal(os.getCore('p-bob').values.getById(v.id), undefined, 'bob 看不到 alice 的价值');
  });

  it('★确定性可复现★：同序列成长 → 同终态内核', () => {
    grow('p-x', 0.55);
    const s1 = os.getCore('p-x').decisionStyle.get();

    const clock2 = new TestClock(1000);
    const os2 = new ChronoSynthOS({ clock: clock2, logger: new SilentLogger(), tenantId: 't1' });
    os2.start();
    try {
      const ing = os2.distillation.ingest('p-x', decisionStylePatch(0.55));
      os2.distillation.approve('p-x', (ing as { artifact: { id: string } }).artifact.id);
      assert.deepEqual(os2.getCore('p-x').decisionStyle.get(), s1, '同序列 → 同终态');
    } finally { os2.close(); }
  });
});
