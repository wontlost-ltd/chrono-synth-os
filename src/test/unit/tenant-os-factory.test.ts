import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import type { IDatabase } from '../../storage/database.js';
import { personalityDiversity } from '@chrono/kernel';

describe('TenantOSFactory', () => {
  let db: IDatabase;
  let factory: TenantOSFactory;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    factory = new TenantOSFactory(db, new TestClock(1000), new SilentLogger(), { maxCachedTenants: 3 });
  });

  it('创建并缓存租户 OS 实例', () => {
    const os1 = factory.getTenantOS('tenant-a');
    const os2 = factory.getTenantOS('tenant-a');
    assert.strictEqual(os1, os2, '同一租户返回缓存实例');
    assert.equal(factory.cachedCount, 1);
  });

  it('不同租户获得不同实例', () => {
    const osA = factory.getTenantOS('tenant-a');
    const osB = factory.getTenantOS('tenant-b');
    assert.notStrictEqual(osA, osB);
    assert.equal(factory.cachedCount, 2);
  });

  it('超过容量限制时 LRU 驱逐', () => {
    factory.getTenantOS('t1');
    factory.getTenantOS('t2');
    factory.getTenantOS('t3');
    assert.equal(factory.cachedCount, 3);

    /* 添加第 4 个，应驱逐最早访问的 */
    factory.getTenantOS('t4');
    assert.equal(factory.cachedCount, 3);
  });

  it('clear 清理所有缓存', () => {
    factory.getTenantOS('t1');
    factory.getTenantOS('t2');
    factory.clear();
    assert.equal(factory.cachedCount, 0);
  });

  it('evict 驱逐指定租户', () => {
    factory.getTenantOS('t1');
    factory.getTenantOS('t2');
    assert.equal(factory.cachedCount, 2);

    factory.evict('t1');
    assert.equal(factory.cachedCount, 1);

    /* 再次获取应创建新实例 */
    const os1 = factory.getTenantOS('t1');
    assert.equal(factory.cachedCount, 2);
    assert.ok(os1);
  });

  it('evict 不存在的租户无影响', () => {
    factory.getTenantOS('t1');
    factory.evict('nonexistent');
    assert.equal(factory.cachedCount, 1);
  });

  describe('性格出生机制接线（②③ → 生产路径）', () => {
    it('不同租户人格出生即略不同（diversityScore > 0）', () => {
      /* 接线前：所有租户用同一 DEFAULT_DECISION_STYLE 出生 → diversityScore=0。
       * 接线后：按 tenantId 派生确定性扰动 → 同源出生被拉开成一团。 */
      const tenants = ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d'];
      const styles = tenants.map((t) => factory.getTenantOS(t).core.decisionStyle.get());
      const diversity = personalityDiversity(styles);
      assert.ok(
        diversity.diversityScore > 0,
        `多租户人格出生应有可度量差异，实际 diversityScore=${diversity.diversityScore}`,
      );
    });

    it('同租户出生确定性可复现（同 tenantId → 同 decision style）', () => {
      /* seed=tenantId + FNV-1a 确定性 PRNG → 同租户在干净 DB 上恒得同扰动。 */
      const styleA1 = factory.getTenantOS('tenant-x').core.decisionStyle.get();

      const factory2 = new TenantOSFactory(db2(), new TestClock(1000), new SilentLogger());
      const styleA2 = factory2.getTenantOS('tenant-x').core.decisionStyle.get();

      assert.equal(styleA1.riskAppetite, styleA2.riskAppetite, '同租户 riskAppetite 应可复现');
      assert.equal(styleA1.explorationBias, styleA2.explorationBias, '同租户 explorationBias 应可复现');
      assert.equal(styleA1.deliberationDepth, styleA2.deliberationDepth, '同租户 deliberationDepth 应可复现');
    });

    it('magnitude=0 关闭扰动 → 出生同质（diversityScore=0，旧行为）', () => {
      const off = new TenantOSFactory(db, new TestClock(1000), new SilentLogger(), {
        personalityBirthMagnitude: 0,
      });
      const styles = ['t1', 't2', 't3'].map((t) => off.getTenantOS(t).core.decisionStyle.get());
      const diversity = personalityDiversity(styles);
      assert.equal(diversity.diversityScore, 0, 'magnitude=0 应保持出生同质（向后兼容）');
    });

    it('已演化的租户重启不漂移（pristine 守卫——只影响全新 persona）', () => {
      /* 出生 → 人为演化 decision style（模拟已设置/演化）→ 从缓存驱逐 → 重新加载。
       * pristine 守卫应让重载不再扰动，保留演化值。 */
      const os = factory.getTenantOS('tenant-evolved');
      os.core.setDecisionStyle({ ...os.core.decisionStyle.get(), riskAppetite: 0.99 });
      factory.evict('tenant-evolved');

      const reloaded = factory.getTenantOS('tenant-evolved').core.decisionStyle.get();
      assert.equal(reloaded.riskAppetite, 0.99, '已写过 row 的租户重载不应被出生扰动覆盖');
    });

    /* Codex 两轮退回核心：现有租户可能只写过某一类核心状态（values / memories / survival anchors /
     * cognitive_model）却从未写 decision_style，因此没有 decision_style row。守卫必须看**整个核心是否
     * 纯净**（CoreSelfState 全 7 维），否则这类现有租户会被误判新生而首次扰动其懒默认人格。
     * 下列每个 case 都是现有公开路径可产生的状态。 */
    const legacyStateCases: Array<[string, (os: ReturnType<TenantOSFactory['getTenantOS']>) => void]> = [
      ['values（/values API）', (os) => os.core.addValue('诚实', 0.8)],
      ['memories（/perceive、chat）', (os) => os.core.addMemory('episodic', '一段经历', 0.2, 0.5)],
      ['survival anchors（/pos/survival）', (os) => os.core.addSurvivalAnchor('底线', 'constraint', null, 5)],
      ['cognitive_model（POS L3）', (os) => os.core.setCognitiveModel({ growthMindset: 0.7 })],
      ['narrative（叙事写入）', (os) => os.core.narrative.set('我的故事')],
    ];

    for (const [label, writeState] of legacyStateCases) {
      it(`现有租户只有 ${label} 但无 decision_style row → 重载不被首次出生扰动`, () => {
        /* magnitude=0 工厂出生（不写 decision_style row）→ 写入该类核心状态 → 制造「有核心状态无 row」态。 */
        const seedFree = new TenantOSFactory(db, new TestClock(1000), new SilentLogger(), {
          personalityBirthMagnitude: 0,
        });
        const os = seedFree.getTenantOS('tenant-legacy');
        assert.equal(os.core.decisionStyle.exists(), false, '前置：该租户无 decision_style row');
        writeState(os);
        const before = os.core.decisionStyle.get(); /* 懒默认 */
        seedFree.evict('tenant-legacy');

        /* 用**开启扰动**的工厂重新加载同租户（模拟升级后首次经新工厂加载）。 */
        const upgraded = new TenantOSFactory(db, new TestClock(1000), new SilentLogger(), {
          personalityBirthMagnitude: 0.15,
        });
        const after = upgraded.getTenantOS('tenant-legacy').core.decisionStyle.get();
        assert.equal(after.riskAppetite, before.riskAppetite, `只有 ${label} 的现有租户不应被首次出生扰动`);
        assert.equal(after.explorationBias, before.explorationBias, '现有租户决策风格应保持懒默认');
      });
    }
  });

  /** 为可复现测试提供一份独立的干净 DB（同迁移）。 */
  function db2(): IDatabase {
    const d = createMemoryDatabase();
    runDslSqliteMigrations(d);
    return d;
  }
});
