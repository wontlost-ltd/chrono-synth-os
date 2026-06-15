import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEarningAdmission,
  evaluateAmlAggregate,
  resolveCategoryRoute,
  DEFAULT_EARNING_POLICY,
  DEFAULT_AML_AGGREGATE_POLICY,
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

  it('未授权 category → 升 high + needs_human_review（legacy reason 文案逐字不变）', () => {
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

/* ── skill-router 脚手架：per-category 路由（ADR-0048 余项）── */

describe('resolveCategoryRoute + category 路由集成 (ADR-0048 skill-router)', () => {
  it('向后兼容：未设 categoryRoutes → 从 allowedCategories 派生（白名单内 autonomous，其余 human_review）', () => {
    /* DEFAULT_EARNING_POLICY.allowedCategories = ['research','writing']，无 categoryRoutes。 */
    assert.equal(resolveCategoryRoute(DEFAULT_EARNING_POLICY, 'research'), 'autonomous');
    assert.equal(resolveCategoryRoute(DEFAULT_EARNING_POLICY, 'writing'), 'autonomous');
    assert.equal(resolveCategoryRoute(DEFAULT_EARNING_POLICY, 'coding'), 'human_review');
    assert.equal(resolveCategoryRoute(DEFAULT_EARNING_POLICY, 'operations'), 'human_review');
  });

  it('显式 categoryRoutes 覆盖派生：可单独把 coding 开为 autonomous', () => {
    const cfg = { ...DEFAULT_EARNING_POLICY, categoryRoutes: { coding: 'autonomous' as const } };
    assert.equal(resolveCategoryRoute(cfg, 'coding'), 'autonomous');
    /* 未在 routes 表中的 category 走 defaultCategoryRoute（默认 human_review），不再看 allowedCategories。 */
    assert.equal(resolveCategoryRoute(cfg, 'research'), 'human_review');
  });

  it('defaultCategoryRoute 兜底：可把未列出的类别整体设为 blocked', () => {
    const cfg = {
      ...DEFAULT_EARNING_POLICY,
      categoryRoutes: { research: 'autonomous' as const },
      defaultCategoryRoute: 'blocked' as const,
    };
    assert.equal(resolveCategoryRoute(cfg, 'research'), 'autonomous');
    assert.equal(resolveCategoryRoute(cfg, 'coding'), 'blocked');
  });

  it('集成：blocked category → forbidden（硬禁止，区别于 human_review）', () => {
    const cfg = { ...DEFAULT_EARNING_POLICY, categoryRoutes: { coding: 'blocked' as const } };
    const r = evaluateEarningAdmission(input({ config: cfg, task: task({ category: 'coding' }) }));
    assert.equal(r.admission, 'forbidden');
    assert.match(r.reasons.join(), /is blocked by policy/);
  });

  it('集成：显式 autonomous category + 其它都低风险 → autonomous', () => {
    const cfg = { ...DEFAULT_EARNING_POLICY, categoryRoutes: { coding: 'autonomous' as const } };
    const r = evaluateEarningAdmission(input({ config: cfg, task: task({ category: 'coding' }) }));
    assert.equal(r.admission, 'autonomous');
    assert.equal(r.risk, 'low');
  });

  it('集成：human_review category → needs_human_review（升 high，不硬禁）', () => {
    const cfg = { ...DEFAULT_EARNING_POLICY, categoryRoutes: { coding: 'human_review' as const } };
    const r = evaluateEarningAdmission(input({ config: cfg, task: task({ category: 'coding' }) }));
    assert.equal(r.admission, 'needs_human_review');
    assert.equal(r.risk, 'high');
  });

  it('向后兼容铁律：旧 policy（无 categoryRoutes）的 research 仍 autonomous、coding 仍 needs_human_review', () => {
    /* 与改造前逐字等价：research 走自主，coding 走人工。 */
    const rResearch = evaluateEarningAdmission(input({ task: task({ category: 'research' }) }));
    assert.equal(rResearch.admission, 'autonomous');
    const rCoding = evaluateEarningAdmission(input({ task: task({ category: 'coding' }) }));
    assert.equal(rCoding.admission, 'needs_human_review');
  });

  it('routes 模式用新文案；legacy 用旧文案（reason 逐字不变，Codex 复审）', () => {
    const legacy = evaluateEarningAdmission(input({ task: task({ category: 'coding' }) }));
    assert.match(legacy.reasons.join(), /not in autonomous allowlist/, 'legacy 保留旧文案');
    const routed = evaluateEarningAdmission(input({
      config: { ...DEFAULT_EARNING_POLICY, categoryRoutes: { coding: 'human_review' as const } },
      task: task({ category: 'coding' }),
    }));
    assert.match(routed.reasons.join(), /routed to human review/, 'routes 模式用新文案');
  });

  it('defaultCategoryRoute 不污染 legacy：无 categoryRoutes 时它被忽略（非白名单恒 human_review）', () => {
    /* 只设 defaultCategoryRoute=blocked 但没 categoryRoutes → coding 仍走 legacy human_review，不被 blocked。 */
    const cfg = { ...DEFAULT_EARNING_POLICY, defaultCategoryRoute: 'blocked' as const };
    assert.equal(resolveCategoryRoute(cfg, 'coding'), 'human_review', 'legacy 路径忽略 defaultCategoryRoute');
    const r = evaluateEarningAdmission(input({ config: cfg, task: task({ category: 'coding' }) }));
    assert.equal(r.admission, 'needs_human_review', '不应被误判为 blocked/forbidden');
  });

  it('优先级：系统熔断（failureStreak）优先于 category blocked（reason 反映最严重的因）', () => {
    /* persona 已连续失败熔断 + 该 category 又 blocked → 应返回 critical/failure streak，不被 blocked 遮蔽。 */
    const cfg = { ...DEFAULT_EARNING_POLICY, categoryRoutes: { coding: 'blocked' as const } };
    const r = evaluateEarningAdmission(input({
      config: cfg, task: task({ category: 'coding' }), persona: persona({ recentFailureStreak: 2 }),
    }));
    assert.equal(r.admission, 'forbidden');
    assert.equal(r.risk, 'critical', 'failure streak 是 critical，优先于 blocked 的 high');
    assert.match(r.reasons.join(), /failure streak/, 'reason 反映系统熔断而非 blocked');
  });
});

/* ── AML 聚合检测（ADR-0048 related-account cycling / wash-trading 余项）── */

/** 构造一条「已接单」窗口任务（accepted 状态 + 指定 publisher/reward）。 */
function accepted(publisherUserId: string, reward: number, overrides?: Partial<MarketplaceTask>): MarketplaceTask {
  return task({ publisherUserId, reward, status: 'accepted', assigneePersonaId: 'p1', acceptedAt: 1000, ...overrides });
}

describe('evaluateAmlAggregate (ADR-0048 聚合 AML)', () => {
  const policy = DEFAULT_AML_AGGREGATE_POLICY; /* maxTasks=5, share=0.8, minTasks=4, repeats=4 */

  it('正常收入：单 publisher 少量接单 → 不拦（不误伤）', () => {
    const window = [accepted('pubA', 20), accepted('pubB', 30)];
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 25, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, false);
    assert.equal(r.reasons.length, 0);
  });

  it('空窗口（首次接单）→ 不拦', () => {
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 20, windowAcceptedTasks: [], policy });
    assert.equal(r.blocked, false);
  });

  it('信号1 速率：同 publisher 接单达阈值（含候选这单）→ 拦', () => {
    /* 窗口已有该 publisher 4 单（各异额）+ 候选第 5 单 → 5 ≥ maxTasksPerPublisherPerWindow(5) → 拦。
     * 候选额 14 与窗口各额都不同，避免顺带触发信号3（隔离测速率）。 */
    const window = [accepted('pubA', 10), accepted('pubA', 11), accepted('pubA', 12), accepted('pubA', 13)];
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 14, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, true);
    assert.match(r.reasons.join(), /接单速率过高/);
  });

  it('信号1 边界：同 publisher 3 单 + 候选第 4 单（4 < 5）→ 不拦', () => {
    const window = [accepted('pubA', 10), accepted('pubA', 11), accepted('pubA', 12)];
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 13, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, false);
  });

  it('信号2 集中度：单 publisher 占窗口报酬 ≥80% 且窗口 ≥4 单 → 拦（关联环圈）', () => {
    /* pubA 占 90/(90+10)=90% ≥ 0.8，窗口 5 单 ≥ 4 → 拦。各单报酬不同避开信号1速率(pubA 3单<5)。
     * 候选额 50 与各窗口额都不同，避免顺带触发信号3（隔离测集中度）。 */
    const window = [
      accepted('pubA', 30), accepted('pubA', 31), accepted('pubA', 29), /* pubA 3 单 = 90 */
      accepted('pubB', 5), accepted('pubC', 5),                          /* 其它 2 单 = 10 */
    ];
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 50, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, true);
    assert.match(r.reasons.join(), /报酬集中度过高/);
  });

  it('信号2 边界：窗口任务数不足 minTasks(4) → 占比再高也不判集中度', () => {
    /* pubA 占 100%，但窗口仅 3 单 < concentrationMinTasks(4) → 集中度不触发（速率 3+1=4<5 也不触发）。 */
    const window = [accepted('pubA', 30), accepted('pubA', 31), accepted('pubA', 29)];
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 28, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, false);
  });

  it('信号2：全 0 报酬窗口不触发除零、也无集中度', () => {
    const window = [accepted('pubA', 0), accepted('pubA', 0), accepted('pubA', 0), accepted('pubB', 0)];
    /* 候选额给 1（非 0）避免顺带触发信号3（窗口已有 3 个 0，候选若也 0 则 0 出现 4 次会拦）。 */
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 1, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, false);
  });

  it('信号3 同额重复：窗口 3 单同额 + 候选同额 = 4 次达阈值 → 拦（候选计入，与速率信号一致）', () => {
    /* pubA 窗口有 3 单同额 20 + 候选额 20 → 同额 20 共 4 次 ≥ maxIdenticalRewardRepeats(4) → 拦。
     * 总单数 3+候选=4 < 速率阈值 5 → 速率不触发，干净隔离信号3（验证候选被正确计入同额统计）。 */
    const window = [accepted('pubA', 20), accepted('pubA', 20), accepted('pubA', 20)];
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 20, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, true);
    assert.match(r.reasons.join(), /同额报酬 20 重复 4 次/);
    assert.ok(!r.reasons.join().includes('接单速率过高'), '总单数 4<5，速率不应触发（隔离信号3）');
  });

  it('信号3 边界：窗口 2 单同额 + 候选同额 = 3 次（<4）→ 不拦', () => {
    const window = [accepted('pubA', 20), accepted('pubA', 20)];
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 20, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, false);
  });

  it('只针对候选 publisher 聚合：其它 publisher 的密集接单不影响候选', () => {
    /* pubB 接了 5 单（自己很密集），但候选是 pubA（窗口里 1 单）→ 对 pubA 不拦。 */
    const window = [
      accepted('pubB', 10), accepted('pubB', 10), accepted('pubB', 10), accepted('pubB', 10), accepted('pubB', 10),
      accepted('pubA', 20),
    ];
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 99, windowAcceptedTasks: window, policy });
    assert.equal(r.blocked, false, 'pubA 自身在窗口仅 1 单，不应被 pubB 的行为牵连');
  });

  it('确定性：相同输入相同输出，且与任务顺序无关', () => {
    const w1 = [accepted('pubA', 20), accepted('pubA', 20), accepted('pubA', 20)];
    const w2 = [...w1].reverse();
    const r1 = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 20, windowAcceptedTasks: w1, policy });
    const r2 = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 20, windowAcceptedTasks: w2, policy });
    assert.deepEqual(r1, r2);
  });

  it('阈值可调：放宽各阈值后同场景不再拦', () => {
    const window = [accepted('pubA', 10), accepted('pubA', 11), accepted('pubA', 12), accepted('pubA', 13)];
    const loose = { ...policy, maxTasksPerPublisherPerWindow: 10, maxIdenticalRewardRepeats: 10, maxPublisherRewardShare: 1.1 };
    const r = evaluateAmlAggregate({ candidatePublisherUserId: 'pubA', candidateReward: 14, windowAcceptedTasks: window, policy: loose });
    assert.equal(r.blocked, false, '放宽阈值后正常场景放行');
  });
});
