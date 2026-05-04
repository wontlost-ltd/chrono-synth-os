/**
 * Stripe Webhook SQL 执行器
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import {
  SWHS_QUERY_LATEST_SUBSCRIPTION, SWHS_QUERY_SUB_BY_STRIPE_CUSTOMER,
  SWHS_CMD_RECORD_EVENT, SWHS_CMD_PERSIST_STRIPE_CUSTOMER,
  SWHS_CMD_PURCHASE_ADDON, SWHS_CMD_UPDATE_SUBSCRIPTION,
  SWHS_CMD_CANCEL_BY_CUSTOMER, SWHS_CMD_CANCEL_TENANT_ADDONS,
  SWHS_CMD_FINALIZE_TRIAL_PERIOD, SWHS_CMD_REVIVE_INVOICE_PAID, SWHS_CMD_MARK_PAST_DUE,
} from '@chrono/kernel';
import type {
  SwhsSubscriptionRow,
  SwhsRecordEventParams, SwhsPersistStripeCustomerParams,
  SwhsPurchaseAddonParams, SwhsUpdateSubscriptionParams,
  SwhsCancelByCustomerParams, SwhsCancelTenantAddonsParams,
  SwhsFinalizeTrialPeriodParams, SwhsReviveInvoicePaidParams, SwhsMarkPastDueParams,
} from '@chrono/kernel';

export function registerStripeWebhookExecutors(): void {
  /* ── Queries ── */

  registerQuery<SwhsSubscriptionRow | null, string>(SWHS_QUERY_LATEST_SUBSCRIPTION, (db, tenantId) => {
    return db.prepare<SwhsSubscriptionRow>(
      'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId) ?? null;
  });

  registerQuery<SwhsSubscriptionRow | null, string>(SWHS_QUERY_SUB_BY_STRIPE_CUSTOMER, (db, customerId) => {
    return db.prepare<SwhsSubscriptionRow>(
      'SELECT * FROM subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(customerId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<SwhsRecordEventParams>(SWHS_CMD_RECORD_EVENT, (db, p) => {
    const result = db.prepare<void>(
      'INSERT INTO webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING',
    ).run(p.eventId, p.eventType, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<SwhsPersistStripeCustomerParams>(SWHS_CMD_PERSIST_STRIPE_CUSTOMER, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE subscriptions SET stripe_customer_id = ?, updated_at = ? WHERE id = ?',
    ).run(p.stripeCustomerId, p.now, p.subscriptionId);
    return { rowsAffected: result.changes };
  });

  registerCommand<SwhsPurchaseAddonParams>(SWHS_CMD_PURCHASE_ADDON, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO tenant_add_ons (id, tenant_id, add_on_id, status, purchased_at) VALUES (?, ?, ?, 'active', ?)`,
    ).run(p.id, p.tenantId, p.addOnId, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<SwhsUpdateSubscriptionParams>(SWHS_CMD_UPDATE_SUBSCRIPTION, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE subscriptions SET stripe_subscription_id = ?, status = ?, plan_id = ?, current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?`,
    ).run(p.stripeSubscriptionId, p.status, p.planId, p.periodStart, p.periodEnd, p.now, p.subscriptionRowId);
    return { rowsAffected: result.changes };
  });

  registerCommand<SwhsCancelByCustomerParams>(SWHS_CMD_CANCEL_BY_CUSTOMER, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE subscriptions SET status = 'canceled', plan_id = 'free', updated_at = ? WHERE stripe_customer_id = ?`,
    ).run(p.now, p.stripeCustomerId);
    return { rowsAffected: result.changes };
  });

  registerCommand<SwhsCancelTenantAddonsParams>(SWHS_CMD_CANCEL_TENANT_ADDONS, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE tenant_add_ons SET status = 'canceled', canceled_at = ? WHERE tenant_id = ? AND status = 'active'`,
    ).run(p.now, p.tenantId);
    return { rowsAffected: result.changes };
  });

  registerCommand<SwhsFinalizeTrialPeriodParams>(SWHS_CMD_FINALIZE_TRIAL_PERIOD, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE subscriptions
          SET trial_end = ?,
              cancel_at_period_end = ?,
              grace_period_ends_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(p.trialEnd, p.cancelAtPeriodEnd, p.now, p.subscriptionRowId);
    return { rowsAffected: result.changes };
  });

  registerCommand<SwhsReviveInvoicePaidParams>(SWHS_CMD_REVIVE_INVOICE_PAID, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE subscriptions
          SET status = CASE WHEN status IN ('past_due', 'canceled') THEN 'active' ELSE status END,
              grace_period_ends_at = NULL,
              last_invoice_id = COALESCE(?, last_invoice_id),
              updated_at = ?
        WHERE id = ?`,
    ).run(p.invoiceId, p.now, p.subscriptionRowId);
    return { rowsAffected: result.changes };
  });

  registerCommand<SwhsMarkPastDueParams>(SWHS_CMD_MARK_PAST_DUE, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE subscriptions
          SET status = 'past_due',
              grace_period_ends_at = ?,
              last_invoice_id = COALESCE(?, last_invoice_id),
              updated_at = ?
        WHERE id = ?`,
    ).run(p.graceEndsAt, p.invoiceId, p.now, p.subscriptionRowId);
    return { rowsAffected: result.changes };
  });
}
