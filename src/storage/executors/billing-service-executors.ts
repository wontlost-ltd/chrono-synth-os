/**
 * BillingService SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  BillingPlanRow, BsvcSubscriptionRow, BsvcInvoiceRow,
  BsvcUsageMeterRow, BsvcReconciliationRow,
  BsvcSeedPlanParams, BsvcUpdateSubParams, BsvcInsertSubParams,
  BsvcReconciliationParams, BsvcInvoiceByPeriodParams,
  BsvcUpdateInvoiceParams, BsvcInsertInvoiceParams,
  BsvcDeleteUsageMetersParams, BsvcInsertUsageMeterParams,
  BsvcUsageMetersParams,
} from '@chrono/kernel';
import {
  BSVC_QUERY_LIST_PLANS, BSVC_QUERY_LATEST_SUB, BSVC_QUERY_RECONCILIATION,
  BSVC_QUERY_INVOICE_BY_PERIOD, BSVC_QUERY_INVOICE_BY_ID, BSVC_QUERY_INVOICES_BY_TENANT,
  BSVC_QUERY_USAGE_METERS, BSVC_QUERY_USAGE_RECORDS_SUMMARY,
  BSVC_CMD_SEED_PLAN, BSVC_CMD_UPDATE_SUB, BSVC_CMD_INSERT_SUB,
  BSVC_CMD_UPDATE_INVOICE, BSVC_CMD_INSERT_INVOICE,
  BSVC_CMD_DELETE_USAGE_METERS, BSVC_CMD_INSERT_USAGE_METER,
} from '@chrono/kernel';

export function registerBillingServiceExecutors(): void {
  /* ── Queries ── */

  registerQuery<BillingPlanRow[], void>(BSVC_QUERY_LIST_PLANS, (db) => {
    return db.prepare<BillingPlanRow>(
      `SELECT id, name, stripe_price_id, price_minor, currency, billing_interval, limits_json
       FROM billing_plans
       WHERE is_active = 1
       ORDER BY CASE id WHEN 'free' THEN 0 WHEN 'pro' THEN 1 ELSE 2 END ASC, name ASC`,
    ).all();
  });

  registerQuery<BsvcSubscriptionRow | null, string>(BSVC_QUERY_LATEST_SUB, (db, tenantId) => {
    return db.prepare<BsvcSubscriptionRow>(
      `SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC, updated_at DESC LIMIT 1`,
    ).get(tenantId) ?? null;
  });

  registerQuery<BsvcReconciliationRow | null, BsvcReconciliationParams>(BSVC_QUERY_RECONCILIATION, (db, p) => {
    return db.prepare<BsvcReconciliationRow>(
      `SELECT COUNT(*) AS wallet_settlement_count, COALESCE(SUM(total_amount_minor), 0) AS wallet_settlement_total_minor
       FROM wallet_settlements WHERE tenant_id = ? AND created_at >= ? AND created_at < ?`,
    ).get(p.tenantId, p.periodStart, p.periodEnd) ?? null;
  });

  registerQuery<BsvcInvoiceRow | null, BsvcInvoiceByPeriodParams>(BSVC_QUERY_INVOICE_BY_PERIOD, (db, p) => {
    return db.prepare<BsvcInvoiceRow>(
      `SELECT * FROM billing_invoices WHERE tenant_id = ? AND subscription_id = ? AND period_start = ? LIMIT 1`,
    ).get(p.tenantId, p.subscriptionId, p.periodStart) ?? null;
  });

  registerQuery<BsvcInvoiceRow | null, string>(BSVC_QUERY_INVOICE_BY_ID, (db, id) => {
    return db.prepare<BsvcInvoiceRow>(
      'SELECT * FROM billing_invoices WHERE id = ? LIMIT 1',
    ).get(id) ?? null;
  });

  registerQuery<BsvcInvoiceRow[], string>(BSVC_QUERY_INVOICES_BY_TENANT, (db, tenantId) => {
    return db.prepare<BsvcInvoiceRow>(
      `SELECT * FROM billing_invoices WHERE tenant_id = ? ORDER BY period_start DESC, created_at DESC`,
    ).all(tenantId);
  });

  registerQuery<BsvcUsageMeterRow[], BsvcUsageMetersParams>(BSVC_QUERY_USAGE_METERS, (db, p) => {
    return db.prepare<BsvcUsageMeterRow>(
      `SELECT resource, total_quantity FROM usage_meters WHERE tenant_id = ? AND period_start = ? AND period_end = ? ORDER BY resource ASC`,
    ).all(p.tenantId, p.periodStart, p.periodEnd);
  });

  registerQuery<BsvcUsageMeterRow[], BsvcReconciliationParams>(BSVC_QUERY_USAGE_RECORDS_SUMMARY, (db, p) => {
    return db.prepare<BsvcUsageMeterRow>(
      `SELECT resource, COALESCE(SUM(quantity), 0) AS total_quantity
       FROM usage_records WHERE tenant_id = ? AND recorded_at >= ? AND recorded_at < ? GROUP BY resource`,
    ).all(p.tenantId, p.periodStart, p.periodEnd);
  });

  /* ── Commands ── */

  registerCommand<BsvcSeedPlanParams>(BSVC_CMD_SEED_PLAN, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO billing_plans (
        id, name, stripe_price_id, price_minor, currency, billing_interval, limits_json, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, stripe_price_id = excluded.stripe_price_id,
        price_minor = excluded.price_minor, currency = excluded.currency,
        billing_interval = excluded.billing_interval, limits_json = excluded.limits_json,
        is_active = excluded.is_active, updated_at = excluded.updated_at`,
    ).run(p.id, p.name, p.stripePriceId, p.priceMinor, p.currency, p.billingInterval, p.limitsJson, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<BsvcUpdateSubParams>(BSVC_CMD_UPDATE_SUB, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE subscriptions SET plan_id = ?, status = 'active', current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?`,
    ).run(p.planId, p.periodStart, p.periodEnd, p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<BsvcInsertSubParams>(BSVC_CMD_INSERT_SUB, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO subscriptions (
        id, tenant_id, stripe_customer_id, stripe_subscription_id, plan_id, status,
        current_period_start, current_period_end, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, 'active', ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.planId, p.periodStart, p.periodEnd, p.now, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<BsvcUpdateInvoiceParams>(BSVC_CMD_UPDATE_INVOICE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE billing_invoices
       SET plan_id = ?, status = ?, amount_minor = ?, currency = ?, billing_interval = ?,
           period_end = ?, wallet_settlement_count = ?, wallet_settlement_total_minor = ?,
           reconciliation_status = 'balanced', updated_at = ?, paid_at = ?
       WHERE id = ?`,
    ).run(p.planId, p.status, p.amountMinor, p.currency, p.billingInterval,
      p.periodEnd, p.walletSettlementCount, p.walletSettlementTotalMinor, p.now, p.paidAt, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<BsvcInsertInvoiceParams>(BSVC_CMD_INSERT_INVOICE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO billing_invoices (
        id, tenant_id, subscription_id, plan_id, status, amount_minor, currency, billing_interval,
        period_start, period_end, wallet_settlement_count, wallet_settlement_total_minor,
        reconciliation_status, created_at, updated_at, paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'balanced', ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.subscriptionId, p.planId, p.status, p.amountMinor,
      p.currency, p.billingInterval, p.periodStart, p.periodEnd,
      p.walletSettlementCount, p.walletSettlementTotalMinor, p.now, p.now, p.paidAt);
    return { rowsAffected: result.changes };
  });

  registerCommand<BsvcDeleteUsageMetersParams>(BSVC_CMD_DELETE_USAGE_METERS, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM usage_meters WHERE tenant_id = ? AND period_start = ? AND period_end = ?',
    ).run(p.tenantId, p.periodStart, p.periodEnd);
    return { rowsAffected: result.changes };
  });

  registerCommand<BsvcInsertUsageMeterParams>(BSVC_CMD_INSERT_USAGE_METER, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO usage_meters (id, tenant_id, resource, period_start, period_end, total_quantity, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.tenantId, p.resource, p.periodStart, p.periodEnd, p.totalQuantity, p.now);
    return { rowsAffected: result.changes };
  });
}
