/**
 * Subscription Query Application Service
 * 封装订阅计划查询的数据访问，供路由与其他服务复用
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  subqQueryLatestPlan, subqQueryActiveStripeCustomer, subqQueryActivePlan,
} from '@chrono/kernel';
import { asUow, type UowOrDb } from '../storage/uow-helpers.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export class SubscriptionQueryService {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
  }

  /** 获取租户最近一条订阅的 plan_id（不过滤 status），无订阅时返回 'free' */
  getLatestPlanId(tenantId: string): string {
    const row = this.tx.queryOne(subqQueryLatestPlan(tenantId));
    return row?.plan_id ?? 'free';
  }

  /** 获取租户当前活跃订阅的 stripe_customer_id，无活跃订阅时返回 null */
  getActiveStripeCustomerId(tenantId: string): string | null {
    const row = this.tx.queryOne(subqQueryActiveStripeCustomer(tenantId));
    return row?.stripe_customer_id ?? null;
  }

  /** 获取租户当前活跃订阅的 plan_id（仅 status='active'），无活跃订阅时返回 'free' */
  getActiveSubscriptionPlanId(tenantId: string): string {
    const row = this.tx.queryOne(subqQueryActivePlan(tenantId));
    return row?.plan_id ?? 'free';
  }
}
