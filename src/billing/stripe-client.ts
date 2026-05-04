/**
 * Stripe SDK 封装
 * 提供订阅管理、结账、客户管理和 Webhook 验证
 */

import Stripe from 'stripe';
import type { AppConfig } from '../config/schema.js';

let stripeInstance: Stripe | null = null;

/** 获取 Stripe 实例（惰性初始化） */
export function getStripe(config: AppConfig): Stripe {
  if (!stripeInstance) {
    if (!config.stripe.secretKey) {
      throw new Error('Stripe secretKey 未配置');
    }
    stripeInstance = new Stripe(config.stripe.secretKey, {
      apiVersion: '2025-01-27.acacia' as Stripe.LatestApiVersion,
    });
  }
  return stripeInstance;
}

/** 创建 Stripe 客户 */
export async function createCustomer(
  config: AppConfig,
  email: string,
  tenantId: string,
): Promise<Stripe.Customer> {
  const stripe = getStripe(config);
  return stripe.customers.create({
    email,
    metadata: { tenantId },
  });
}

/** 创建 Checkout Session（将用户引导到 Stripe 支付页面） */
export async function createCheckoutSession(
  config: AppConfig,
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
  options: { trialDays?: number; metadata?: Record<string, string> } = {},
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe(config);
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  if (options.trialDays && options.trialDays > 0) {
    sessionParams.subscription_data = {
      trial_period_days: Math.min(options.trialDays, 90), /* Stripe 上限 90 天 */
    };
  }
  if (options.metadata) {
    sessionParams.subscription_data = {
      ...sessionParams.subscription_data,
      metadata: options.metadata,
    };
  }
  return stripe.checkout.sessions.create(sessionParams);
}

/** 退款（admin 用，按 payment_intent 或 invoice 反向打款） */
export async function refundPayment(
  config: AppConfig,
  options: { paymentIntent?: string; charge?: string; amount?: number; reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer' },
): Promise<Stripe.Refund> {
  const stripe = getStripe(config);
  if (!options.paymentIntent && !options.charge) {
    throw new Error('refundPayment 需要 paymentIntent 或 charge 任一');
  }
  return stripe.refunds.create({
    payment_intent: options.paymentIntent,
    charge: options.charge,
    amount: options.amount,
    reason: options.reason ?? 'requested_by_customer',
  });
}

/** 创建客户门户 Session（用户自助管理订阅） */
export async function createPortalSession(
  config: AppConfig,
  customerId: string,
  returnUrl: string,
): Promise<Stripe.BillingPortal.Session> {
  const stripe = getStripe(config);
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

/** 取消订阅 */
export async function cancelSubscription(
  config: AppConfig,
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  const stripe = getStripe(config);
  return stripe.subscriptions.cancel(subscriptionId);
}

/** 验证 Webhook 签名并解析事件 */
export function constructWebhookEvent(
  config: AppConfig,
  payload: string | Buffer,
  signature: string,
): Stripe.Event {
  const stripe = getStripe(config);
  return stripe.webhooks.constructEvent(payload, signature, config.stripe.webhookSecret);
}

/** 上报计量用量（如 LLM token），使用 Billing Meter Event */
export async function reportUsage(
  config: AppConfig,
  customerId: string,
  eventName: string,
  quantity: number,
  idempotencyKey?: string,
): Promise<void> {
  const stripe = getStripe(config);
  const params = {
    event_name: eventName,
    payload: {
      stripe_customer_id: customerId,
      value: String(quantity),
    },
  };
  if (idempotencyKey) {
    await stripe.billing.meterEvents.create(params, { idempotencyKey });
  } else {
    await stripe.billing.meterEvents.create(params);
  }
}
