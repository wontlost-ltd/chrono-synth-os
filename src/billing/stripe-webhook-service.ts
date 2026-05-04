/**
 * Stripe Webhook Application Service
 * 封装 Stripe webhook 事件处理的数据访问与业务逻辑
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork, SwhsSubscriptionRow } from '@chrono/kernel';
import { syncPlanToQuota, PLANS } from './plans.js';
import type { EntitlementService } from './entitlement-service.js';
import {
  swhsQueryLatestSubscription, swhsQuerySubByStripeCustomer,
  swhsCmdRecordEvent, swhsCmdPersistStripeCustomer,
  swhsCmdPurchaseAddon, swhsCmdUpdateSubscription,
  swhsCmdCancelByCustomer, swhsCmdCancelTenantAddons,
  swhsCmdFinalizeTrialPeriod, swhsCmdReviveInvoicePaid, swhsCmdMarkPastDue,
} from '@chrono/kernel';
import { asUow, unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export type { SwhsSubscriptionRow as SubscriptionRow };

/** Stripe price ID → 内部 plan ID 映射 */
const PRICE_TO_PLAN = new Map(PLANS.filter(p => p.stripePriceId).map(p => [p.stripePriceId, p.id]));

export interface WebhookProcessResult {
  received: true;
  duplicate?: boolean;
}

export class StripeWebhookService {
  private readonly tx: SyncWriteUnitOfWork;
  private readonly db: IDatabase | null;
  private readonly uowOrDb: UowOrDb;

  constructor(
    uowOrDb: UowOrDb,
    private readonly entitlementService: EntitlementService,
  ) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
    this.db = unwrapDb(uowOrDb);
    this.uowOrDb = uowOrDb;
  }

  private runAtomic<T>(fn: () => T): T {
    if (this.db) return this.db.transaction(fn);
    return fn();
  }

  /**
   * 处理 Stripe webhook 事件（幂等，事务内执行）
   * @returns duplicate=true 表示重复事件已跳过
   */
  processEvent(eventId: string, eventType: string, dataObject: Record<string, unknown>): WebhookProcessResult {
    let duplicate = false;

    this.runAtomic(() => {
      const now = Date.now();
      const inserted = this.tx.execute(swhsCmdRecordEvent({ eventId, eventType, now }));

      if (inserted.rowsAffected === 0) {
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
        case 'customer.subscription.trial_will_end':
          this.handleTrialWillEnd(dataObject, now);
          break;
        case 'invoice.paid':
        case 'invoice.payment_succeeded':
          this.handleInvoicePaid(dataObject, now);
          break;
        case 'invoice.payment_failed':
          this.handleInvoicePaymentFailed(dataObject, now);
          break;
      }
    });

    return duplicate ? { received: true, duplicate: true } : { received: true };
  }

  /** 将 Stripe 客户 ID 回写到已有订阅行（懒创建场景） */
  persistStripeCustomerId(stripeCustomerId: string, subscriptionId?: string): void {
    if (subscriptionId) {
      this.tx.execute(swhsCmdPersistStripeCustomer({
        stripeCustomerId,
        subscriptionId,
        now: Date.now(),
      }));
    }
  }

  /** 获取完整订阅行（含 stripe 字段），供 checkout/portal 使用 */
  getLatestSubscription(tenantId: string): SwhsSubscriptionRow | undefined {
    return this.tx.queryOne(swhsQueryLatestSubscription(tenantId)) ?? undefined;
  }

  /** 购买附加组件（插入 + 权益同步在同一事务内） */
  purchaseAddOn(tenantId: string, addOnId: string): void {
    this.runAtomic(() => {
      const now = Date.now();
      this.tx.execute(swhsCmdPurchaseAddon({
        id: `ta_${randomUUID()}`,
        tenantId,
        addOnId,
        now,
      }));
      this.entitlementService.syncTenantEntitlements(tenantId);
    });
  }

  private handleSubscriptionUpsert(subscription: Record<string, unknown>, now: number): void {
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : (subscription.customer as { id: string })?.id ?? '';

    const tenantSub = this.tx.queryOne(swhsQuerySubByStripeCustomer(customerId));
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

    this.tx.execute(swhsCmdUpdateSubscription({
      subscriptionRowId: tenantSub.id,
      stripeSubscriptionId: subscription.id as string,
      status,
      planId: resolvedPlanId,
      periodStart,
      periodEnd,
      now,
    }));

    /* 同步 P1-D 新字段：trial_end / cancel_at_period_end */
    const trialEnd = typeof subscription.trial_end === 'number' && subscription.trial_end > 0
      ? subscription.trial_end * 1000 : null;
    const cancelAtPeriodEnd = subscription.cancel_at_period_end === true ? 1 : 0;
    this.tx.execute(swhsCmdFinalizeTrialPeriod({
      subscriptionRowId: tenantSub.id,
      trialEnd,
      cancelAtPeriodEnd,
      now,
    }));

    if (resolvedPlanId !== tenantSub.plan_id) {
      syncPlanToQuota(this.uowOrDb, tenantSub.tenant_id, resolvedPlanId);
      this.entitlementService.syncTenantEntitlements(tenantSub.tenant_id);
    }
  }

  private handleTrialWillEnd(subscription: Record<string, unknown>, now: number): void {
    /* 仅记录信号：业务侧通过 audit log 检测后通知用户。
     * 这里不主动改 status（仍然 trialing 直到 Stripe 推送 subscription.updated）。 */
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : (subscription.customer as { id: string })?.id ?? '';
    if (!customerId) return;
    /* 写入 webhook_events 表已由 swhsCmdRecordEvent 完成；此处仅 noop。
     * 业务侧通过 webhook_events.event_type='customer.subscription.trial_will_end' 触发通知。 */
    void now;
  }

  private handleInvoicePaid(invoice: Record<string, unknown>, now: number): void {
    const customerId = typeof invoice.customer === 'string'
      ? invoice.customer
      : (invoice.customer as { id: string })?.id ?? '';
    if (!customerId) return;

    const tenantSub = this.tx.queryOne(swhsQuerySubByStripeCustomer(customerId));
    if (!tenantSub) return;

    const invoiceId = typeof invoice.id === 'string' ? invoice.id : null;

    this.tx.execute(swhsCmdReviveInvoicePaid({
      subscriptionRowId: tenantSub.id,
      invoiceId,
      now,
    }));

    if (tenantSub.status === 'past_due') {
      /* 复活：把配额恢复到当前 plan */
      syncPlanToQuota(this.uowOrDb, tenantSub.tenant_id, tenantSub.plan_id);
      this.entitlementService.syncTenantEntitlements(tenantSub.tenant_id);
    }
  }

  private handleInvoicePaymentFailed(invoice: Record<string, unknown>, now: number): void {
    const customerId = typeof invoice.customer === 'string'
      ? invoice.customer
      : (invoice.customer as { id: string })?.id ?? '';
    if (!customerId) return;

    const tenantSub = this.tx.queryOne(swhsQuerySubByStripeCustomer(customerId));
    if (!tenantSub) return;

    const invoiceId = typeof invoice.id === 'string' ? invoice.id : null;
    const graceMs = 3 * 24 * 60 * 60 * 1000;

    this.tx.execute(swhsCmdMarkPastDue({
      subscriptionRowId: tenantSub.id,
      graceEndsAt: now + graceMs,
      invoiceId,
      now,
    }));
  }

  private handleSubscriptionDeleted(subscription: Record<string, unknown>, now: number): void {
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : (subscription.customer as { id: string })?.id ?? '';

    const canceledSub = this.tx.queryOne(swhsQuerySubByStripeCustomer(customerId));

    this.tx.execute(swhsCmdCancelByCustomer({ stripeCustomerId: customerId, now }));

    if (canceledSub) {
      syncPlanToQuota(this.uowOrDb, canceledSub.tenant_id, 'free');
      this.tx.execute(swhsCmdCancelTenantAddons({ tenantId: canceledSub.tenant_id, now }));
      this.entitlementService.syncTenantEntitlements(canceledSub.tenant_id);
    }
  }
}
