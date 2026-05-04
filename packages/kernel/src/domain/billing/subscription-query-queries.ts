/**
 * 订阅查询 Query kind 常量与参数类型
 */

import type { Query } from '../../ports/query.js';

/* ── Query Kinds ── */

export const SUBQ_QUERY_LATEST_PLAN = 'subscriptionQuery.latestPlan' as const;
export const SUBQ_QUERY_ACTIVE_STRIPE_CUSTOMER = 'subscriptionQuery.activeStripeCustomer' as const;
export const SUBQ_QUERY_ACTIVE_PLAN = 'subscriptionQuery.activePlan' as const;
export const SUBQ_QUERY_GATE_LATEST = 'subscriptionQuery.gateLatest' as const;

/* ── 行类型 ── */

export interface SubqPlanIdRow {
  readonly plan_id: string;
}

export interface SubqStripeCustomerRow {
  readonly stripe_customer_id: string | null;
}

export interface SubqGateRow {
  readonly id: string;
  readonly plan_id: string;
  readonly status: string;
  readonly grace_period_ends_at: number | null;
  readonly current_period_end: number | null;
  readonly trial_end: number | null;
}

/* ── Query 工厂 ── */

export function subqQueryLatestPlan(tenantId: string): Query<SubqPlanIdRow | null, string> {
  return { kind: SUBQ_QUERY_LATEST_PLAN, params: tenantId };
}

export function subqQueryActiveStripeCustomer(tenantId: string): Query<SubqStripeCustomerRow | null, string> {
  return { kind: SUBQ_QUERY_ACTIVE_STRIPE_CUSTOMER, params: tenantId };
}

export function subqQueryActivePlan(tenantId: string): Query<SubqPlanIdRow | null, string> {
  return { kind: SUBQ_QUERY_ACTIVE_PLAN, params: tenantId };
}

export function subqQueryGateLatest(tenantId: string): Query<SubqGateRow | null, string> {
  return { kind: SUBQ_QUERY_GATE_LATEST, params: tenantId };
}
