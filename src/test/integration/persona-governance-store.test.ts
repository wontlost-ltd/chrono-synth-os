/**
 * per-persona 治理策略 store + 有效策略解析（ADR-0048 治理可配化）。
 *
 * 验证：upsert/get/delete + sanitize 白名单（非法值抛错、未知字段丢弃）+ resolve merge over DEFAULT
 * （无 row 回退 DEFAULT，向后兼容）+ tenant/persona 隔离。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import {
  PersonaGovernanceStore,
  resolvePersonaEarningPolicy,
  sanitizeGovernanceOverride,
  mergeEarningPolicy,
} from '../../storage/persona-governance-store.js';
import { DistilledArtifactStore } from '../../storage/distilled-artifact-store.js';
import { DEFAULT_EARNING_POLICY } from '@chrono/kernel';
import type { IDatabase } from '../../storage/index.js';

const TENANT = 'tenant_a';
const PERSONA = 'persona_1';

describe('per-persona 治理策略 store（ADR-0048）', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
  });
  afterEach(() => db.close());

  it('无覆盖 → resolve 完全回退 DEFAULT_EARNING_POLICY（向后兼容）', () => {
    const policy = resolvePersonaEarningPolicy(db, TENANT, PERSONA);
    assert.deepEqual(policy, DEFAULT_EARNING_POLICY);
  });

  it('upsert 部分覆盖 → resolve merge over DEFAULT（只改给出的字段）', () => {
    const store = new PersonaGovernanceStore(db, TENANT);
    store.upsert(PERSONA, { maxAutonomousReward: 100, categoryRoutes: { coding: 'autonomous' } }, 'owner_1', 1000);
    const policy = resolvePersonaEarningPolicy(db, TENANT, PERSONA);
    assert.equal(policy.maxAutonomousReward, 100, '覆盖生效');
    assert.deepEqual(policy.categoryRoutes, { coding: 'autonomous' });
    /* 未覆盖的字段沿用 DEFAULT。 */
    assert.equal(policy.dailyRewardExposureCap, DEFAULT_EARNING_POLICY.dailyRewardExposureCap);
    assert.deepEqual(policy.aml, DEFAULT_EARNING_POLICY.aml, 'aml 未覆盖沿用默认');
  });

  it('aml 深合并：只覆盖给出的 aml 子字段，其余沿用默认', () => {
    const store = new PersonaGovernanceStore(db, TENANT);
    store.upsert(PERSONA, { aml: { maxTasksPerPublisherPerWindow: 3 } }, 'owner_1', 1000);
    const policy = resolvePersonaEarningPolicy(db, TENANT, PERSONA);
    assert.equal(policy.aml.maxTasksPerPublisherPerWindow, 3, 'aml 子字段覆盖');
    assert.equal(policy.aml.maxPublisherRewardShare, DEFAULT_EARNING_POLICY.aml.maxPublisherRewardShare, '其余 aml 沿用默认');
  });

  it('sanitize 白名单：未知字段被丢弃（不落库脏数据）', () => {
    const clean = sanitizeGovernanceOverride({ maxAutonomousReward: 50, bogusField: 'x', __proto__: { polluted: true } });
    assert.equal(clean.maxAutonomousReward, 50);
    assert.equal((clean as Record<string, unknown>).bogusField, undefined, '未知字段丢弃');
    assert.equal(({} as Record<string, unknown>).polluted, undefined, '原型未污染');
  });

  it('sanitize 恶意 JSON 边界：constructor/嵌套/数组/非对象输入均安全（Codex 复审）', () => {
    /* constructor 污染尝试。 */
    sanitizeGovernanceOverride(JSON.parse('{"constructor": {"prototype": {"polluted": true}}, "maxAutonomousReward": 10}'));
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'constructor 污染未生效');
    /* categoryRoutes 值是嵌套对象（非字符串 mode）→ 抛错，不静默接受。 */
    assert.throws(() => sanitizeGovernanceOverride({ categoryRoutes: { coding: { nested: 'evil' } } }), /autonomous/);
    /* aml 是数组而非对象 → 当对象遍历但字段都 undefined → 返回空 aml（不崩）。 */
    assert.deepEqual(sanitizeGovernanceOverride({ aml: [] }).aml, {});
    /* 顶层非对象输入（null/string/number/array）→ 返回空覆盖，不崩。 */
    assert.deepEqual(sanitizeGovernanceOverride(null), {});
    assert.deepEqual(sanitizeGovernanceOverride('evil'), {});
    assert.deepEqual(sanitizeGovernanceOverride(42), {});
    assert.deepEqual(sanitizeGovernanceOverride([1, 2, 3]), {});
    /* NaN/Infinity 数值被 finite 校验挡住。 */
    assert.throws(() => sanitizeGovernanceOverride({ maxAutonomousReward: Infinity }), /非负有限/);
    assert.throws(() => sanitizeGovernanceOverride({ dailyRewardExposureCap: NaN }), /非负有限/);
  });

  it('sanitize 校验：非法值抛错（宁可拒写不落脏策略）', () => {
    assert.throws(() => sanitizeGovernanceOverride({ maxAutonomousReward: -1 }), /非负/);
    assert.throws(() => sanitizeGovernanceOverride({ maxConcurrentTasks: 0 }), /正整数/);
    assert.throws(() => sanitizeGovernanceOverride({ categoryRoutes: { coding: 'invalid_mode' } }), /autonomous/);
    assert.throws(() => sanitizeGovernanceOverride({ categoryRoutes: { bogus_category: 'autonomous' } }), /非法 category/);
    assert.throws(() => sanitizeGovernanceOverride({ aml: { maxPublisherRewardShare: 1.5 } }), /\[0,1\]/);
    assert.throws(() => sanitizeGovernanceOverride({ defaultCategoryRoute: 'nope' }), /autonomous/);
    /* 不确定性预算：负数/小数非法，但 0 合法（完全禁止自动吸收）。 */
    assert.throws(() => sanitizeGovernanceOverride({ unverifiedGrowthBudgetPerWindow: -1 }), /非负整数/);
    assert.throws(() => sanitizeGovernanceOverride({ unverifiedGrowthBudgetPerWindow: 1.5 }), /非负整数/);
    assert.equal(sanitizeGovernanceOverride({ unverifiedGrowthBudgetPerWindow: 0 }).unverifiedGrowthBudgetPerWindow, 0, '0 合法');
  });

  it('upsert 落库规范化 JSON（非用户原始）：getOverride 取回 sanitize 后的对象', () => {
    const store = new PersonaGovernanceStore(db, TENANT);
    store.upsert(PERSONA, { maxAutonomousReward: 80, junk: 'drop' } as unknown, 'owner_1', 1000);
    const override = store.getOverride(PERSONA);
    assert.deepEqual(override, { maxAutonomousReward: 80 }, 'junk 未落库');
  });

  it('delete → 恢复默认', () => {
    const store = new PersonaGovernanceStore(db, TENANT);
    store.upsert(PERSONA, { maxAutonomousReward: 100 }, 'owner_1', 1000);
    store.delete(PERSONA);
    assert.equal(store.getOverride(PERSONA), undefined);
    assert.deepEqual(resolvePersonaEarningPolicy(db, TENANT, PERSONA), DEFAULT_EARNING_POLICY);
  });

  it('乐观并发：版本严格单调（同毫秒连写版本仍递增）+ CAS 冲突返回 false', () => {
    const store = new PersonaGovernanceStore(db, TENANT);
    /* 同 now=1000 连写两次——版本必须递增（否则同毫秒两写版本相同，乐观锁失效）。 */
    assert.equal(store.upsert(PERSONA, { maxAutonomousReward: 10 }, 'o', 1000), true);
    const v1 = store.getRow(PERSONA)!.updated_at;
    assert.equal(store.upsert(PERSONA, { maxAutonomousReward: 20 }, 'o', 1000), true, '同毫秒第2写成功');
    const v2 = store.getRow(PERSONA)!.updated_at;
    assert.ok(v2 > v1, `版本严格递增 v2(${v2})>v1(${v1})`);
    /* 用过期版本 v1 做 CAS → false（冲突）；用最新 v2 → true。 */
    assert.equal(store.upsert(PERSONA, { maxAutonomousReward: 30 }, 'o', 1000, v1), false, '过期版本 → 冲突');
    assert.equal(store.getRow(PERSONA)!.updated_at, v2, '冲突未写，版本不变');
    assert.equal(store.upsert(PERSONA, { maxAutonomousReward: 30 }, 'o', 1000, v2), true, '最新版本 → 成功');
  });

  it('DB 级 CAS：对不存在的 row 带 expectedUpdatedAt → false（无行可改=冲突，原子）', () => {
    const store = new PersonaGovernanceStore(db, TENANT);
    /* p_new 无 row，但客户端以为存在版本 999 → 条件 UPDATE 影响 0 行 → false。 */
    assert.equal(store.upsert('p_new', { maxAutonomousReward: 10 }, 'o', 1000, 999), false, '无行 → CAS false');
    assert.equal(store.getOverride('p_new'), undefined, '未创建');
  });

  it('persona 隔离：persona_1 的覆盖不影响 persona_2', () => {
    const store = new PersonaGovernanceStore(db, TENANT);
    store.upsert('persona_1', { maxAutonomousReward: 100 }, 'owner_1', 1000);
    assert.equal(resolvePersonaEarningPolicy(db, TENANT, 'persona_2').maxAutonomousReward, DEFAULT_EARNING_POLICY.maxAutonomousReward);
  });

  it('tenant 隔离：tenant_a 的覆盖不影响 tenant_b', () => {
    new PersonaGovernanceStore(db, 'tenant_a').upsert(PERSONA, { maxAutonomousReward: 100 }, 'o', 1000);
    assert.equal(resolvePersonaEarningPolicy(db, 'tenant_b', PERSONA).maxAutonomousReward, DEFAULT_EARNING_POLICY.maxAutonomousReward);
  });

  it('mergeEarningPolicy 纯函数：不改 base', () => {
    const merged = mergeEarningPolicy(DEFAULT_EARNING_POLICY, { maxAutonomousReward: 999 });
    assert.equal(merged.maxAutonomousReward, 999);
    assert.equal(DEFAULT_EARNING_POLICY.maxAutonomousReward, 50, 'base 未被改');
  });
});

describe('countAutoCompiledSince（不确定性预算性能查询，①）', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
  });
  afterEach(() => db.close());

  /** 直接造一条 compiled 工件行（绕过状态机，专测 count 查询的过滤口径）。 */
  function insertCompiled(personaId: string, via: 'auto' | 'approved' | null, compiledAt: number | null): void {
    db.prepare<void>(
      `INSERT INTO distilled_artifacts (id, tenant_id, persona_id, kind, source, payload, confidence, evidence, status, reason, created_at, compiled_at, compiled_via)
       VALUES (?, 'default', ?, 'value_shift', 'reflection', '{}', 0.9, '[]', 'compiled', 'x', 0, ?, ?)`,
    ).run(`d_${Math.random().toString(36).slice(2)}`, personaId, compiledAt, via);
  }

  it('只数 compiled_via=auto 且 compiled_at>=since（approved/null/窗口外不计）', () => {
    const dstore = new DistilledArtifactStore(db, 'default');
    insertCompiled('p1', 'auto', 1000);     /* 计入 */
    insertCompiled('p1', 'auto', 500);      /* 窗口外（<since） */
    insertCompiled('p1', 'approved', 1000); /* 已验证不计 */
    insertCompiled('p1', null, 1000);       /* 历史不计 */
    insertCompiled('p2', 'auto', 1000);     /* 别的 persona 不计 */
    /* 边界：compiled_at===since 计入（>= 含等号）。 */
    assert.equal(dstore.countAutoCompiledSince('p1', 1000), 1, '只 1 条 auto 在窗口内');
    assert.equal(dstore.countAutoCompiledSince('p1', 500), 2, '放宽窗口起点到 500 → 2 条');
    assert.equal(dstore.countAutoCompiledSince('p2', 1000), 1, 'persona 隔离');
    assert.equal(dstore.countAutoCompiledSince('p3', 1000), 0, '无记录 → 0');
  });
});
