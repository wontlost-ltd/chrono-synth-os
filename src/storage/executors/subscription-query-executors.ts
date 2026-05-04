/**
 * 订阅查询 SQL 执行器
 */

import { registerQuery } from '../legacy-sync-bridge.js';
import {
  SUBQ_QUERY_LATEST_PLAN, SUBQ_QUERY_ACTIVE_STRIPE_CUSTOMER, SUBQ_QUERY_ACTIVE_PLAN,
  SUBQ_QUERY_GATE_LATEST,
} from '@chrono/kernel';
import type { SubqPlanIdRow, SubqStripeCustomerRow, SubqGateRow } from '@chrono/kernel';

export function registerSubscriptionQueryExecutors(): void {
  registerQuery<SubqPlanIdRow | null, string>(SUBQ_QUERY_LATEST_PLAN, (db, tenantId) => {
    return db.prepare<SubqPlanIdRow>(
      'SELECT plan_id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId) ?? null;
  });

  registerQuery<SubqStripeCustomerRow | null, string>(SUBQ_QUERY_ACTIVE_STRIPE_CUSTOMER, (db, tenantId) => {
    return db.prepare<SubqStripeCustomerRow>(
      `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId) ?? null;
  });

  registerQuery<SubqPlanIdRow | null, string>(SUBQ_QUERY_ACTIVE_PLAN, (db, tenantId) => {
    return db.prepare<SubqPlanIdRow>(
      `SELECT plan_id FROM subscriptions WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId) ?? null;
  });

  registerQuery<SubqGateRow | null, string>(SUBQ_QUERY_GATE_LATEST, (db, tenantId) => {
    return db.prepare<SubqGateRow>(
      `SELECT id, plan_id, status, grace_period_ends_at, current_period_end, trial_end
         FROM subscriptions
        WHERE tenant_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    ).get(tenantId) ?? null;
  });
}
