import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  transitionArtifact,
  validateArtifact,
  canAutoCompile,
  DEFAULT_DISTILLATION_POLICY,
  type DistilledArtifact,
  type ArtifactStatus,
  type ArtifactEvidence,
} from '../src/domain/core-self/distilled-artifact-types.js';

function evidence(n: number): ArtifactEvidence[] {
  return Array.from({ length: n }, (_, i) => ({ type: 'pattern' as const, id: `e${i}`, score: 0.6 }));
}

function makeArtifact(overrides?: Partial<DistilledArtifact>): DistilledArtifact {
  return {
    id: 'art-1',
    kind: 'value_shift',
    source: 'reflection',
    payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: true },
    confidence: 0.85,
    evidence: evidence(2),
    status: 'candidate',
    createdAt: 1000,
    ...overrides,
  };
}

describe('DistilledArtifact state machine', () => {
  it('candidate 可转 approved / rejected', () => {
    assert.equal(canTransition('candidate', 'approved'), true);
    assert.equal(canTransition('candidate', 'rejected'), true);
  });

  it('candidate 不可直接 compiled（LLM 输出必须先过审）', () => {
    assert.equal(canTransition('candidate', 'compiled'), false);
  });

  it('approved 可转 compiled', () => {
    assert.equal(canTransition('approved', 'compiled'), true);
  });

  it('compiled 仅可转 rolled_back', () => {
    assert.equal(canTransition('compiled', 'rolled_back'), true);
    assert.equal(canTransition('compiled', 'approved'), false);
  });

  it('终态不可再转移', () => {
    assert.equal(canTransition('rejected', 'approved'), false);
    assert.equal(canTransition('rolled_back', 'compiled'), false);
  });
});

describe('transitionArtifact (唯一写入口)', () => {
  it('合法转移返回新工件，原工件不变', () => {
    const a = makeArtifact({ status: 'candidate' });
    const r = transitionArtifact(a, 'approved', 2000);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.artifact.status, 'approved');
      assert.equal(a.status, 'candidate', '原工件不可被原地修改');
    }
  });

  it('转入 compiled 写入 compiledAt', () => {
    const approved = makeArtifact({ status: 'approved' });
    const r = transitionArtifact(approved, 'compiled', 2000);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.artifact.status, 'compiled');
      assert.equal(r.artifact.compiledAt, 2000);
    }
  });

  it('非法转移被拒绝（candidate 不可直达 compiled）', () => {
    const a = makeArtifact({ status: 'candidate' });
    const r = transitionArtifact(a, 'compiled', 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /illegal transition/);
  });

  it('compiled 前强制校验：approved 的畸形工件不可编译（D3）', () => {
    /* delta 与权重差不符 → 即使状态边合法，compile 前校验拦截 */
    const badApproved = makeArtifact({
      status: 'approved',
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.9, patternAgrees: true },
    });
    const r = transitionArtifact(badApproved, 'compiled', 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /cannot compiled invalid artifact/);
  });

  it('approve 前同样强制校验：畸形 candidate 不可 approved', () => {
    const badCandidate = makeArtifact({
      status: 'candidate',
      confidence: 2, /* 越界 */
    });
    const r = transitionArtifact(badCandidate, 'approved', 2000);
    assert.equal(r.ok, false);
  });
});

describe('validateArtifact', () => {
  it('合法工件无问题', () => {
    assert.deepEqual(validateArtifact(makeArtifact()), []);
  });

  it('confidence 越界被拒', () => {
    const problems = validateArtifact(makeArtifact({ confidence: 1.5 }));
    assert.ok(problems.some((p) => p.includes('confidence')));
  });

  it('空 evidence 被拒', () => {
    const problems = validateArtifact(makeArtifact({ evidence: [] }));
    assert.ok(problems.some((p) => p.includes('evidence')));
  });

  it('value_shift 缺 valueId 被拒', () => {
    const problems = validateArtifact(makeArtifact({ payload: { delta: 0.03 } }));
    assert.ok(problems.some((p) => p.includes('value_shift')));
  });

  it('memory_edge 缺 targetId 被拒', () => {
    const problems = validateArtifact(makeArtifact({
      kind: 'memory_edge',
      payload: { sourceId: 'm1' },
    }));
    assert.ok(problems.some((p) => p.includes('memory_edge')));
  });

  it('response_template 空模板被拒', () => {
    const problems = validateArtifact(makeArtifact({
      kind: 'response_template',
      payload: { intent: 'greeting', template: '' },
    }));
    assert.ok(problems.some((p) => p.includes('response_template')));
  });
});

describe('canAutoCompile (ADR-0047 D3)', () => {
  it('value_shift 满足全部门槛时自动编译', () => {
    assert.equal(canAutoCompile(makeArtifact()), true);
  });

  it('value_shift 置信度不足时需审批', () => {
    assert.equal(canAutoCompile(makeArtifact({ confidence: 0.79 })), false);
  });

  it('value_shift pattern 不同方向时需审批（交叉验证失败）', () => {
    assert.equal(canAutoCompile(makeArtifact({
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: false },
    })), false);
  });

  it('value_shift delta 超限时需审批', () => {
    assert.equal(canAutoCompile(makeArtifact({
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.6, delta: 0.1, patternAgrees: true },
    })), false);
  });

  it('value_shift delta 恰在阈值 0.05 上可自动编译（边界）', () => {
    assert.equal(canAutoCompile(makeArtifact({
      confidence: 0.8,
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.55, delta: 0.05, patternAgrees: true },
    })), true);
  });

  it('memory_edge 满足置信度与证据数时自动编译', () => {
    assert.equal(canAutoCompile(makeArtifact({
      kind: 'memory_edge',
      confidence: 0.8,
      evidence: evidence(2),
      payload: { sourceId: 'm1', targetId: 'm2', relation: 'enriched_by', strength: 0.6 },
    })), true);
  });

  it('memory_edge 证据不足时需审批', () => {
    assert.equal(canAutoCompile(makeArtifact({
      kind: 'memory_edge',
      confidence: 0.8,
      evidence: evidence(1),
      payload: { sourceId: 'm1', targetId: 'm2', relation: 'enriched_by', strength: 0.6 },
    })), false);
  });

  it('rule / *_patch / narrative_patch 默认需审批', () => {
    for (const kind of ['rule', 'decision_style_patch', 'cognitive_model_patch', 'narrative_patch', 'response_template'] as const) {
      assert.equal(
        canAutoCompile(makeArtifact({ kind, confidence: 0.99, payload: { intent: 'x', template: 'y' } })),
        false,
        `${kind} 应需审批`,
      );
    }
  });

  it('D3 守卫：非 candidate 状态一律不可自动编译', () => {
    for (const status of ['approved', 'compiled', 'rejected', 'rolled_back'] as ArtifactStatus[]) {
      assert.equal(canAutoCompile(makeArtifact({ status })), false, `${status} 不应自动编译`);
    }
  });

  it('D3 守卫：畸形 payload（delta 不一致）不可自动编译', () => {
    /* delta 与 suggested-current 不符，即使置信度/方向达标也应被校验拦截 */
    assert.equal(canAutoCompile(makeArtifact({
      confidence: 0.9,
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.01, patternAgrees: true },
    })), false);
  });

  it('默认策略阈值符合 ADR-0047', () => {
    assert.equal(DEFAULT_DISTILLATION_POLICY.valueShiftMinConfidence, 0.8);
    assert.equal(DEFAULT_DISTILLATION_POLICY.valueShiftMaxDelta, 0.05);
    assert.equal(DEFAULT_DISTILLATION_POLICY.memoryEdgeMinEvidence, 2);
  });
});

describe('validateArtifact 强化校验 (审查采纳)', () => {
  it('value_shift 权重越界被拒', () => {
    const problems = validateArtifact(makeArtifact({
      payload: { valueId: 'v1', currentWeight: 1.5, suggestedWeight: 0.53, delta: -0.97, patternAgrees: true },
    }));
    assert.ok(problems.some((p) => p.includes('currentWeight')));
  });

  it('value_shift delta 与权重差不符被拒', () => {
    const problems = validateArtifact(makeArtifact({
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.99, patternAgrees: true },
    }));
    assert.ok(problems.some((p) => p.includes('delta must equal')));
  });

  it('value_shift patternAgrees 非布尔被拒', () => {
    const problems = validateArtifact(makeArtifact({
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.53, delta: 0.03, patternAgrees: 'yes' as unknown as boolean },
    }));
    assert.ok(problems.some((p) => p.includes('patternAgrees')));
  });

  it('memory_edge 自环被拒', () => {
    const problems = validateArtifact(makeArtifact({
      kind: 'memory_edge',
      payload: { sourceId: 'm1', targetId: 'm1', relation: 'r', strength: 0.5 },
    }));
    assert.ok(problems.some((p) => p.includes('must differ')));
  });

  it('memory_edge strength 越界被拒', () => {
    const problems = validateArtifact(makeArtifact({
      kind: 'memory_edge',
      payload: { sourceId: 'm1', targetId: 'm2', relation: 'r', strength: 2 },
    }));
    assert.ok(problems.some((p) => p.includes('strength')));
  });

  it('畸形顶层输入：evidence 非数组不抛错、返回问题', () => {
    const malformed = { id: 'x', kind: 'value_shift', source: 'reflection', status: 'candidate', createdAt: 1, confidence: 0.5, evidence: 'nope', payload: {} } as unknown as DistilledArtifact;
    const problems = validateArtifact(malformed);
    assert.ok(problems.some((p) => p.includes('evidence must be an array')));
  });

  it('畸形顶层输入：非法 kind/source/status 被拒', () => {
    const malformed = { id: 'x', kind: 'bogus', source: 'bogus', status: 'bogus', createdAt: 1, confidence: 0.5, evidence: [{ type: 'pattern', id: 'e', score: 0.5 }], payload: {} } as unknown as DistilledArtifact;
    const problems = validateArtifact(malformed);
    assert.ok(problems.some((p) => p.includes('invalid kind')));
    assert.ok(problems.some((p) => p.includes('invalid source')));
    assert.ok(problems.some((p) => p.includes('invalid status')));
  });

  it('canAutoCompile 对空对象不抛错、返回 false', () => {
    assert.equal(canAutoCompile({} as unknown as DistilledArtifact), false);
  });

  it('真实 unknown 输入（null/primitive/数组）不抛错', () => {
    /* 这些是 LLM JSON 入口最危险的畸形输入 */
    assert.deepEqual(validateArtifact(null), ['artifact must be an object']);
    assert.deepEqual(validateArtifact('x'), ['artifact must be an object']);
    assert.deepEqual(validateArtifact(42), ['artifact must be an object']);
    assert.deepEqual(validateArtifact([]), ['artifact must be an object']);
    assert.equal(canAutoCompile(null), false);
    assert.equal(canAutoCompile('x'), false);
    assert.equal(canAutoCompile(undefined), false);
  });

  it('canTransition 对非法 from 安全返回 false（不抛）', () => {
    assert.equal(canTransition('bogus' as ArtifactStatus, 'approved'), false);
  });

  it('transitionArtifact 对非法 status 工件返回 ok:false（不抛）', () => {
    const bogus = makeArtifact({ status: 'bogus' as ArtifactStatus });
    const r = transitionArtifact(bogus, 'approved', 1);
    assert.equal(r.ok, false);
  });
});
