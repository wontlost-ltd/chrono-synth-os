/**
 * 单元测试：StripeWebhookService 扩展事件（P1-D 加固 5）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import type { IDatabase } from '../../storage/database.js';
import { StripeWebhookService } from '../../billing/stripe-webhook-service.js';
import { EntitlementService } from '../../billing/entitlement-service.js';

const TENANT = 'tenant_wh';
const STRIPE_CUSTOMER = 'cus_test_123';

function seedSubscription(
  db: IDatabase,
  override: Partial<{
    plan_id: string;
    status: 'active' | 'trialing' | 'past_due' | 'canceled';
    grace_period_ends_at: number | null;
  }>,
): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO subscriptions (
      id, tenant_id, stripe_customer_id, stripe_subscription_id, plan_id, status,
      current_period_start, current_period_end, grace_period_ends_at,
      cancel_at_period_end, created_at, updated_at
    ) VALUES ('sub_init', ?, ?, 'sub_stripe_xxx', ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    TENANT, STRIPE_CUSTOMER,
    override.plan_id ?? 'starter',
    override.status ?? 'active',
    now, now + 30 * 24 * 60 * 60 * 1000,
    override.grace_period_ends_at ?? null,
    now, now,
  );
}

function readSubscription(db: IDatabase): {
  status: string;
  grace_period_ends_at: number | null;
  last_invoice_id: string | null;
  trial_end: number | null;
  cancel_at_period_end: number;
} | undefined {
  return db.prepare<{
    status: string;
    grace_period_ends_at: number | null;
    last_invoice_id: string | null;
    trial_end: number | null;
    cancel_at_period_end: number;
  }>(
    `SELECT status, grace_period_ends_at, last_invoice_id, trial_end, cancel_at_period_end
       FROM subscriptions
      WHERE tenant_id = ?
      LIMIT 1`,
  ).get(TENANT);
}

describe('StripeWebhookService 扩展事件', () => {
  let db: IDatabase;
  let service: StripeWebhookService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    service = new StripeWebhookService(db, new EntitlementService(db));
  });

  afterEach(() => db.close());

  it('invoice.payment_failed → status=past_due, grace_period_ends_at 设为 now+3d', () => {
    seedSubscription(db, { status: 'active' });
    const before = Date.now();
    service.processEvent('evt_failed_1', 'invoice.payment_failed', {
      id: 'in_failed',
      customer: STRIPE_CUSTOMER,
    });
    const sub = readSubscription(db);
    assert.equal(sub?.status, 'past_due');
    assert.ok(sub?.grace_period_ends_at !== null);
    assert.ok(sub!.grace_period_ends_at! >= before + 3 * 24 * 60 * 60 * 1000 - 1000);
    assert.equal(sub?.last_invoice_id, 'in_failed');
  });

  it('invoice.paid 之后从 past_due 恢复 active 且清除 grace', () => {
    seedSubscription(db, {
      status: 'past_due',
      grace_period_ends_at: Date.now() + 86400_000,
    });
    service.processEvent('evt_paid_1', 'invoice.paid', {
      id: 'in_paid',
      customer: STRIPE_CUSTOMER,
    });
    const sub = readSubscription(db);
    assert.equal(sub?.status, 'active');
    assert.equal(sub?.grace_period_ends_at, null);
    assert.equal(sub?.last_invoice_id, 'in_paid');
  });

  it('invoice.payment_succeeded 别名也能处理', () => {
    seedSubscription(db, { status: 'past_due' });
    service.processEvent('evt_paid_alias', 'invoice.payment_succeeded', {
      id: 'in_paid_alias',
      customer: STRIPE_CUSTOMER,
    });
    const sub = readSubscription(db);
    assert.equal(sub?.status, 'active');
  });

  it('customer.subscription.updated 携带 trial_end 与 cancel_at_period_end 同步到 DB', () => {
    seedSubscription(db, { status: 'trialing' });
    const trialEndSec = Math.floor(Date.now() / 1000) + 7 * 86400;
    service.processEvent('evt_upd_1', 'customer.subscription.updated', {
      id: 'sub_stripe_xxx',
      customer: STRIPE_CUSTOMER,
      status: 'trialing',
      trial_end: trialEndSec,
      cancel_at_period_end: true,
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    });
    const sub = readSubscription(db);
    assert.equal(sub?.cancel_at_period_end, 1);
    assert.equal(sub?.trial_end, trialEndSec * 1000);
  });

  it('trial_will_end 仅记录 webhook_events，不改 status', () => {
    seedSubscription(db, { status: 'trialing' });
    service.processEvent('evt_trial_warn', 'customer.subscription.trial_will_end', {
      id: 'sub_stripe_xxx',
      customer: STRIPE_CUSTOMER,
    });
    const sub = readSubscription(db);
    assert.equal(sub?.status, 'trialing');

    /* webhook_events 表应有该 event */
    const evt = db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM webhook_events WHERE event_id = ? AND event_type = ?`,
    ).get('evt_trial_warn', 'customer.subscription.trial_will_end');
    assert.equal(evt?.count, 1);
  });

  it('幂等：同 event_id 重复处理不重复改库', () => {
    seedSubscription(db, { status: 'active' });
    const r1 = service.processEvent('evt_dup', 'invoice.payment_failed', {
      id: 'in_dup', customer: STRIPE_CUSTOMER,
    });
    const r2 = service.processEvent('evt_dup', 'invoice.payment_failed', {
      id: 'in_dup', customer: STRIPE_CUSTOMER,
    });
    assert.equal(r1.duplicate, undefined);
    assert.equal(r2.duplicate, true);
  });
});
