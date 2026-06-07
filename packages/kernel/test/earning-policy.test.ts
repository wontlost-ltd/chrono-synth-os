import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEarningAdmission,
  DEFAULT_EARNING_POLICY,
  type EarningAdmissionInput,
  type EarningPersonaSnapshot,
} from '../src/domain/persona/earning-policy.js';
import type { MarketplaceTask } from '../src/domain/persona/types.js';

function task(overrides?: Partial<MarketplaceTask>): MarketplaceTask {
  return {
    id: 'mkt_1', tenantId: 'default', publisherUserId: 'pub1',
    assigneePersonaId: null, assigneeForkId: null, assigneePersonaName: null,
    title: 'T', description: 'D', category: 'research', reward: 20, currency: 'CRED',
    status: 'open', qualityScore: null, growthDelta: null,
    publishedAt: 1, acceptedAt: null, completedAt: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

function persona(overrides?: Partial<EarningPersonaSnapshot>): EarningPersonaSnapshot {
  return {
    status: 'active', reputation: 10, openTaskCount: 0,
    categoryCompletedCount: 5, recentFailureStreak: 0,
    ...overrides,
  };
}

function input(overrides?: Partial<EarningAdmissionInput>): EarningAdmissionInput {
  return {
    task: task(), persona: persona(), config: DEFAULT_EARNING_POLICY,
    todayRewardExposure: 0, publisherIsNew: false,
    ...overrides,
  };
}

describe('evaluateEarningAdmission (ADR-0048)', () => {
  it('低风险已授权 category 已熟悉 → autonomous', () => {
    const r = evaluateEarningAdmission(input());
    assert.equal(r.admission, 'autonomous');
    assert.equal(r.risk, 'low');
  });

  it('persona 非 active → forbidden', () => {
    const r = evaluateEarningAdmission(input({ persona: persona({ status: 'paused' }) }));
    assert.equal(r.admission, 'forbidden');
    assert.equal(r.risk, 'critical');
  });

  it('连续失败达熔断阈值 → forbidden（earning 暂停）', () => {
    const r = evaluateEarningAdmission(input({ persona: persona({ recentFailureStreak: 2 }) }));
    assert.equal(r.admission, 'forbidden');
    assert.match(r.reasons.join(), /failure streak/);
  });

  it('并发任务超上限 → forbidden', () => {
    const r = evaluateEarningAdmission(input({ persona: persona({ openTaskCount: 3 }) }));
    assert.equal(r.admission, 'forbidden');
  });

  it('每日报酬暴露超 cap → needs_human_review', () => {
    const r = evaluateEarningAdmission(input({ todayRewardExposure: 190, task: task({ reward: 20 }) }));
    assert.equal(r.admission, 'needs_human_review');
    assert.match(r.reasons.join(), /daily reward exposure/);
  });

  it('未授权 category → 升 high + needs_human_review', () => {
    const r = evaluateEarningAdmission(input({ task: task({ category: 'coding' }) }));
    assert.equal(r.admission, 'needs_human_review');
    assert.equal(r.risk, 'high');
    assert.match(r.reasons.join(), /not in autonomous allowlist/);
  });

  it('首次接该 category → medium + needs_human_review', () => {
    const r = evaluateEarningAdmission(input({ persona: persona({ categoryCompletedCount: 0 }) }));
    assert.equal(r.admission, 'needs_human_review');
    assert.equal(r.risk, 'medium');
  });

  it('新 publisher → medium + needs_human_review', () => {
    const r = evaluateEarningAdmission(input({ publisherIsNew: true }));
    assert.equal(r.admission, 'needs_human_review');
    assert.equal(r.risk, 'medium');
  });

  it('reward 超自主上限 → high + needs_human_review', () => {
    const r = evaluateEarningAdmission(input({ task: task({ reward: 60 }) }));
    assert.equal(r.admission, 'needs_human_review');
    assert.equal(r.risk, 'high');
  });

  it('声誉低于最低线 → high', () => {
    const cfg = { ...DEFAULT_EARNING_POLICY, minReputationForAutonomy: 5 };
    const r = evaluateEarningAdmission(input({ config: cfg, persona: persona({ reputation: 2 }) }));
    assert.equal(r.risk, 'high');
  });

  it('多信号叠加取最高风险', () => {
    /* 未授权 category(high) + 新 publisher(medium) → high */
    const r = evaluateEarningAdmission(input({ task: task({ category: 'coding' }), publisherIsNew: true }));
    assert.equal(r.risk, 'high');
    assert.ok(r.reasons.length >= 2);
  });
});
