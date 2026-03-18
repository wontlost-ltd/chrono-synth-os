/**
 * BillingService Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const BSVC_QUERY_LIST_PLANS = 'billingSvc.listPlans' as const;
export const BSVC_QUERY_LATEST_SUB = 'billingSvc.latestSub' as const;
export const BSVC_QUERY_RECONCILIATION = 'billingSvc.reconciliation' as const;
export const BSVC_QUERY_INVOICE_BY_PERIOD = 'billingSvc.invoiceByPeriod' as const;
export const BSVC_QUERY_INVOICE_BY_ID = 'billingSvc.invoiceById' as const;
export const BSVC_QUERY_INVOICES_BY_TENANT = 'billingSvc.invoicesByTenant' as const;
export const BSVC_QUERY_USAGE_METERS = 'billingSvc.usageMeters' as const;
export const BSVC_QUERY_USAGE_RECORDS_SUMMARY = 'billingSvc.usageRecordsSummary' as const;

/* ── Command Kinds ── */

export const BSVC_CMD_SEED_PLAN = 'billingSvc.seedPlan' as const;
export const BSVC_CMD_UPDATE_SUB = 'billingSvc.updateSub' as const;
export const BSVC_CMD_INSERT_SUB = 'billingSvc.insertSub' as const;
export const BSVC_CMD_UPDATE_INVOICE = 'billingSvc.updateInvoice' as const;
export const BSVC_CMD_INSERT_INVOICE = 'billingSvc.insertInvoice' as const;
export const BSVC_CMD_DELETE_USAGE_METERS = 'billingSvc.deleteUsageMeters' as const;
export const BSVC_CMD_INSERT_USAGE_METER = 'billingSvc.insertUsageMeter' as const;

/* ── 行类型 ── */

export interface BillingPlanRow {
  id: string;
  name: string;
  stripe_price_id: string;
  price_minor: number;
  currency: string;
  billing_interval: string;
  limits_json: string;
}

export interface BsvcSubscriptionRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  created_at: number;
  updated_at: number;
}

export interface BsvcInvoiceRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  plan_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  billing_interval: string;
  period_start: number;
  period_end: number;
  wallet_settlement_count: number;
  wallet_settlement_total_minor: number;
  reconciliation_status: string;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
}

export interface BsvcUsageMeterRow {
  resource: string;
  total_quantity: number;
}

export interface BsvcReconciliationRow {
  wallet_settlement_count: number;
  wallet_settlement_total_minor: number;
}

/* ── 参数类型 ── */

export interface BsvcSeedPlanParams {
  id: string;
  name: string;
  stripePriceId: string;
  priceMinor: number;
  currency: string;
  billingInterval: string;
  limitsJson: string;
  now: number;
}

export interface BsvcUpdateSubParams {
  id: string;
  planId: string;
  periodStart: number;
  periodEnd: number;
  now: number;
}

export interface BsvcInsertSubParams {
  id: string;
  tenantId: string;
  planId: string;
  periodStart: number;
  periodEnd: number;
  now: number;
}

export interface BsvcReconciliationParams {
  tenantId: string;
  periodStart: number;
  periodEnd: number;
}

export interface BsvcInvoiceByPeriodParams {
  tenantId: string;
  subscriptionId: string;
  periodStart: number;
}

export interface BsvcUpdateInvoiceParams {
  id: string;
  planId: string;
  status: string;
  amountMinor: number;
  currency: string;
  billingInterval: string;
  periodEnd: number;
  walletSettlementCount: number;
  walletSettlementTotalMinor: number;
  now: number;
  paidAt: number | null;
}

export interface BsvcInsertInvoiceParams {
  id: string;
  tenantId: string;
  subscriptionId: string;
  planId: string;
  status: string;
  amountMinor: number;
  currency: string;
  billingInterval: string;
  periodStart: number;
  periodEnd: number;
  walletSettlementCount: number;
  walletSettlementTotalMinor: number;
  now: number;
  paidAt: number | null;
}

export interface BsvcDeleteUsageMetersParams {
  tenantId: string;
  periodStart: number;
  periodEnd: number;
}

export interface BsvcInsertUsageMeterParams {
  id: string;
  tenantId: string;
  resource: string;
  periodStart: number;
  periodEnd: number;
  totalQuantity: number;
  now: number;
}

export interface BsvcUsageMetersParams {
  tenantId: string;
  periodStart: number;
  periodEnd: number;
}

/* ── Query 工厂 ── */

export function bsvcQueryListPlans(): Query<BillingPlanRow, void> {
  return { kind: BSVC_QUERY_LIST_PLANS, params: undefined as unknown as void };
}

export function bsvcQueryLatestSub(tenantId: string): Query<BsvcSubscriptionRow | null, string> {
  return { kind: BSVC_QUERY_LATEST_SUB, params: tenantId };
}

export function bsvcQueryReconciliation(params: BsvcReconciliationParams): Query<BsvcReconciliationRow | null, BsvcReconciliationParams> {
  return { kind: BSVC_QUERY_RECONCILIATION, params };
}

export function bsvcQueryInvoiceByPeriod(params: BsvcInvoiceByPeriodParams): Query<BsvcInvoiceRow | null, BsvcInvoiceByPeriodParams> {
  return { kind: BSVC_QUERY_INVOICE_BY_PERIOD, params };
}

export function bsvcQueryInvoiceById(id: string): Query<BsvcInvoiceRow | null, string> {
  return { kind: BSVC_QUERY_INVOICE_BY_ID, params: id };
}

export function bsvcQueryInvoicesByTenant(tenantId: string): Query<BsvcInvoiceRow, string> {
  return { kind: BSVC_QUERY_INVOICES_BY_TENANT, params: tenantId };
}

export function bsvcQueryUsageMeters(params: BsvcUsageMetersParams): Query<BsvcUsageMeterRow, BsvcUsageMetersParams> {
  return { kind: BSVC_QUERY_USAGE_METERS, params };
}

export function bsvcQueryUsageRecordsSummary(params: BsvcReconciliationParams): Query<BsvcUsageMeterRow, BsvcReconciliationParams> {
  return { kind: BSVC_QUERY_USAGE_RECORDS_SUMMARY, params };
}

/* ── Command 工厂 ── */

export function bsvcCmdSeedPlan(params: BsvcSeedPlanParams): Command<BsvcSeedPlanParams> {
  return { kind: BSVC_CMD_SEED_PLAN, params };
}

export function bsvcCmdUpdateSub(params: BsvcUpdateSubParams): Command<BsvcUpdateSubParams> {
  return { kind: BSVC_CMD_UPDATE_SUB, params };
}

export function bsvcCmdInsertSub(params: BsvcInsertSubParams): Command<BsvcInsertSubParams> {
  return { kind: BSVC_CMD_INSERT_SUB, params };
}

export function bsvcCmdUpdateInvoice(params: BsvcUpdateInvoiceParams): Command<BsvcUpdateInvoiceParams> {
  return { kind: BSVC_CMD_UPDATE_INVOICE, params };
}

export function bsvcCmdInsertInvoice(params: BsvcInsertInvoiceParams): Command<BsvcInsertInvoiceParams> {
  return { kind: BSVC_CMD_INSERT_INVOICE, params };
}

export function bsvcCmdDeleteUsageMeters(params: BsvcDeleteUsageMetersParams): Command<BsvcDeleteUsageMetersParams> {
  return { kind: BSVC_CMD_DELETE_USAGE_METERS, params };
}

export function bsvcCmdInsertUsageMeter(params: BsvcInsertUsageMeterParams): Command<BsvcInsertUsageMeterParams> {
  return { kind: BSVC_CMD_INSERT_USAGE_METER, params };
}
