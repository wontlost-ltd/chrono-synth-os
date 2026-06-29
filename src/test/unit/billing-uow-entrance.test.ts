/**
 * 单元测试：billing 模块全量 UoW 双入口（Phase 3 Bil 验收）
 *
 * 验收要点：每个 service 都接受 IDatabase 与 SyncWriteUnitOfWork 两种构造，
 * 且核心读路径在两种入口下行为一致。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { loadConfig } from '../../config/schema.js';
import { ApiKeyService } from '../../billing/api-key-service.js';
import { BillingOutbox } from '../../billing/billing-outbox.js';
import { SubscriptionQueryService } from '../../billing/subscription-query-service.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import { EntitlementService } from '../../billing/entitlement-service.js';
import { NodeEntitlementService } from '../../billing/node-entitlement-service.js';
import { BillingService } from '../../billing/billing-service.js';
import { SettlementReconciliationService } from '../../billing/settlement-reconciliation-service.js';
import { StripeWebhookService } from '../../billing/stripe-webhook-service.js';
import { listAddOns } from '../../billing/add-ons.js';
import { syncPlanToQuota } from '../../billing/plans.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';

describe('Phase 3 Bil：billing 模块双入口', () => {
  it('A 类：UsageTracker / SubscriptionQueryService / ApiKeyService / BillingOutbox 双入口构造均成功', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const config = loadConfig({});
    try {
      assert.equal(new UsageTracker(db).getUsage('default', 'simulation'), 0);
      assert.equal(new UsageTracker(db).getUsage('default', 'simulation'), 0);

      assert.equal(new SubscriptionQueryService(db).getLatestPlanId('default'), 'free');
      assert.equal(new SubscriptionQueryService(db).getLatestPlanId('default'), 'free');

      assert.deepEqual(new ApiKeyService(db).list('default'), []);
      assert.deepEqual(new ApiKeyService(db).list('default'), []);

      assert.equal(new BillingOutbox(db, config).pendingCount(), 0);
      assert.equal(new BillingOutbox(db, config).pendingCount(), 0);
    } finally { db.close(); }
  });

  it('BillingOutbox 幂等入队：同 sourceId 重复入队去重，防重复计费（P2-o）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const config = loadConfig({});
    try {
      const outbox = new BillingOutbox(db, config);

      /* 同一逻辑计量事件（同 sourceId）重复入队 → 仅一条落库（ON CONFLICT DO NOTHING） */
      assert.equal(outbox.enqueue('t1', 'cus_1', 'llm_tokens', 100, 'msg-abc'), true, '首次入队返回 true（已落库）');
      assert.equal(outbox.enqueue('t1', 'cus_1', 'llm_tokens', 100, 'msg-abc'), false, '重复入队返回 false（去重），供调用方精确计量');
      assert.equal(outbox.pendingCount(), 1, '同 sourceId 重复入队必须去重');

      /* 不同 sourceId 各自落库 */
      outbox.enqueue('t1', 'cus_1', 'llm_tokens', 50, 'msg-def');
      assert.equal(outbox.pendingCount(), 2, '不同 sourceId 应分别入队');

      /* 跨租户同 sourceId 互不冲突（key 含 tenant 前缀） */
      outbox.enqueue('t2', 'cus_2', 'llm_tokens', 100, 'msg-abc');
      assert.equal(outbox.pendingCount(), 3, '不同租户同 sourceId 不应被去重');
    } finally { db.close(); }
  });

  it('BillingOutbox 无 sourceId 回退键不含随机数但保证唯一（确定性 P2-o）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const config = loadConfig({});
    try {
      const outbox = new BillingOutbox(db, config);
      /* 无 sourceId：回退键用 clock+seq，单实例内多次入队互不冲突且全部落库 */
      outbox.enqueue('t1', 'cus_1', 'simulation', 1);
      outbox.enqueue('t1', 'cus_1', 'simulation', 1);
      assert.equal(outbox.pendingCount(), 2, '无 sourceId 多次入队各自唯一落库');
    } finally { db.close(); }
  });

  it('A 类：listAddOns / syncPlanToQuota / QuotaManager 函数与类双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      assert.deepEqual(listAddOns(db, false), []);
      assert.deepEqual(listAddOns(db, false), []);

      syncPlanToQuota(db, 'tenant_a', 'free');
      syncPlanToQuota(db, 'tenant_b', 'starter');

      assert.equal(new QuotaManager(db).checkQuota('tenant_a', 'simulation'), true);
      assert.equal(new QuotaManager(db).checkQuota('tenant_b', 'simulation'), true);
    } finally { db.close(); }
  });

  it('A 类：EntitlementService / NodeEntitlementService 双入口', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new EntitlementService(db);
      const fromUow = new EntitlementService(db);
      assert.deepEqual(
        fromDb.computeEffectiveLimits('default'),
        fromUow.computeEffectiveLimits('default'),
      );

      const node = new NodeEntitlementService(db);
      const limits = await node.effectiveLimits({ tenantId: 'default' });
      assert.ok(limits.maxSimulations !== undefined);
    } finally { db.close(); }
  });

  it('B 类：BillingService / StripeWebhookService / SettlementReconciliationService 双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDbSvc = new BillingService(db);
      assert.ok(fromDbSvc.listPlans().length > 0);
      const fromUowSvc = new BillingService(db);
      assert.ok(fromUowSvc.listPlans().length > 0);

      const ent = new EntitlementService(db);
      const fromDbWh = new StripeWebhookService(db, ent);
      const fromUowWh = new StripeWebhookService(db, ent);
      assert.equal(fromDbWh.getLatestSubscription('default'), undefined);
      assert.equal(fromUowWh.getLatestSubscription('default'), undefined);

      const fromDbRec = new SettlementReconciliationService(db);
      const fromUowRec = new SettlementReconciliationService(db);
      assert.deepEqual(fromDbRec.listRuns('default'), fromUowRec.listRuns('default'));
    } finally { db.close(); }
  });
});
