/**
 * 计费路由
 * 路由层只做请求解析和响应序列化，业务逻辑委托 BillingRouteFacade
 */

import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import { BillingRouteFacade } from '../../billing/billing-route-facade.js';
import { CheckoutSchema, PortalSchema, SubscribeBillingSchema } from '../schemas/api-schemas.js';
import { requireRole } from '../plugins/rbac.js';
import { StateError, ErrorCode } from '../../errors/index.js';

export function registerBillingRoutes(app: FastifyInstance, db: IDatabase, config: AppConfig): void {
  const facade = new BillingRouteFacade(db, config);

  /* GET /api/v1/billing/plans — 所有可用计划 */
  app.get('/api/v1/billing/plans', async () => {
    return { data: facade.listPlans() };
  });

  /* POST /api/v1/billing/subscribe — 本地/企业后台订阅切换 */
  app.post('/api/v1/billing/subscribe', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request) => {
    const { planId } = SubscribeBillingSchema.parse(request.body);
    return { data: facade.subscribeTenant(request.tenantId, planId) };
  });

  /* GET /api/v1/billing/invoices — 当前租户发票与账本对账视图 */
  app.get('/api/v1/billing/invoices', { preHandler: requireRole('admin') }, async (request) => {
    return { data: facade.listInvoices(request.tenantId) };
  });

  /* POST /api/v1/billing/reconciliation/run — 手动触发 tenant 级结算对账修复 */
  app.post('/api/v1/billing/reconciliation/run', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (request) => {
    return { data: facade.reconcileTenant(request.tenantId) };
  });

  /* GET /api/v1/billing/reconciliation/runs — 最近对账运行记录 */
  app.get('/api/v1/billing/reconciliation/runs', { preHandler: requireRole('admin') }, async (request) => {
    return { data: facade.listReconciliationRuns(request.tenantId) };
  });

  /* GET /api/v1/billing/add-ons — 可购买的附加组件 */
  app.get('/api/v1/billing/add-ons', async () => {
    return { data: facade.listAddOns() };
  });

  /* GET /api/v1/billing/usage — 当前租户用量（含附加组件权益） */
  app.get('/api/v1/billing/usage', async (request) => {
    return { data: facade.getUsage(request.tenantId) };
  });

  /* 以下路由需要 Stripe 启用 */
  if (!facade.stripeEnabled) {
    const stripeDisabled = async () => {
      throw new StateError('Stripe 计费未启用，本地开发环境无需配置', ErrorCode.STATE_INVALID_TRANSITION);
    };
    app.post('/api/v1/billing/checkout', stripeDisabled);
    app.post('/api/v1/billing/portal', stripeDisabled);
    return;
  }

  /* POST /api/v1/billing/checkout — 创建 Checkout Session */
  app.post('/api/v1/billing/checkout', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const { priceId, successUrl, cancelUrl } = CheckoutSchema.parse(request.body);
    return { data: await facade.createCheckout(request.tenantId, priceId, successUrl, cancelUrl) };
  });

  /* POST /api/v1/billing/portal — 创建客户门户 */
  app.post('/api/v1/billing/portal', async (request) => {
    const { returnUrl } = PortalSchema.parse(request.body);
    return { data: await facade.createPortal(request.tenantId, returnUrl) };
  });

  /* POST /api/v1/billing/webhook — Stripe Webhook 回调 */
  app.post('/api/v1/billing/webhook', {
    preParsing: async (request, _reply, payload) => {
      const { Readable } = await import('node:stream');
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
    const body = (request as { rawBody?: Buffer }).rawBody ?? JSON.stringify(request.body);
    try {
      const result = facade.processWebhookEvent(sig!, body);
      return reply.status(200).send(result);
    } catch (err) {
      app.log.error({ err }, 'Stripe webhook 处理失败');
      throw err;
    }
  });

  /* ── 附加组件管理路由（admin） ── */

  app.post('/api/v1/billing/add-ons', { preHandler: requireRole('admin') }, async (request) => {
    const data = request.body as {
      code: string; name: string; description?: string; stripePriceId?: string;
      resource: string; quotaAmount: number;
    };
    return { data: await facade.createAddOn(data) };
  });

  app.patch('/api/v1/billing/add-ons/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    return { data: await facade.updateAddOn(id, request.body as Record<string, unknown>) };
  });

  app.delete('/api/v1/billing/add-ons/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    return { data: await facade.deactivateAddOn(id) };
  });

  app.post('/api/v1/billing/add-ons/:id/purchase', async (request) => {
    const { id } = request.params as { id: string };
    return { data: facade.purchaseAddOn(request.tenantId, id) };
  });

  /* GET /api/v1/billing/entitlements — 租户有效权益 */
  app.get('/api/v1/billing/entitlements', async (request) => {
    return { data: facade.getEntitlements(request.tenantId) };
  });
}
