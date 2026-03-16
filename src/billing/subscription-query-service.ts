/**
 * Subscription Query Application Service
 * 封装订阅计划查询的数据访问，供路由与其他服务复用
 */

import type { IDatabase } from '../storage/database.js';

export class SubscriptionQueryService {
  constructor(private readonly db: IDatabase) {}

  /** 获取租户最近一条订阅的 plan_id（不过滤 status），无订阅时返回 'free' */
  getLatestPlanId(tenantId: string): string {
    const row = this.db.prepare<{ plan_id: string }>(
      'SELECT plan_id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(tenantId);
    return row?.plan_id ?? 'free';
  }

  /** 获取租户当前活跃订阅的 stripe_customer_id，无活跃订阅时返回 null */
  getActiveStripeCustomerId(tenantId: string): string | null {
    const row = this.db.prepare<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId);
    return row?.stripe_customer_id ?? null;
  }

  /** 获取租户当前活跃订阅的 plan_id（仅 status='active'），无活跃订阅时返回 'free' */
  getActiveSubscriptionPlanId(tenantId: string): string {
    const row = this.db.prepare<{ plan_id: string }>(
      `SELECT plan_id FROM subscriptions WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId);
    return row?.plan_id ?? 'free';
  }
}
