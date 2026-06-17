import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { MetricsQueryService } from '../../observability/metrics-query-service.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import type { IDatabase } from '../../storage/database.js';

/**
 * 平台人群多样性度量（①度量 surface）：MetricsQueryService.getPopulationDiversity 跨租户读
 * 所有 decision_style，计算群体多样性。decision_style PK=tenant_id，每租户一份决策风格，故
 * 多样性是跨租户群体统计。
 */
describe('MetricsQueryService.getPopulationDiversity（平台人群多样性 surface）', () => {
  let db: IDatabase;
  let factory: TenantOSFactory;
  let metrics: MetricsQueryService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    /* 出生扰动开启：每租户按 tenantId 派生确定性差异，群体应有多样性。 */
    factory = new TenantOSFactory(db, new TestClock(1000), new SilentLogger(), {
      personalityBirthMagnitude: 0.15,
    });
    metrics = new MetricsQueryService(db);
  });

  it('空平台（无任何租户）→ population=0 diversityScore=0', () => {
    const d = metrics.getPopulationDiversity();
    assert.equal(d.count, 0);
    assert.equal(d.diversityScore, 0);
  });

  it('单租户 → population=1 diversityScore=0（无成对可比）', () => {
    factory.getTenantOS('only-tenant');
    const d = metrics.getPopulationDiversity();
    assert.equal(d.count, 1);
    assert.equal(d.diversityScore, 0, '单租户无成对距离');
  });

  it('多租户（出生扰动开启）→ population=N diversityScore>0', () => {
    for (const t of ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d']) {
      factory.getTenantOS(t);
    }
    const d = metrics.getPopulationDiversity();
    assert.equal(d.count, 4, '应统计全部 4 个租户的决策风格');
    assert.ok(d.diversityScore > 0, `多租户群体应有多样性，实际 ${d.diversityScore}`);
    /* perDimensionSpread/Mean 应是合法 [0,1] 数值（非 NaN）。 */
    for (const v of Object.values(d.perDimensionSpread)) {
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 0.5, `spread 应在 [0,0.5]，实际 ${v}`);
    }
  });

  it('跨租户聚合：不被任一租户隔离（读到所有租户）', () => {
    /* 显式给两个租户设不同的决策风格，验证两者都被纳入群体度量。 */
    const a = factory.getTenantOS('iso-a');
    a.core.setDecisionStyle({ ...a.core.decisionStyle.get(), riskAppetite: 0.1 });
    const b = factory.getTenantOS('iso-b');
    b.core.setDecisionStyle({ ...b.core.decisionStyle.get(), riskAppetite: 0.9 });

    const d = metrics.getPopulationDiversity();
    assert.equal(d.count, 2, '跨租户应同时读到 iso-a 与 iso-b');
    assert.ok(d.diversityScore > 0, 'riskAppetite 0.1 vs 0.9 应产生多样性');
  });

  it('畸形 style_json 行被跳过，不污染度量也不抛错', () => {
    /* 写一条合法 + 一条畸形 style_json（直接写库绕过 setDecisionStyle 校验）。 */
    factory.getTenantOS('good-tenant'); /* 合法行 */
    db.prepare<void>(
      `INSERT INTO decision_style (tenant_id, style_json, updated_at) VALUES (?, ?, ?)`,
    ).run('broken-tenant', '{not valid json', 1000);

    const d = metrics.getPopulationDiversity();
    /* 畸形行被跳过，仅合法行计入（count=1）；不抛错。 */
    assert.equal(d.count, 1, '畸形 style_json 行应被跳过');
  });

  it('TTL 缓存：TTL 内复用上次结果，过期后重算（避免高频 scrape O(n²) 阻塞）', () => {
    factory.getTenantOS('cache-a');
    factory.getTenantOS('cache-b');
    const first = metrics.getPopulationDiversity(1_000_000);
    assert.equal(first.count, 2);

    /* TTL（30s）内新增租户：缓存命中，count 仍为 2（不重算）。 */
    factory.getTenantOS('cache-c');
    const cached = metrics.getPopulationDiversity(1_010_000); /* +10s < 30s */
    assert.equal(cached.count, 2, 'TTL 内应复用缓存，不反映新增租户');

    /* 过 TTL 后：重算，反映全部 3 个租户。 */
    const recomputed = metrics.getPopulationDiversity(1_040_000); /* +40s > 30s */
    assert.equal(recomputed.count, 3, 'TTL 过期后应重算');
  });
});
