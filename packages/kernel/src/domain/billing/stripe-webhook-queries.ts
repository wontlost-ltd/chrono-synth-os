/**
 * Stripe Webhook Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const SWHS_QUERY_LATEST_SUBSCRIPTION = 'stripeWebhook.latestSubscription' as const;
export const SWHS_QUERY_SUB_BY_STRIPE_CUSTOMER = 'stripeWebhook.subByStripeCustomer' as const;

/* ── Command Kinds ── */

export const SWHS_CMD_RECORD_EVENT = 'stripeWebhook.recordEvent' as const;
export const SWHS_CMD_PERSIST_STRIPE_CUSTOMER = 'stripeWebhook.persistStripeCustomer' as const;
export const SWHS_CMD_PURCHASE_ADDON = 'stripeWebhook.purchaseAddon' as const;
export const SWHS_CMD_UPDATE_SUBSCRIPTION = 'stripeWebhook.updateSubscription' as const;
export const SWHS_CMD_CANCEL_BY_CUSTOMER = 'stripeWebhook.cancelByCustomer' as const;
export const SWHS_CMD_CANCEL_TENANT_ADDONS = 'stripeWebhook.cancelTenantAddons' as const;
export const SWHS_CMD_FINALIZE_TRIAL_PERIOD = 'stripeWebhook.finalizeTrialPeriod' as const;
export const SWHS_CMD_REVIVE_INVOICE_PAID = 'stripeWebhook.reviveInvoicePaid' as const;
export const SWHS_CMD_MARK_PAST_DUE = 'stripeWebhook.markPastDue' as const;

/* ── 行类型 ── */

export interface SwhsSubscriptionRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly plan_id: string;
  readonly status: string;
  readonly current_period_end: number | null;
}

/* ── 参数类型 ── */

export interface SwhsRecordEventParams {
  eventId: string;
  eventType: string;
  now: number;
}

export interface SwhsPersistStripeCustomerParams {
  stripeCustomerId: string;
  subscriptionId: string;
  now: number;
}

export interface SwhsPurchaseAddonParams {
  id: string;
  tenantId: string;
  addOnId: string;
  now: number;
}

export interface SwhsUpdateSubscriptionParams {
  subscriptionRowId: string;
  stripeSubscriptionId: string;
  status: string;
  planId: string;
  periodStart: number;
  periodEnd: number;
  now: number;
}

export interface SwhsCancelByCustomerParams {
  stripeCustomerId: string;
  now: number;
}

export interface SwhsCancelTenantAddonsParams {
  tenantId: string;
  now: number;
}

export interface SwhsFinalizeTrialPeriodParams {
  subscriptionRowId: string;
  trialEnd: number | null;
  cancelAtPeriodEnd: number;
  now: number;
}

export interface SwhsReviveInvoicePaidParams {
  subscriptionRowId: string;
  invoiceId: string | null;
  now: number;
}

export interface SwhsMarkPastDueParams {
  subscriptionRowId: string;
  graceEndsAt: number;
  invoiceId: string | null;
  now: number;
}

/* ── Query 工厂 ── */

export function swhsQueryLatestSubscription(tenantId: string): Query<SwhsSubscriptionRow | null, string> {
  return { kind: SWHS_QUERY_LATEST_SUBSCRIPTION, params: tenantId };
}

export function swhsQuerySubByStripeCustomer(customerId: string): Query<SwhsSubscriptionRow | null, string> {
  return { kind: SWHS_QUERY_SUB_BY_STRIPE_CUSTOMER, params: customerId };
}

/* ── Command 工厂 ── */

export function swhsCmdRecordEvent(params: SwhsRecordEventParams): Command<SwhsRecordEventParams> {
  return { kind: SWHS_CMD_RECORD_EVENT, params };
}

export function swhsCmdPersistStripeCustomer(params: SwhsPersistStripeCustomerParams): Command<SwhsPersistStripeCustomerParams> {
  return { kind: SWHS_CMD_PERSIST_STRIPE_CUSTOMER, params };
}

export function swhsCmdPurchaseAddon(params: SwhsPurchaseAddonParams): Command<SwhsPurchaseAddonParams> {
  return { kind: SWHS_CMD_PURCHASE_ADDON, params };
}

export function swhsCmdUpdateSubscription(params: SwhsUpdateSubscriptionParams): Command<SwhsUpdateSubscriptionParams> {
  return { kind: SWHS_CMD_UPDATE_SUBSCRIPTION, params };
}

export function swhsCmdCancelByCustomer(params: SwhsCancelByCustomerParams): Command<SwhsCancelByCustomerParams> {
  return { kind: SWHS_CMD_CANCEL_BY_CUSTOMER, params };
}

export function swhsCmdCancelTenantAddons(params: SwhsCancelTenantAddonsParams): Command<SwhsCancelTenantAddonsParams> {
  return { kind: SWHS_CMD_CANCEL_TENANT_ADDONS, params };
}

export function swhsCmdFinalizeTrialPeriod(params: SwhsFinalizeTrialPeriodParams): Command<SwhsFinalizeTrialPeriodParams> {
  return { kind: SWHS_CMD_FINALIZE_TRIAL_PERIOD, params };
}

export function swhsCmdReviveInvoicePaid(params: SwhsReviveInvoicePaidParams): Command<SwhsReviveInvoicePaidParams> {
  return { kind: SWHS_CMD_REVIVE_INVOICE_PAID, params };
}

export function swhsCmdMarkPastDue(params: SwhsMarkPastDueParams): Command<SwhsMarkPastDueParams> {
  return { kind: SWHS_CMD_MARK_PAST_DUE, params };
}
