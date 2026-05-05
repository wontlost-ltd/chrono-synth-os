/**
 * 单元测试：SubscriptionGateService（P1-D 加固 6）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import type { IDatabase } from '../../storage/database.js';
import { SubscriptionGateService } from '../../billing/subscription-gate-service.js';

const TENANT = 'tenant_gate';

function insertSubscription(
  db: IDatabase,
  override: Partial<{
    plan_id: string;
    status: 'active' | 'trialing' | 'past_due' | 'canceled';
    grace_period_ends_at: number | null;
    trial_end: number | null;
  }>,
): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO subscriptions (
      id, tenant_id, plan_id, status,
      current_period_start, current_period_end,
      grace_period_ends_at, trial_end, cancel_at_period_end,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    `sub_${now}`,
    TENANT,
    override.plan_id ?? 'starter',
    override.status ?? 'active',
    now,
    now + 30 * 24 * 60 * 60 * 1000,
    override.grace_period_ends_at ?? null,
    override.trial_end ?? null,
    now,
    now,
  );
}

function recordUsage(db: IDatabase, resource: string, quantity: number): void {
  db.prepare<void>(
    `INSERT INTO usage_records (id, tenant_id, resource, quantity, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`u_${Math.random()}`, TENANT, resource, quantity, Date.now());
}

describe('SubscriptionGateService', () => {
  let db: IDatabase;
  let gate: SubscriptionGateService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    gate = new SubscriptionGateService(db);
  });

  afterEach(() => db.close());

  it('active 订阅 → allowed', () => {
    insertSubscription(db, { status: 'active' });
    const r = gate.canUseResource(TENANT, 'conversation_message');
    assert.equal(r.allowed, true);
    if (r.allowed) assert.equal(r.reason, 'active');
  });

  it('trialing 订阅 → allowed', () => {
    insertSubscription(db, { status: 'trialing', trial_end: Date.now() + 86400_000 });
    const r = gate.canUseResource(TENANT, 'conversation_message');
    assert.equal(r.allowed, true);
  });

  it('past_due 在宽限期内 → allowed (within_grace)', () => {
    insertSubscription(db, {
      status: 'past_due',
      grace_period_ends_at: Date.now() + 24 * 60 * 60 * 1000,
    });
    const r = gate.canUseResource(TENANT, 'conversation_message');
    assert.equal(r.allowed, true);
    if (r.allowed) assert.equal(r.reason, 'past_due_within_grace');
  });

  it('past_due 宽限期已过 → 402', () => {
    insertSubscription(db, {
      status: 'past_due',
      grace_period_ends_at: Date.now() - 1000,
    });
    const r = gate.canUseResource(TENANT, 'conversation_message');
    assert.equal(r.allowed, false);
    if (!r.allowed) {
      assert.equal(r.statusCode, 402);
      assert.equal(r.reason, 'past_due_grace_expired');
    }
  });

  it('无订阅行 + 月用量 < free quota → allowed (free_within_quota)', () => {
    /* free quota for conversation_message = 100 */
    recordUsage(db, 'conversation_message', 50);
    const r = gate.canUseResource(TENANT, 'conversation_message');
    assert.equal(r.allowed, true);
  });

  it('无订阅行 + 月用量 >= free quota → 402 free_quota_exceeded', () => {
    recordUsage(db, 'conversation_message', 100);
    const r = gate.canUseResource(TENANT, 'conversation_message');
    assert.equal(r.allowed, false);
    if (!r.allowed) {
      assert.equal(r.statusCode, 402);
      assert.equal(r.reason, 'free_quota_exceeded');
      assert.equal(r.upgradeUrl, '/billing/checkout');
    }
  });

  it('canceled 订阅 + 月用量 < free quota → allowed', () => {
    insertSubscription(db, { plan_id: 'starter', status: 'canceled' });
    recordUsage(db, 'conversation_message', 50);
    const r = gate.canUseResource(TENANT, 'conversation_message');
    assert.equal(r.allowed, true);
  });

  it('canceled 订阅 + 月用量 >= free quota → 402', () => {
    insertSubscription(db, { plan_id: 'starter', status: 'canceled' });
    recordUsage(db, 'conversation_message', 100);
    const r = gate.canUseResource(TENANT, 'conversation_message');
    assert.equal(r.allowed, false);
  });

  it('bulk_knowledge_import_item 资源同样支持闸门', () => {
    recordUsage(db, 'bulk_knowledge_import_item', 60);
    const r = gate.canUseResource(TENANT, 'bulk_knowledge_import_item');
    /* free 计划 bulkImportItemsPerMonth = 50 → 已超 */
    assert.equal(r.allowed, false);
  });
});
