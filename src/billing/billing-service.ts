import { randomUUID } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import { EntitlementService } from './entitlement-service.js';
import { PLANS, getPlan, syncPlanToQuota } from './plans.js';

const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  created_at: number;
  updated_at: number;
}

interface BillingInvoiceRow {
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

interface UsageMeterRow {
  resource: string;
  total_quantity: number;
}

export interface BillingSubscriptionView {
  subscriptionId: string;
  tenantId: string;
  planId: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingInvoiceView {
  invoiceId: string;
  subscriptionId: string;
  planId: string;
  planName: string;
  status: string;
  amountMinor: number;
  currency: string;
  billingInterval: string;
  periodStart: string;
  periodEnd: string;
  usageSummary: Record<string, number>;
  reconciliation: {
    walletSettlementCount: number;
    walletSettlementTotalMinor: number;
    status: string;
  };
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(Number(value)).toISOString();
}

export class BillingService {
  private readonly entitlementService: EntitlementService;

  constructor(private readonly db: IDatabase) {
    this.entitlementService = new EntitlementService(db);
  }

  seedBillingPlans(): void {
    const now = Date.now();
    for (const plan of PLANS) {
      this.db.prepare<void>(
        `INSERT INTO billing_plans (
          id, name, stripe_price_id, price_minor, currency, billing_interval, limits_json, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          stripe_price_id = excluded.stripe_price_id,
          price_minor = excluded.price_minor,
          currency = excluded.currency,
          billing_interval = excluded.billing_interval,
          limits_json = excluded.limits_json,
          is_active = excluded.is_active,
          updated_at = excluded.updated_at`,
      ).run(
        plan.id,
        plan.name,
        plan.stripePriceId,
        plan.priceMinor,
        plan.currency,
        plan.billingInterval,
        JSON.stringify(plan.limits),
        now,
        now,
      );
    }
  }

  listPlans(): Array<{
    id: string;
    name: string;
    stripePriceId: string;
    priceMinor: number;
    currency: string;
    billingInterval: string;
    limits: Record<string, number>;
  }> {
    this.seedBillingPlans();
    return this.db.prepare<{
      id: string;
      name: string;
      stripe_price_id: string;
      price_minor: number;
      currency: string;
      billing_interval: string;
      limits_json: string;
    }>(
      `SELECT id, name, stripe_price_id, price_minor, currency, billing_interval, limits_json
       FROM billing_plans
       WHERE is_active = 1
       ORDER BY CASE id WHEN 'free' THEN 0 WHEN 'pro' THEN 1 ELSE 2 END ASC, name ASC`,
    ).all().map((row) => ({
      id: row.id,
      name: row.name,
      stripePriceId: row.stripe_price_id,
      priceMinor: Number(row.price_minor),
      currency: row.currency,
      billingInterval: row.billing_interval,
      limits: JSON.parse(row.limits_json) as Record<string, number>,
    }));
  }

  subscribeTenant(tenantId: string, planId: string): {
    subscription: BillingSubscriptionView;
    invoice: BillingInvoiceView;
  } {
    const plan = getPlan(planId);
    if (!plan) {
      throw new RangeError(`未知 planId: ${planId}`);
    }

    this.seedBillingPlans();

    const now = Date.now();
    const periodStart = now;
    const periodEnd = now + BILLING_PERIOD_MS;
    const current = this.getLatestSubscription(tenantId);

    if (current) {
      this.db.prepare<void>(
        `UPDATE subscriptions
         SET plan_id = ?, status = 'active', current_period_start = ?, current_period_end = ?, updated_at = ?
         WHERE id = ?`,
      ).run(plan.id, periodStart, periodEnd, now, current.id);
    } else {
      this.db.prepare<void>(
        `INSERT INTO subscriptions (
          id, tenant_id, stripe_customer_id, stripe_subscription_id, plan_id, status,
          current_period_start, current_period_end, created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, ?, 'active', ?, ?, ?, ?)`,
      ).run(`sub_${randomUUID()}`, tenantId, plan.id, periodStart, periodEnd, now, now);
    }

    syncPlanToQuota(this.db, tenantId, plan.id);
    this.entitlementService.syncTenantEntitlements(tenantId);

    const subscription = this.getLatestSubscription(tenantId);
    if (!subscription) {
      throw new Error(`订阅切换后未找到 tenant=${tenantId} 的 subscription`);
    }

    const invoice = this.materializeInvoice(subscription);
    return {
      subscription: this.serializeSubscription(subscription),
      invoice,
    };
  }

  listInvoices(tenantId: string): BillingInvoiceView[] {
    this.seedBillingPlans();
    const current = this.getLatestSubscription(tenantId);
    if (current) {
      this.materializeInvoice(current);
    }

    const invoices = this.db.prepare<BillingInvoiceRow>(
      `SELECT *
       FROM billing_invoices
       WHERE tenant_id = ?
       ORDER BY period_start DESC, created_at DESC`,
    ).all(tenantId);

    return invoices.map((invoice) => this.serializeInvoice(invoice));
  }

  private getLatestSubscription(tenantId: string): SubscriptionRow | undefined {
    return this.db.prepare<SubscriptionRow>(
      `SELECT *
       FROM subscriptions
       WHERE tenant_id = ?
       ORDER BY created_at DESC, updated_at DESC
       LIMIT 1`,
    ).get(tenantId);
  }

  private materializeInvoice(subscription: SubscriptionRow): BillingInvoiceView {
    const plan = getPlan(subscription.plan_id) ?? getPlan('free');
    if (!plan) {
      throw new Error(`订阅 ${subscription.id} 缺少可用 plan`);
    }

    const usageSummary = this.syncUsageMeters(
      subscription.tenant_id,
      Number(subscription.current_period_start),
      Number(subscription.current_period_end),
    );

    const reconciliation = this.db.prepare<{
      wallet_settlement_count: number;
      wallet_settlement_total_minor: number;
    }>(
      `SELECT
         COUNT(*) AS wallet_settlement_count,
         COALESCE(SUM(total_amount_minor), 0) AS wallet_settlement_total_minor
       FROM wallet_settlements
       WHERE tenant_id = ?
         AND created_at >= ?
         AND created_at < ?`,
    ).get(
      subscription.tenant_id,
      subscription.current_period_start,
      subscription.current_period_end,
    ) ?? {
      wallet_settlement_count: 0,
      wallet_settlement_total_minor: 0,
    };

    const existing = this.db.prepare<BillingInvoiceRow>(
      `SELECT *
       FROM billing_invoices
       WHERE tenant_id = ? AND subscription_id = ? AND period_start = ?
       LIMIT 1`,
    ).get(subscription.tenant_id, subscription.id, subscription.current_period_start);

    const now = Date.now();
    const status = plan.priceMinor === 0 ? 'paid' : 'open';
    const invoiceId = existing?.id ?? `inv_${randomUUID()}`;
    const paidAt = status === 'paid' ? (existing?.paid_at ?? now) : existing?.paid_at ?? null;

    if (existing) {
      this.db.prepare<void>(
        `UPDATE billing_invoices
         SET plan_id = ?, status = ?, amount_minor = ?, currency = ?, billing_interval = ?,
             period_end = ?, wallet_settlement_count = ?, wallet_settlement_total_minor = ?,
             reconciliation_status = 'balanced', updated_at = ?, paid_at = ?
         WHERE id = ?`,
      ).run(
        plan.id,
        status,
        plan.priceMinor,
        plan.currency,
        plan.billingInterval,
        subscription.current_period_end,
        reconciliation.wallet_settlement_count,
        reconciliation.wallet_settlement_total_minor,
        now,
        paidAt,
        invoiceId,
      );
    } else {
      this.db.prepare<void>(
        `INSERT INTO billing_invoices (
          id, tenant_id, subscription_id, plan_id, status, amount_minor, currency, billing_interval,
          period_start, period_end, wallet_settlement_count, wallet_settlement_total_minor,
          reconciliation_status, created_at, updated_at, paid_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'balanced', ?, ?, ?)`,
      ).run(
        invoiceId,
        subscription.tenant_id,
        subscription.id,
        plan.id,
        status,
        plan.priceMinor,
        plan.currency,
        plan.billingInterval,
        subscription.current_period_start,
        subscription.current_period_end,
        reconciliation.wallet_settlement_count,
        reconciliation.wallet_settlement_total_minor,
        now,
        now,
        paidAt,
      );
    }

    const row = this.db.prepare<BillingInvoiceRow>(
      'SELECT * FROM billing_invoices WHERE id = ? LIMIT 1',
    ).get(invoiceId);
    if (!row) {
      throw new Error(`materializeInvoice 未找到 invoice ${invoiceId}`);
    }

    return this.serializeInvoice(row, usageSummary);
  }

  private syncUsageMeters(
    tenantId: string,
    periodStart: number,
    periodEnd: number,
  ): Record<string, number> {
    const rows = this.db.prepare<UsageMeterRow>(
      `SELECT resource, COALESCE(SUM(quantity), 0) AS total_quantity
       FROM usage_records
       WHERE tenant_id = ?
         AND recorded_at >= ?
         AND recorded_at < ?
       GROUP BY resource`,
    ).all(tenantId, periodStart, periodEnd);

    this.db.prepare<void>(
      'DELETE FROM usage_meters WHERE tenant_id = ? AND period_start = ? AND period_end = ?',
    ).run(tenantId, periodStart, periodEnd);

    const now = Date.now();
    for (const row of rows) {
      this.db.prepare<void>(
        `INSERT INTO usage_meters (
          id, tenant_id, resource, period_start, period_end, total_quantity, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(`meter_${randomUUID()}`, tenantId, row.resource, periodStart, periodEnd, row.total_quantity, now);
    }

    return Object.fromEntries(rows.map((row) => [row.resource, Number(row.total_quantity)]));
  }

  private serializeSubscription(subscription: SubscriptionRow): BillingSubscriptionView {
    return {
      subscriptionId: subscription.id,
      tenantId: subscription.tenant_id,
      planId: subscription.plan_id,
      status: subscription.status,
      periodStart: new Date(Number(subscription.current_period_start)).toISOString(),
      periodEnd: new Date(Number(subscription.current_period_end)).toISOString(),
      createdAt: new Date(Number(subscription.created_at)).toISOString(),
      updatedAt: new Date(Number(subscription.updated_at)).toISOString(),
    };
  }

  private serializeInvoice(
    invoice: BillingInvoiceRow,
    usageSummary?: Record<string, number>,
  ): BillingInvoiceView {
    const plan = getPlan(invoice.plan_id) ?? getPlan('free');
    return {
      invoiceId: invoice.id,
      subscriptionId: invoice.subscription_id,
      planId: invoice.plan_id,
      planName: plan?.name ?? invoice.plan_id,
      status: invoice.status,
      amountMinor: Number(invoice.amount_minor),
      currency: invoice.currency,
      billingInterval: invoice.billing_interval,
      periodStart: new Date(Number(invoice.period_start)).toISOString(),
      periodEnd: new Date(Number(invoice.period_end)).toISOString(),
      usageSummary: usageSummary ?? this.readUsageSummary(invoice.tenant_id, invoice.period_start, invoice.period_end),
      reconciliation: {
        walletSettlementCount: Number(invoice.wallet_settlement_count),
        walletSettlementTotalMinor: Number(invoice.wallet_settlement_total_minor),
        status: invoice.reconciliation_status,
      },
      createdAt: new Date(Number(invoice.created_at)).toISOString(),
      updatedAt: new Date(Number(invoice.updated_at)).toISOString(),
      paidAt: toIso(invoice.paid_at),
    };
  }

  private readUsageSummary(
    tenantId: string,
    periodStart: number,
    periodEnd: number,
  ): Record<string, number> {
    const rows = this.db.prepare<UsageMeterRow>(
      `SELECT resource, total_quantity
       FROM usage_meters
       WHERE tenant_id = ? AND period_start = ? AND period_end = ?
       ORDER BY resource ASC`,
    ).all(tenantId, periodStart, periodEnd);
    return Object.fromEntries(rows.map((row) => [row.resource, Number(row.total_quantity)]));
  }
}
