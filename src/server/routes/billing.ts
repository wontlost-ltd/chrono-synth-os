/**
 * 计费路由
 * GET  /api/v1/billing/plans   — 获取所有计划
 * POST /api/v1/billing/subscribe — 切换内部订阅计划
 * GET  /api/v1/billing/invoices — 获取发票与对账摘要
 * POST /api/v1/billing/reconciliation/run — 执行结算对账修复
 * GET  /api/v1/billing/reconciliation/runs — 获取最近对账运行记录
 * POST /api/v1/billing/checkout — 创建 Stripe Checkout Session
 * POST /api/v1/billing/portal  — 创建 Stripe 客户门户
 * GET  /api/v1/billing/usage   — 获取当前用量
 * POST /api/v1/billing/webhook — Stripe Webhook 回调
 */

import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import { BillingService } from '../../billing/billing-service.js';
import { SettlementReconciliationService } from '../../billing/settlement-reconciliation-service.js';
import { PLANS, getPlanLimits, syncPlanToQuota } from '../../billing/plans.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import {
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  createCustomer,
} from '../../billing/stripe-client.js';
import { listAddOns, getAddOnById, seedDefaultAddOns } from '../../billing/add-ons.js';
import { EntitlementService } from '../../billing/entitlement-service.js';
import { CheckoutSchema, PortalSchema, SubscribeBillingSchema } from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';
import { ValidationError, StateError, ErrorCode } from '../../errors/index.js';

interface SubscriptionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly plan_id: string;
  readonly status: string;
  readonly current_period_start: number;
  readonly current_period_end: number;
}

/** Stripe price ID → 内部 plan ID 映射 */
const PRICE_TO_PLAN = new Map(PLANS.filter(p => p.stripePriceId).map(p => [p.stripePriceId, p.id]));
const VALID_PRICE_IDS = new Set(PLANS.filter(p => p.stripePriceId).map(p => p.stripePriceId));

/** 校验 redirect URL：仅允许相对路径、同源地址或 CORS 允许的源 */
function isSafeRedirectUrl(url: string, allowedOriginSet: Set<string>): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  if (allowedOriginSet.size === 0) return false;
  try {
    return allowedOriginSet.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/** 懒创建 Stripe 客户：用于在 Stripe 启用前注册的用户。使用 inflight Map 防止并发重复创建 */
const inflightCustomerCreation = new Map<string, Promise<string>>();

async function ensureStripeCustomer(
  db: IDatabase, config: AppConfig, tenantId: string, sub: SubscriptionRow | undefined,
): Promise<string> {
  const inflight = inflightCustomerCreation.get(tenantId);
  if (inflight) return inflight;

  const promise = (async () => {
    const user = db.prepare<{ email: string }>('SELECT email FROM users WHERE tenant_id = ? LIMIT 1').get(tenantId);
    if (!user) throw new StateError('租户无关联用户', ErrorCode.STATE_INVALID_TRANSITION);
    const customer = await createCustomer(config, user.email, tenantId);
    if (sub) {
      db.prepare<void>('UPDATE subscriptions SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
        .run(customer.id, Date.now(), sub.id);
    }
    return customer.id;
  })();

  inflightCustomerCreation.set(tenantId, promise);
  try {
    return await promise;
  } finally {
    inflightCustomerCreation.delete(tenantId);
  }
}

export function registerBillingRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  const billingService = new BillingService(db);
  const settlementReconciliationService = new SettlementReconciliationService(db);
  const usageTracker = new UsageTracker(db);
  const entitlementService = new EntitlementService(db);

  /* 构建允许的重定向源集合：预解析 origin，避免每次请求重复 new URL() */
  const rawOrigins: string[] = [];
  if (config.server.publicUrl) rawOrigins.push(config.server.publicUrl);
  const corsOrigin = config.cors.origin;
  if (typeof corsOrigin === 'string' && corsOrigin !== '*') rawOrigins.push(corsOrigin);
  else if (Array.isArray(corsOrigin)) rawOrigins.push(...corsOrigin.filter(o => typeof o === 'string' && o !== '*'));
  const allowedOriginSet = new Set<string>();
  for (const raw of rawOrigins) {
    try { allowedOriginSet.add(new URL(raw).origin); } catch { /* 无效 URL 跳过 */ }
  }

  /* 初始化默认附加组件（幂等） */
  seedDefaultAddOns(db);
  billingService.seedBillingPlans();

  /* GET /api/v1/billing/plans — 所有可用计划 */
  app.get('/api/v1/billing/plans', async () => {
    return { data: billingService.listPlans() };
  });

  /* POST /api/v1/billing/subscribe — 本地/企业后台订阅切换 */
  app.post('/api/v1/billing/subscribe', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request) => {
    const { planId } = SubscribeBillingSchema.parse(request.body);
    const result = billingService.subscribeTenant(request.tenantId, planId);
    return { data: result };
  });

  /* GET /api/v1/billing/invoices — 当前租户发票与账本对账视图 */
  app.get('/api/v1/billing/invoices', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    return {
      data: billingService.listInvoices(request.tenantId),
    };
  });

  /* POST /api/v1/billing/reconciliation/run — 手动触发 tenant 级结算对账修复 */
  app.post('/api/v1/billing/reconciliation/run', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (request) => {
    return {
      data: settlementReconciliationService.reconcileTenant(request.tenantId),
    };
  });

  /* GET /api/v1/billing/reconciliation/runs — 最近对账运行记录 */
  app.get('/api/v1/billing/reconciliation/runs', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    return {
      data: settlementReconciliationService.listRuns(request.tenantId),
    };
  });

  /* GET /api/v1/billing/add-ons — 可购买的附加组件 */
  app.get('/api/v1/billing/add-ons', async () => {
    return { data: listAddOns(db) };
  });

  /* GET /api/v1/billing/usage — 当前租户用量（含附加组件权益） */
  app.get('/api/v1/billing/usage', async (request) => {
    const tenantId = request.tenantId;
    const sub = db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);

    const planId = sub?.plan_id ?? 'free';
    const baseLimits = getPlanLimits(planId);
    const effectiveLimits = entitlementService.computeEffectiveLimits(tenantId);
    const activeAddOns = entitlementService.getActiveTenantAddOns(tenantId);
    const usage = usageTracker.getSummary(tenantId);

    return {
      data: {
        planId,
        status: sub?.status ?? 'active',
        limits: baseLimits,
        effectiveLimits,
        addOns: activeAddOns,
        usage,
        periodEnd: sub?.current_period_end ? new Date(Number(sub.current_period_end)).toISOString() : undefined,
      },
    };
  });

  /* 以下路由需要 Stripe 启用 */
  if (!config.stripe.enabled) {
    const stripeDisabled = async () => {
      throw new StateError('Stripe 计费未启用，本地开发环境无需配置', ErrorCode.STATE_INVALID_TRANSITION);
    };
    app.post('/api/v1/billing/checkout', stripeDisabled);
    app.post('/api/v1/billing/portal', stripeDisabled);
    return;
  }

  /* POST /api/v1/billing/checkout — 创建 Checkout Session（限流: 5 次/分钟） */
  app.post('/api/v1/billing/checkout', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const { priceId, successUrl, cancelUrl } = CheckoutSchema.parse(request.body);

    if (!VALID_PRICE_IDS.has(priceId)) {
      throw new ValidationError('无效的 priceId', ErrorCode.VALIDATION_FORMAT);
    }

    if (!isSafeRedirectUrl(successUrl, allowedOriginSet) || !isSafeRedirectUrl(cancelUrl, allowedOriginSet)) {
      throw new ValidationError('重定向 URL 必须为相对路径或同源地址', ErrorCode.VALIDATION_FORMAT);
    }

    const tenantId = request.tenantId;
    const sub = db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);

    const customerId = sub?.stripe_customer_id ?? await ensureStripeCustomer(db, config, tenantId, sub);

    let session;
    try {
      session = await createCheckoutSession(config, customerId, priceId, successUrl, cancelUrl);
    } catch (err) {
      throw new StateError(`支付会话创建失败: ${err instanceof Error ? err.message : String(err)}`, ErrorCode.STATE_INVALID_TRANSITION);
    }
    return { data: { sessionId: session.id, url: session.url } };
  });

  /* POST /api/v1/billing/portal — 创建客户门户 */
  app.post('/api/v1/billing/portal', async (request) => {
    const { returnUrl } = PortalSchema.parse(request.body);

    if (!isSafeRedirectUrl(returnUrl, allowedOriginSet)) {
      throw new ValidationError('重定向 URL 必须为相对路径或同源地址', ErrorCode.VALIDATION_FORMAT);
    }

    const tenantId = request.tenantId;
    const sub = db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);

    const customerId = sub?.stripe_customer_id ?? await ensureStripeCustomer(db, config, tenantId, sub);

    let session;
    try {
      session = await createPortalSession(config, customerId, returnUrl);
    } catch (err) {
      throw new StateError(`客户门户创建失败: ${err instanceof Error ? err.message : String(err)}`, ErrorCode.STATE_INVALID_TRANSITION);
    }
    return { data: { url: session.url } };
  });

  /* POST /api/v1/billing/webhook — Stripe Webhook 回调 */
  app.post('/api/v1/billing/webhook', {
    preParsing: async (request, _reply, payload) => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks);
      (request as { rawBody?: Buffer }).rawBody = rawBody;
      return Readable.from(rawBody);
    },
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature'] as string | undefined;
    if (!sig) {
      throw new ValidationError('缺少 Stripe 签名', ErrorCode.VALIDATION_REQUIRED);
    }

    let event;
    try {
      const body = (request as { rawBody?: Buffer }).rawBody ?? JSON.stringify(request.body);
      event = constructWebhookEvent(config, body, sig);
    } catch {
      throw new ValidationError('Webhook 签名验证失败', ErrorCode.VALIDATION_FORMAT);
    }

    const now = Date.now();
    const eventId = (event as { id?: string }).id;
    if (!eventId) {
      throw new ValidationError('Webhook 事件缺少 id 字段', ErrorCode.VALIDATION_REQUIRED);
    }
    let duplicate = false;

    try {
      db.transaction(() => {
        /* 幂等性：事件去重与处理在同一事务内 */
        const inserted = db.prepare<void>(
          'INSERT INTO webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING',
        ).run(eventId, event.type, now);
        if (inserted.changes === 0) {
          duplicate = true;
          return;
        }

        switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated': {
            const subscription = event.data.object as unknown as Record<string, unknown>;
            const customerId = typeof subscription.customer === 'string'
              ? subscription.customer
              : (subscription.customer as { id: string })?.id ?? '';
            const tenantSub = db.prepare<SubscriptionRow>(
              'SELECT * FROM subscriptions WHERE stripe_customer_id = ?',
            ).get(customerId);
            if (tenantSub) {
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

              db.prepare<void>(
                `UPDATE subscriptions SET stripe_subscription_id = ?, status = ?, plan_id = ?, current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?`,
              ).run(
                subscription.id as string,
                status,
                resolvedPlanId,
                periodStart,
                periodEnd,
                now,
                tenantSub.id,
              );

              /* 计划变更时同步配额限制与权益 */
              if (resolvedPlanId !== tenantSub.plan_id) {
                syncPlanToQuota(db, tenantSub.tenant_id, resolvedPlanId);
                entitlementService.syncTenantEntitlements(tenantSub.tenant_id);
              }
            }
            break;
          }
          case 'customer.subscription.deleted': {
            const subscription = event.data.object as unknown as Record<string, unknown>;
            const customerId = typeof subscription.customer === 'string'
              ? subscription.customer
              : (subscription.customer as { id: string })?.id ?? '';
            const canceledSub = db.prepare<SubscriptionRow>(
              'SELECT * FROM subscriptions WHERE stripe_customer_id = ?',
            ).get(customerId);
            db.prepare<void>(
              `UPDATE subscriptions SET status = 'canceled', plan_id = 'free', updated_at = ? WHERE stripe_customer_id = ?`,
            ).run(now, customerId);
            if (canceledSub) {
              syncPlanToQuota(db, canceledSub.tenant_id, 'free');
              /* 取消订阅时取消所有附加组件并重新同步权益 */
              db.prepare<void>(
                `UPDATE tenant_add_ons SET status = 'canceled', canceled_at = ? WHERE tenant_id = ? AND status = 'active'`,
              ).run(Date.now(), canceledSub.tenant_id);
              entitlementService.syncTenantEntitlements(canceledSub.tenant_id);
            }
            break;
          }
        }
      });
    } catch (err) {
      app.log.error({ err }, 'Stripe webhook 处理失败');
      throw err;
    }

    if (duplicate) {
      return reply.status(200).send({ received: true, duplicate: true });
    }

    return reply.status(200).send({ received: true });
  });

  /* ── 附加组件管理路由（admin） ── */

  /* POST /api/v1/billing/add-ons — 创建附加组件 */
  app.post('/api/v1/billing/add-ons', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const { code, name, description, stripePriceId, resource, quotaAmount } = request.body as {
      code: string; name: string; description?: string; stripePriceId?: string;
      resource: string; quotaAmount: number;
    };
    if (!code || !name || !resource || typeof quotaAmount !== 'number') {
      throw new ValidationError('code/name/resource/quotaAmount 为必填', ErrorCode.VALIDATION_REQUIRED);
    }
    const { createAddOn } = await import('../../billing/add-ons.js');
    const addon = createAddOn(db, { code, name, description: description ?? '', stripePriceId: stripePriceId ?? '', resource, quotaAmount });
    return { data: addon };
  });

  /* PATCH /api/v1/billing/add-ons/:id — 更新附加组件 */
  app.patch('/api/v1/billing/add-ons/:id', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = getAddOnById(db, id);
    if (!existing) throw new ValidationError('附加组件不存在', ErrorCode.VALIDATION_FORMAT);
    const { updateAddOn } = await import('../../billing/add-ons.js');
    updateAddOn(db, id, request.body as Record<string, unknown>);
    return { data: { updated: true } };
  });

  /* DELETE /api/v1/billing/add-ons/:id — 停用附加组件 */
  app.delete('/api/v1/billing/add-ons/:id', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { deactivateAddOn } = await import('../../billing/add-ons.js');
    deactivateAddOn(db, id);
    return { data: { deactivated: true } };
  });

  /* POST /api/v1/billing/add-ons/:id/purchase — 租户购买附加组件 */
  app.post('/api/v1/billing/add-ons/:id/purchase', async (request) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId;
    const addon = getAddOnById(db, id);
    if (!addon || !addon.isActive) {
      throw new ValidationError('附加组件不存在或已停用', ErrorCode.VALIDATION_FORMAT);
    }
    const { randomUUID } = await import('node:crypto');
    const now = Date.now();
    db.prepare<void>(
      `INSERT INTO tenant_add_ons (id, tenant_id, add_on_id, status, purchased_at) VALUES (?, ?, ?, 'active', ?)`,
    ).run(`ta_${randomUUID()}`, tenantId, id, now);
    entitlementService.syncTenantEntitlements(tenantId);
    return { data: { purchased: true, addOnId: id } };
  });

  /* GET /api/v1/billing/entitlements — 租户有效权益 */
  app.get('/api/v1/billing/entitlements', async (request) => {
    const tenantId = request.tenantId;
    const limits = entitlementService.computeEffectiveLimits(tenantId);
    const addOns = entitlementService.getActiveTenantAddOns(tenantId);
    return { data: { effectiveLimits: limits, activeAddOns: addOns } };
  });
}
