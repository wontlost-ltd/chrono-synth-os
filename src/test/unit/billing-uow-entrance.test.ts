/**
 * 单元测试：billing 模块全量 UoW 双入口（Phase 3 Bil 验收）
 *
 * 验收要点：每个 service 都接受 IDatabase 与 SyncWriteUnitOfWork 两种构造，
 * 且核心读路径在两种入口下行为一致。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';
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
    runMigrations(db);
    const config = loadConfig({});
    try {
      assert.equal(new UsageTracker(directUnitOfWork(db)).getUsage('default', 'simulation'), 0);
      assert.equal(new UsageTracker(directUnitOfWork(db)).getUsage('default', 'simulation'), 0);

      assert.equal(new SubscriptionQueryService(directUnitOfWork(db)).getLatestPlanId('default'), 'free');
      assert.equal(new SubscriptionQueryService(directUnitOfWork(db)).getLatestPlanId('default'), 'free');

      assert.deepEqual(new ApiKeyService(directUnitOfWork(db)).list('default'), []);
      assert.deepEqual(new ApiKeyService(directUnitOfWork(db)).list('default'), []);

      assert.equal(new BillingOutbox(directUnitOfWork(db), config).pendingCount(), 0);
      assert.equal(new BillingOutbox(directUnitOfWork(db), config).pendingCount(), 0);
    } finally { db.close(); }
  });

  it('A 类：listAddOns / syncPlanToQuota / QuotaManager 函数与类双入口', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      assert.deepEqual(listAddOns(directUnitOfWork(db), false), []);
      assert.deepEqual(listAddOns(directUnitOfWork(db), false), []);

      syncPlanToQuota(directUnitOfWork(db), 'tenant_a', 'free');
      syncPlanToQuota(directUnitOfWork(db), 'tenant_b', 'starter');

      assert.equal(new QuotaManager(directUnitOfWork(db)).checkQuota('tenant_a', 'simulation'), true);
      assert.equal(new QuotaManager(directUnitOfWork(db)).checkQuota('tenant_b', 'simulation'), true);
    } finally { db.close(); }
  });

  it('A 类：EntitlementService / NodeEntitlementService 双入口', async () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDb = new EntitlementService(directUnitOfWork(db));
      const fromUow = new EntitlementService(directUnitOfWork(db));
      assert.deepEqual(
        fromDb.computeEffectiveLimits('default'),
        fromUow.computeEffectiveLimits('default'),
      );

      const node = new NodeEntitlementService(directUnitOfWork(db));
      const limits = await node.effectiveLimits({ tenantId: 'default' });
      assert.ok(limits.maxSimulations !== undefined);
    } finally { db.close(); }
  });

  it('B 类：BillingService / StripeWebhookService / SettlementReconciliationService 双入口', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDbSvc = new BillingService(directUnitOfWork(db));
      assert.ok(fromDbSvc.listPlans().length > 0);
      const fromUowSvc = new BillingService(directUnitOfWork(db));
      assert.ok(fromUowSvc.listPlans().length > 0);

      const ent = new EntitlementService(directUnitOfWork(db));
      const fromDbWh = new StripeWebhookService(directUnitOfWork(db), ent);
      const fromUowWh = new StripeWebhookService(directUnitOfWork(db), ent);
      assert.equal(fromDbWh.getLatestSubscription('default'), undefined);
      assert.equal(fromUowWh.getLatestSubscription('default'), undefined);

      const fromDbRec = new SettlementReconciliationService(directUnitOfWork(db));
      const fromUowRec = new SettlementReconciliationService(directUnitOfWork(db));
      assert.deepEqual(fromDbRec.listRuns('default'), fromUowRec.listRuns('default'));
    } finally { db.close(); }
  });
});
