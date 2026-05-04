/**
 * 计费 Application Façade
 * 封装计费路由的业务逻辑：计划管理、订阅、用量、Stripe 集成、附加组件
 */

import { orgQueryTenantUserEmail } from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { AppConfig } from '../config/schema.js';
import { BillingService } from './billing-service.js';
import { SettlementReconciliationService } from './settlement-reconciliation-service.js';
import { UsageTracker } from './usage-tracker.js';
import { EntitlementService } from './entitlement-service.js';
import { StripeWebhookService } from './stripe-webhook-service.js';
import { PLANS, getPlanLimits } from './plans.js';
import { listAddOns, getAddOnById, seedDefaultAddOns } from './add-ons.js';
import {
  createCheckoutSession,
  refundPayment,
  createPortalSession,
  constructWebhookEvent,
  createCustomer,
} from './stripe-client.js';
import { ValidationError, StateError, ErrorCode } from '../errors/index.js';

const VALID_PRICE_IDS = new Set(PLANS.filter(p => p.stripePriceId).map(p => p.stripePriceId));

function isSafeRedirectUrl(url: string, allowedOriginSet: Set<string>): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  if (allowedOriginSet.size === 0) return false;
  try {
    return allowedOriginSet.has(new URL(url).origin);
  } catch {
    return false;
  }
}

const inflightCustomerCreation = new Map<string, Promise<string>>();

async function ensureStripeCustomer(
  db: IDatabase, config: AppConfig, webhookService: StripeWebhookService, tenantId: string,
): Promise<string> {
  const sub = webhookService.getLatestSubscription(tenantId);
  if (sub?.stripe_customer_id) return sub.stripe_customer_id;

  const inflight = inflightCustomerCreation.get(tenantId);
  if (inflight) return inflight;

  const promise = (async () => {
    registerCoreSelfExecutors();
    const tx = directUnitOfWork(db);
    const user = tx.queryOne(orgQueryTenantUserEmail(tenantId));
    if (!user) throw new StateError('租户无关联用户', ErrorCode.STATE_INVALID_TRANSITION);
    const customer = await createCustomer(config, user.email, tenantId);
    webhookService.persistStripeCustomerId(customer.id, sub?.id);
    return customer.id;
  })();

  inflightCustomerCreation.set(tenantId, promise);
  try {
    return await promise;
  } finally {
    inflightCustomerCreation.delete(tenantId);
  }
}

export class BillingRouteFacade {
  private readonly billingService: BillingService;
  private readonly settlementService: SettlementReconciliationService;
  private readonly usageTracker: UsageTracker;
  private readonly entitlementService: EntitlementService;
  readonly webhookService: StripeWebhookService;
  private readonly allowedOriginSet: Set<string>;

  constructor(private readonly db: IDatabase, private readonly config: AppConfig) {
    this.billingService = new BillingService(db);
    this.settlementService = new SettlementReconciliationService(db);
    this.usageTracker = new UsageTracker(db);
    this.entitlementService = new EntitlementService(db);
    this.webhookService = new StripeWebhookService(db, this.entitlementService);

    /* 构建允许的重定向源集合 */
    const rawOrigins: string[] = [];
    if (config.server.publicUrl) rawOrigins.push(config.server.publicUrl);
    const corsOrigin = config.cors.origin;
    if (typeof corsOrigin === 'string' && corsOrigin !== '*') rawOrigins.push(corsOrigin);
    else if (Array.isArray(corsOrigin)) rawOrigins.push(...corsOrigin.filter(o => typeof o === 'string' && o !== '*'));
    this.allowedOriginSet = new Set<string>();
    for (const raw of rawOrigins) {
      try { this.allowedOriginSet.add(new URL(raw).origin); } catch { /* 无效 URL 跳过 */ }
    }

    /* 初始化默认数据（幂等） */
    seedDefaultAddOns(db);
    this.billingService.seedBillingPlans();
  }

  listPlans() {
    return this.billingService.listPlans();
  }

  subscribeTenant(tenantId: string, planId: string) {
    return this.billingService.subscribeTenant(tenantId, planId);
  }

  listInvoices(tenantId: string) {
    return this.billingService.listInvoices(tenantId);
  }

  reconcileTenant(tenantId: string) {
    return this.settlementService.reconcileTenant(tenantId);
  }

  listReconciliationRuns(tenantId: string) {
    return this.settlementService.listRuns(tenantId);
  }

  listAddOns() {
    return listAddOns(this.db);
  }

  getUsage(tenantId: string) {
    const sub = this.webhookService.getLatestSubscription(tenantId);
    const planId = sub?.plan_id ?? 'free';
    const baseLimits = getPlanLimits(planId);
    const effectiveLimits = this.entitlementService.computeEffectiveLimits(tenantId);
    const activeAddOns = this.entitlementService.getActiveTenantAddOns(tenantId);
    const usage = this.usageTracker.getSummary(tenantId);

    return {
      planId,
      status: sub?.status ?? 'active',
      limits: baseLimits,
      effectiveLimits,
      addOns: activeAddOns,
      usage,
      periodEnd: sub?.current_period_end ? new Date(Number(sub.current_period_end)).toISOString() : undefined,
    };
  }

  getEntitlements(tenantId: string) {
    const limits = this.entitlementService.computeEffectiveLimits(tenantId);
    const addOns = this.entitlementService.getActiveTenantAddOns(tenantId);
    return { effectiveLimits: limits, activeAddOns: addOns };
  }

  get stripeEnabled(): boolean {
    return this.config.stripe.enabled;
  }

  async createCheckout(
    tenantId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string,
    options: { trialDays?: number } = {},
  ) {
    if (!VALID_PRICE_IDS.has(priceId)) {
      throw new ValidationError('无效的 priceId', ErrorCode.VALIDATION_FORMAT);
    }
    if (!isSafeRedirectUrl(successUrl, this.allowedOriginSet) || !isSafeRedirectUrl(cancelUrl, this.allowedOriginSet)) {
      throw new ValidationError('重定向 URL 必须为相对路径或同源地址', ErrorCode.VALIDATION_FORMAT);
    }

    const customerId = await ensureStripeCustomer(this.db, this.config, this.webhookService, tenantId);
    try {
      const session = await createCheckoutSession(this.config, customerId, priceId, successUrl, cancelUrl, {
        trialDays: options.trialDays,
        metadata: { tenantId },
      });
      return { sessionId: session.id, url: session.url };
    } catch (err) {
      throw new StateError(`支付会话创建失败: ${err instanceof Error ? err.message : String(err)}`, ErrorCode.STATE_INVALID_TRANSITION);
    }
  }

  /** admin 退款入口：通过 paymentIntent 或 charge 反向打款；webhook 仅同步状态 */
  async refundPayment(input: {
    paymentIntent?: string;
    charge?: string;
    amount?: number;
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  }) {
    if (!this.config.stripe.enabled) {
      throw new StateError('Stripe 未启用，无法退款', ErrorCode.STATE_INVALID_TRANSITION);
    }
    try {
      const refund = await refundPayment(this.config, input);
      return {
        refundId: refund.id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
      };
    } catch (err) {
      throw new StateError(
        `退款失败: ${err instanceof Error ? err.message : String(err)}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }
  }

  async createPortal(tenantId: string, returnUrl: string) {
    if (!isSafeRedirectUrl(returnUrl, this.allowedOriginSet)) {
      throw new ValidationError('重定向 URL 必须为相对路径或同源地址', ErrorCode.VALIDATION_FORMAT);
    }

    const customerId = await ensureStripeCustomer(this.db, this.config, this.webhookService, tenantId);
    try {
      const session = await createPortalSession(this.config, customerId, returnUrl);
      return { url: session.url };
    } catch (err) {
      throw new StateError(`客户门户创建失败: ${err instanceof Error ? err.message : String(err)}`, ErrorCode.STATE_INVALID_TRANSITION);
    }
  }

  processWebhookEvent(sig: string, rawBody: Buffer | string) {
    if (!sig) throw new ValidationError('缺少 Stripe 签名', ErrorCode.VALIDATION_REQUIRED);

    let event;
    try {
      event = constructWebhookEvent(this.config, rawBody, sig);
    } catch {
      throw new ValidationError('Webhook 签名验证失败', ErrorCode.VALIDATION_FORMAT);
    }

    const eventId = (event as { id?: string }).id;
    if (!eventId) throw new ValidationError('Webhook 事件缺少 id 字段', ErrorCode.VALIDATION_REQUIRED);

    return this.webhookService.processEvent(
      eventId,
      event.type,
      event.data.object as unknown as Record<string, unknown>,
    );
  }

  async createAddOn(data: { code: string; name: string; description?: string; stripePriceId?: string; resource: string; quotaAmount: number }) {
    if (!data.code || !data.name || !data.resource || typeof data.quotaAmount !== 'number') {
      throw new ValidationError('code/name/resource/quotaAmount 为必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const { createAddOn } = await import('./add-ons.js');
    return createAddOn(this.db, {
      code: data.code,
      name: data.name,
      description: data.description ?? '',
      stripePriceId: data.stripePriceId ?? '',
      resource: data.resource,
      quotaAmount: data.quotaAmount,
    });
  }

  async updateAddOn(id: string, data: Record<string, unknown>) {
    const existing = getAddOnById(this.db, id);
    if (!existing) throw new ValidationError('附加组件不存在', ErrorCode.VALIDATION_FORMAT);
    const { updateAddOn } = await import('./add-ons.js');
    updateAddOn(this.db, id, data);
    return { updated: true };
  }

  async deactivateAddOn(id: string) {
    const { deactivateAddOn } = await import('./add-ons.js');
    deactivateAddOn(this.db, id);
    return { deactivated: true };
  }

  purchaseAddOn(tenantId: string, addOnId: string) {
    const addon = getAddOnById(this.db, addOnId);
    if (!addon || !addon.isActive) {
      throw new ValidationError('附加组件不存在或已停用', ErrorCode.VALIDATION_FORMAT);
    }
    this.webhookService.purchaseAddOn(tenantId, addOnId);
    return { purchased: true, addOnId };
  }

}
