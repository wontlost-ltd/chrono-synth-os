/**
 * 计费路由
 * GET  /api/v1/billing/plans   — 获取所有计划
 * POST /api/v1/billing/checkout — 创建 Stripe Checkout Session
 * POST /api/v1/billing/portal  — 创建 Stripe 客户门户
 * GET  /api/v1/billing/usage   — 获取当前用量
 * POST /api/v1/billing/webhook — Stripe Webhook 回调
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import { PLANS, getPlanLimits } from '../../billing/plans.js';
import { UsageTracker } from '../../billing/usage-tracker.js';
import {
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
} from '../../billing/stripe-client.js';
import { CheckoutSchema, PortalSchema } from '../schemas/api-schemas.js';

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

/** 校验 redirect URL：仅允许相对路径或同源地址 */
function isSafeRedirectUrl(url: string, publicUrl?: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  if (!publicUrl) return false;
  try {
    const parsed = new URL(url);
    const base = new URL(publicUrl);
    return parsed.origin === base.origin;
  } catch {
    return false;
  }
}

export function registerBillingRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  const usageTracker = new UsageTracker(db);

  /* GET /api/v1/billing/plans — 所有可用计划 */
  app.get('/api/v1/billing/plans', async () => {
    return { data: PLANS.map(p => ({ id: p.id, name: p.name, limits: p.limits })) };
  });

  /* GET /api/v1/billing/usage — 当前租户用量 */
  app.get('/api/v1/billing/usage', async (request) => {
    const tenantId = (request as { tenantId?: string }).tenantId ?? 'default';
    const sub = db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);

    const planId = sub?.plan_id ?? 'free';
    const limits = getPlanLimits(planId);
    const usage = usageTracker.getSummary(tenantId);

    return {
      data: {
        planId,
        status: sub?.status ?? 'active',
        limits,
        usage,
        periodEnd: sub?.current_period_end,
      },
    };
  });

  /* 以下路由需要 Stripe 启用 */
  if (!config.stripe.enabled) return;

  /* POST /api/v1/billing/checkout — 创建 Checkout Session */
  app.post('/api/v1/billing/checkout', async (request, reply) => {
    const { priceId, successUrl, cancelUrl } = CheckoutSchema.parse(request.body);

    if (!VALID_PRICE_IDS.has(priceId)) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_INVALID_PLAN',
        message: '无效的 priceId',
      });
    }

    if (!isSafeRedirectUrl(successUrl, config.server.publicUrl) || !isSafeRedirectUrl(cancelUrl, config.server.publicUrl)) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_INVALID_URL',
        message: '重定向 URL 必须为相对路径或同源地址',
      });
    }

    const tenantId = (request as { tenantId?: string }).tenantId ?? 'default';
    const sub = db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);

    if (!sub?.stripe_customer_id) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_REQUIRED',
        message: '尚未关联 Stripe 客户，请先完成注册',
      });
    }

    const session = await createCheckoutSession(config, sub.stripe_customer_id, priceId, successUrl, cancelUrl);
    return { data: { sessionId: session.id, url: session.url } };
  });

  /* POST /api/v1/billing/portal — 创建客户门户 */
  app.post('/api/v1/billing/portal', async (request, reply) => {
    const { returnUrl } = PortalSchema.parse(request.body);

    if (!isSafeRedirectUrl(returnUrl, config.server.publicUrl)) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_INVALID_URL',
        message: '重定向 URL 必须为相对路径或同源地址',
      });
    }

    const tenantId = (request as { tenantId?: string }).tenantId ?? 'default';
    const sub = db.prepare<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);

    if (!sub?.stripe_customer_id) {
      return reply.status(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_REQUIRED',
        message: '尚未关联 Stripe 客户',
      });
    }

    const session = await createPortalSession(config, sub.stripe_customer_id, returnUrl);
    return { data: { url: session.url } };
  });

  /* POST /api/v1/billing/webhook — Stripe Webhook 回调 */
  app.post('/api/v1/billing/webhook', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature'] as string | undefined;
    if (!sig) {
      return reply.status(400).send({ error: '缺少 Stripe 签名' });
    }

    let event;
    try {
      const body = (request as { rawBody?: string | Buffer }).rawBody ?? JSON.stringify(request.body);
      event = constructWebhookEvent(config, body, sig);
    } catch {
      return reply.status(400).send({ error: 'Webhook 签名验证失败' });
    }

    const now = Date.now();
    const eventId = (event as { id?: string }).id;
    let duplicate = false;

    try {
      db.transaction(() => {
        /* 幂等性：事件去重与处理在同一事务内 */
        if (eventId) {
          const inserted = db.prepare<void>(
            'INSERT OR IGNORE INTO webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?)',
          ).run(eventId, event.type, now);
          if (inserted.changes === 0) {
            duplicate = true;
            return;
          }
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
            }
            break;
          }
          case 'customer.subscription.deleted': {
            const subscription = event.data.object as unknown as Record<string, unknown>;
            const customerId = typeof subscription.customer === 'string'
              ? subscription.customer
              : (subscription.customer as { id: string })?.id ?? '';
            db.prepare<void>(
              `UPDATE subscriptions SET status = 'canceled', plan_id = 'free', updated_at = ? WHERE stripe_customer_id = ?`,
            ).run(now, customerId);
            break;
          }
        }
      });
    } catch (err) {
      app.log.error({ err }, 'Stripe webhook 处理失败');
      return reply.status(500).send({ error: 'Webhook 处理失败' });
    }

    if (duplicate) {
      return reply.status(200).send({ received: true, duplicate: true });
    }

    return reply.status(200).send({ received: true });
  });
}
