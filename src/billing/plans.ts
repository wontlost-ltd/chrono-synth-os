/**
 * 计费计划定义
 * 定义所有可用的订阅计划及其资源限制
 */

export interface PlanLimits {
  readonly maxSimulations: number;
  readonly maxPaths: number;
  readonly llmTokensPerMonth: number;
}

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly stripePriceId: string;
  readonly limits: PlanLimits;
}

/** 预定义计划列表 */
export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: '免费版',
    stripePriceId: '',
    limits: { maxSimulations: 3, maxPaths: 2, llmTokensPerMonth: 10_000 },
  },
  {
    id: 'pro',
    name: '专业版',
    stripePriceId: 'price_pro_monthly',
    limits: { maxSimulations: 50, maxPaths: 10, llmTokensPerMonth: 500_000 },
  },
  {
    id: 'enterprise',
    name: '企业版',
    stripePriceId: 'price_enterprise_monthly',
    limits: { maxSimulations: -1, maxPaths: -1, llmTokensPerMonth: -1 },
  },
];

/** 通过 ID 查找计划 */
export function getPlan(planId: string): Plan | undefined {
  return PLANS.find(p => p.id === planId);
}

/** 获取计划限制，不存在时返回 free 计划限制 */
export function getPlanLimits(planId: string): PlanLimits {
  const plan = getPlan(planId);
  return plan?.limits ?? PLANS[0].limits;
}
