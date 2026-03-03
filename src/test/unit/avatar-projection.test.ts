import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaOSState } from '../../types/personality-os.js';
import type { Avatar } from '../../identity/types.js';
import { computeProjection } from '../../identity/avatar-projection-engine.js';

const now = Date.now();

function makeMem(id: string, kind: 'episodic' | 'semantic' | 'procedural', salience: number) {
  return {
    id, kind, content: `${id} 内容`, valence: 0.5, salience,
    createdAt: now, lastAccessedAt: now, accessCount: 1,
    decayLambda: 0.01, lastDecayedAt: now, consolidatedFrom: null,
  };
}

function makeBaseState(): PersonaOSState {
  return {
    L0: [{ id: 'sa_1', label: '健康', kind: 'threshold' as const, value: 0.5, severity: 3, createdAt: now, updatedAt: now }],
    L1: new Map([
      ['v_1', { id: 'v_1', label: '诚实', weight: 0.8, timeDiscount: 0.5, emotionAmplifier: 1.0, updatedAt: now }],
      ['v_2', { id: 'v_2', label: '勇气', weight: 0.6, timeDiscount: 0.5, emotionAmplifier: 1.0, updatedAt: now }],
    ]),
    L2: {
      riskAppetite: 0.5, timeHorizon: 0.5, explorationBias: 0.3,
      lossAversion: 2.0, deliberationDepth: 3, regretSensitivity: 0.5, updatedAt: now,
    },
    L3: {
      beliefs: new Map([['growth', 0.7]]),
      biasWeights: new Map([['confirmation', 0.3]]),
      attributionStyle: 0.5, growthMindset: 0.8, updatedAt: now,
    },
    L4: {
      narrative: '测试叙事',
      memories: new Map([
        ['m_1', makeMem('m_1', 'episodic', 0.8)],
        ['m_2', makeMem('m_2', 'semantic', 0.3)],
      ]),
      edges: [],
    },
  };
}

function makeAvatar(overrides?: Avatar['behaviorOverrides']): Avatar {
  return {
    id: 'avt_1',
    identityId: 'ident_1',
    label: '工作分身',
    kind: 'work',
    behaviorOverrides: overrides ?? null,
    isDefault: false,
    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Avatar 投影引擎', () => {
  it('无行为覆盖时返回原始状态', () => {
    const base = makeBaseState();
    const projected = computeProjection(base, makeAvatar());
    assert.strictEqual(projected, base);
  });

  it('L1 价值权重偏移正确 clamp', () => {
    const base = makeBaseState();
    const avatar = makeAvatar({ valueWeightAdjustments: { v_1: 0.2, v_2: -0.5 } });
    const projected = computeProjection(base, avatar);
    /* v_1: 0.8 + 0.2 = 1.0 */
    assert.equal(projected.L1.get('v_1')!.weight, 1.0);
    /* v_2: 0.6 + clamp(-0.5, -0.3, 0.3) = 0.6 - 0.3 = 0.3 */
    assert.equal(projected.L2.riskAppetite, 0.5); /* 未修改 */
    assert.ok(projected.L1.get('v_2')!.weight >= 0.29 && projected.L1.get('v_2')!.weight <= 0.31);
  });

  it('L2 决策风格覆盖合并', () => {
    const base = makeBaseState();
    const avatar = makeAvatar({ decisionStyleOverrides: { riskAppetite: 0.9 } });
    const projected = computeProjection(base, avatar);
    assert.equal(projected.L2.riskAppetite, 0.9);
    assert.equal(projected.L2.timeHorizon, 0.5); /* 未覆盖的保持不变 */
  });

  it('L3 信念追加', () => {
    const base = makeBaseState();
    const avatar = makeAvatar({ contextBeliefs: { work_ethic: 0.9 } });
    const projected = computeProjection(base, avatar);
    assert.equal(projected.L3.beliefs.get('work_ethic'), 0.9);
    assert.equal(projected.L3.beliefs.get('growth'), 0.7); /* 原有信念保留 */
  });

  it('L4 记忆过滤按 kind', () => {
    const base = makeBaseState();
    const avatar = makeAvatar({ memoryFilter: { kinds: ['episodic'] } });
    const projected = computeProjection(base, avatar);
    assert.equal(projected.L4.memories.size, 1);
    assert.ok(projected.L4.memories.has('m_1'));
    assert.ok(!projected.L4.memories.has('m_2'));
  });

  it('L4 记忆过滤按 minSalience', () => {
    const base = makeBaseState();
    const avatar = makeAvatar({ memoryFilter: { minSalience: 0.5 } });
    const projected = computeProjection(base, avatar);
    assert.equal(projected.L4.memories.size, 1);
    assert.ok(projected.L4.memories.has('m_1')); /* salience 0.8 */
    assert.ok(!projected.L4.memories.has('m_2')); /* salience 0.3 < 0.5 */
  });

  it('L0 不可变（透传）', () => {
    const base = makeBaseState();
    const avatar = makeAvatar({ valueWeightAdjustments: { v_1: 0.1 } });
    const projected = computeProjection(base, avatar);
    assert.strictEqual(projected.L0, base.L0);
  });
});
