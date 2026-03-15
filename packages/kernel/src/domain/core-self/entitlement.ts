/**
 * 权益契约 — 跨运行时的资源配额接口
 * 具体实现（Stripe 集成、数据库查询）留在宿主层
 */

import type { TenantScope } from '../../index.js';

/** 资源配额限制，-1 表示无限制 */
export interface PlanLimits {
  readonly maxSimulations: number;
  readonly maxPaths: number;
  readonly llmTokensPerMonth: number;
  readonly rateLimitPerMinute: number;
  readonly maxAvatars: number;
  readonly maxMemoryNodes: number;
}

/** 权益检查结果 */
export interface EntitlementResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly limit?: number;
  readonly used?: number;
}

/** 有效配额 */
export interface Entitlement {
  readonly resource: string;
  readonly limit: number;
  readonly used: number;
}

/** 权益契约 — 内核通过此接口检查配额，不依赖具体计费实现 */
export interface EntitlementContract {
  check(scope: TenantScope, resource: string): Promise<EntitlementResult>;
  listActive(scope: TenantScope): Promise<readonly Entitlement[]>;
  effectiveLimits(scope: TenantScope): Promise<PlanLimits>;
}
