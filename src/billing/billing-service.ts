import { randomUUID } from 'node:crypto';
import type { SyncWriteUnitOfWork, BsvcSubscriptionRow, BsvcInvoiceRow } from '@chrono/kernel';
import {
  bsvcQueryListPlans, bsvcQueryLatestSub, bsvcQueryReconciliation,
  bsvcQueryInvoiceByPeriod, bsvcQueryInvoiceById, bsvcQueryInvoicesByTenant,
  bsvcQueryUsageMeters, bsvcQueryUsageRecordsSummary,
  bsvcCmdSeedPlan, bsvcCmdUpdateSub, bsvcCmdInsertSub,
  bsvcCmdUpdateInvoice, bsvcCmdInsertInvoice,
  bsvcCmdDeleteUsageMeters, bsvcCmdInsertUsageMeter,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import { EntitlementService } from './entitlement-service.js';
import { PLANS, getPlan, syncPlanToQuota } from './plans.js';

const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

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

  constructor(private readonly tx: SyncWriteUnitOfWork) {
    registerCoreSelfExecutors();
    this.entitlementService = new EntitlementService(tx);
  }

  seedBillingPlans(): void {
    const now = Date.now();
    for (const plan of PLANS) {
      this.tx.execute(bsvcCmdSeedPlan({
        id: plan.id,
        name: plan.name,
        stripePriceId: plan.stripePriceId,
        priceMinor: plan.priceMinor,
        currency: plan.currency,
        billingInterval: plan.billingInterval,
        limitsJson: JSON.stringify(plan.limits),
        now,
      }));
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
    const rows = this.tx.queryMany(bsvcQueryListPlans());
    return rows.map((row) => ({
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
      this.tx.execute(bsvcCmdUpdateSub({
        id: current.id, planId: plan.id, periodStart, periodEnd, now,
      }));
    } else {
      this.tx.execute(bsvcCmdInsertSub({
        id: `sub_${randomUUID()}`, tenantId, planId: plan.id, periodStart, periodEnd, now,
      }));
    }

    syncPlanToQuota(this.tx, tenantId, plan.id);
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

    const invoices = [...this.tx.queryMany(bsvcQueryInvoicesByTenant(tenantId))];
    return invoices.map((invoice) => this.serializeInvoice(invoice));
  }

  private getLatestSubscription(tenantId: string): BsvcSubscriptionRow | undefined {
    return this.tx.queryOne(bsvcQueryLatestSub(tenantId)) ?? undefined;
  }

  private materializeInvoice(subscription: BsvcSubscriptionRow): BillingInvoiceView {
    const plan = getPlan(subscription.plan_id) ?? getPlan('free');
    if (!plan) {
      throw new Error(`订阅 ${subscription.id} 缺少可用 plan`);
    }

    const usageSummary = this.syncUsageMeters(
      subscription.tenant_id,
      Number(subscription.current_period_start),
      Number(subscription.current_period_end),
    );

    const reconciliation = this.tx.queryOne(bsvcQueryReconciliation({
      tenantId: subscription.tenant_id,
      periodStart: subscription.current_period_start,
      periodEnd: subscription.current_period_end,
    })) ?? {
      wallet_settlement_count: 0,
      wallet_settlement_total_minor: 0,
    };

    const existing = this.tx.queryOne(bsvcQueryInvoiceByPeriod({
      tenantId: subscription.tenant_id,
      subscriptionId: subscription.id,
      periodStart: subscription.current_period_start,
    }));

    const now = Date.now();
    const status = plan.priceMinor === 0 ? 'paid' : 'open';
    const invoiceId = existing?.id ?? `inv_${randomUUID()}`;
    const paidAt = status === 'paid' ? (existing?.paid_at ?? now) : existing?.paid_at ?? null;

    if (existing) {
      this.tx.execute(bsvcCmdUpdateInvoice({
        id: invoiceId,
        planId: plan.id,
        status,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        billingInterval: plan.billingInterval,
        periodEnd: subscription.current_period_end,
        walletSettlementCount: Number(reconciliation.wallet_settlement_count),
        walletSettlementTotalMinor: Number(reconciliation.wallet_settlement_total_minor),
        now,
        paidAt,
      }));
    } else {
      this.tx.execute(bsvcCmdInsertInvoice({
        id: invoiceId,
        tenantId: subscription.tenant_id,
        subscriptionId: subscription.id,
        planId: plan.id,
        status,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        billingInterval: plan.billingInterval,
        periodStart: subscription.current_period_start,
        periodEnd: subscription.current_period_end,
        walletSettlementCount: Number(reconciliation.wallet_settlement_count),
        walletSettlementTotalMinor: Number(reconciliation.wallet_settlement_total_minor),
        now,
        paidAt,
      }));
    }

    const row = this.tx.queryOne(bsvcQueryInvoiceById(invoiceId));
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
    const rows = this.tx.queryMany(bsvcQueryUsageRecordsSummary({
      tenantId, periodStart, periodEnd,
    }));

    this.tx.execute(bsvcCmdDeleteUsageMeters({ tenantId, periodStart, periodEnd }));

    const now = Date.now();
    for (const row of rows) {
      this.tx.execute(bsvcCmdInsertUsageMeter({
        id: `meter_${randomUUID()}`,
        tenantId, resource: row.resource,
        periodStart, periodEnd,
        totalQuantity: row.total_quantity,
        now,
      }));
    }

    return Object.fromEntries(rows.map((row) => [row.resource, Number(row.total_quantity)]));
  }

  private serializeSubscription(subscription: BsvcSubscriptionRow): BillingSubscriptionView {
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
    invoice: BsvcInvoiceRow,
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
    const rows = this.tx.queryMany(bsvcQueryUsageMeters({
      tenantId, periodStart, periodEnd,
    }));
    return Object.fromEntries(rows.map((row) => [row.resource, Number(row.total_quantity)]));
  }
}
