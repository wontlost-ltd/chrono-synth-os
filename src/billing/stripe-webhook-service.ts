/**
 * Stripe Webhook Application Service
 * 封装 Stripe webhook 事件处理的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import { syncPlanToQuota, PLANS } from './plans.js';
import type { EntitlementService } from './entitlement-service.js';

export interface SubscriptionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly plan_id: string;
  readonly status: string;
  readonly current_period_end: number | null;
}

/** Stripe price ID → 内部 plan ID 映射 */
const PRICE_TO_PLAN = new Map(PLANS.filter(p => p.stripePriceId).map(p => [p.stripePriceId, p.id]));

export interface WebhookProcessResult {
  received: true;
  duplicate?: boolean;
}

export class StripeWebhookService {
  constructor(
    private readonly db: IDatabase,
    private readonly entitlementService: EntitlementService,
  ) {}

  /**
   * 处理 Stripe webhook 事件（幂等，事务内执行）
   * @returns duplicate=true 表示重复事件已跳过
   */
  processEvent(eventId: string, eventType: string, dataObject: Record<string, unknown>): WebhookProcessResult {
    let duplicate = false;

    this.db.transaction(() => {
      const now = Date.now();
      const inserted = this.db.prepare<void>(
        'INSERT INTO webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING',
      ).run(eventId, eventType, now);

      if (inserted.changes === 0) {
        duplicate = true;
        return;
      }

      switch (eventType) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          this.handleSubscriptionUpsert(dataObject, now);
          break;
        case 'customer.subscription.deleted':
          this.handleSubscriptionDeleted(dataObject, now);
          break;
      }
    });

    return duplicate ? { received: true, duplicate: true } : { received: true };
  }

  /** 将 Stripe 客户 ID 回写到已有订阅行（懒创建场景） */
  persistStripeCustomerId(stripeCustomerId: string, subscriptionId?: string): void {
    if (subscriptionId) {
      this.db.prepare<void>('UPDATE subscriptions SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
        .run(stripeCustomerId, Date.now(), subscriptionId);
    }
  }

  /** 获取完整订阅行（含 stripe 字段），供 checkout/portal 使用 */
  getLatestSubscription(tenantId: string): SubscriptionRow | undefined {
    return this.db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);
  }

  /** 购买附加组件（插入 + 权益同步在同一事务内） */
  purchaseAddOn(tenantId: string, addOnId: string): void {
    this.db.transaction(() => {
      const now = Date.now();
      this.db.prepare<void>(
        `INSERT INTO tenant_add_ons (id, tenant_id, add_on_id, status, purchased_at) VALUES (?, ?, ?, 'active', ?)`,
      ).run(`ta_${randomUUID()}`, tenantId, addOnId, now);
      this.entitlementService.syncTenantEntitlements(tenantId);
    });
  }

  private handleSubscriptionUpsert(subscription: Record<string, unknown>, now: number): void {
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : (subscription.customer as { id: string })?.id ?? '';

    const tenantSub = this.db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE stripe_customer_id = ?',
    ).get(customerId);

    if (!tenantSub) return;

    const rawStatus = typeof subscription.status === 'string' ? subscription.status : 'active';
    const status = rawStatus === 'active' ? 'active'
      : rawStatus === 'trialing' ? 'trialing'
      : rawStatus === 'canceled' ? 'canceled'
      : 'past_due';

    const periodStart = typeof subscription.current_period_start === 'number'
      ? subscription.current_period_start * 1000 : now;
    const periodEnd = typeof subscription.current_period_end === 'number'
      ? subscription.current_period_end * 1000 : now;

    const items = subscription.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
    const priceId = items?.data?.[0]?.price?.id;
    const resolvedPlanId = (priceId && PRICE_TO_PLAN.get(priceId)) ?? tenantSub.plan_id;

    this.db.prepare<void>(
      `UPDATE subscriptions SET stripe_subscription_id = ?, status = ?, plan_id = ?, current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?`,
    ).run(subscription.id as string, status, resolvedPlanId, periodStart, periodEnd, now, tenantSub.id);

    if (resolvedPlanId !== tenantSub.plan_id) {
      syncPlanToQuota(this.db, tenantSub.tenant_id, resolvedPlanId);
      this.entitlementService.syncTenantEntitlements(tenantSub.tenant_id);
    }
  }

  private handleSubscriptionDeleted(subscription: Record<string, unknown>, now: number): void {
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : (subscription.customer as { id: string })?.id ?? '';

    const canceledSub = this.db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE stripe_customer_id = ?',
    ).get(customerId);

    this.db.prepare<void>(
      `UPDATE subscriptions SET status = 'canceled', plan_id = 'free', updated_at = ? WHERE stripe_customer_id = ?`,
    ).run(now, customerId);

    if (canceledSub) {
      syncPlanToQuota(this.db, canceledSub.tenant_id, 'free');
      this.db.prepare<void>(
        `UPDATE tenant_add_ons SET status = 'canceled', canceled_at = ? WHERE tenant_id = ? AND status = 'active'`,
      ).run(now, canceledSub.tenant_id);
      this.entitlementService.syncTenantEntitlements(canceledSub.tenant_id);
    }
  }
}
