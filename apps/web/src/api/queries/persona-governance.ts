/**
 * per-persona 治理策略 API hooks（ADR-0048 治理可配化）。
 *
 * 后端（owner-only）：
 *   GET    /api/v1/persona-core/:personaId/governance/policy  → { override, effective, meta }
 *   PUT    /api/v1/persona-core/:personaId/governance/policy  → 设置覆盖（整体替换语义）
 *   DELETE /api/v1/persona-core/:personaId/governance/policy  → 恢复默认
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export type CategoryRouteMode = 'autonomous' | 'human_review' | 'blocked';
export type MarketplaceTaskCategory = 'writing' | 'coding' | 'research' | 'operations' | 'general';

/** AML 聚合阈值（可覆盖子集）。 */
export interface AmlAggregateOverride {
  maxTasksPerPublisherPerWindow?: number;
  maxPublisherRewardShare?: number;
  concentrationMinTasks?: number;
  maxIdenticalRewardRepeats?: number;
}

/** owner 可覆盖的治理字段（整体替换语义——传入即完整覆盖对象）。 */
export interface GovernanceOverride {
  categoryRoutes?: Partial<Record<MarketplaceTaskCategory, CategoryRouteMode>>;
  defaultCategoryRoute?: CategoryRouteMode;
  maxAutonomousReward?: number;
  dailyRewardExposureCap?: number;
  maxConcurrentTasks?: number;
  aml?: AmlAggregateOverride;
  /** 不确定性预算（窗口内 auto-compile 上限；0=完全禁止自动吸收）。 */
  unverifiedGrowthBudgetPerWindow?: number;
}

/** 有效策略（DEFAULT ∪ 覆盖）——只读展示用，含完整字段。 */
export interface EffectiveGovernancePolicy {
  allowedCategories: MarketplaceTaskCategory[];
  categoryRoutes?: Partial<Record<MarketplaceTaskCategory, CategoryRouteMode>>;
  defaultCategoryRoute?: CategoryRouteMode;
  maxAutonomousReward: number;
  dailyRewardExposureCap: number;
  maxConcurrentTasks: number;
  failureStreakBreaker: number;
  minReputationForAutonomy: number;
  aml: {
    maxTasksPerPublisherPerWindow: number;
    maxPublisherRewardShare: number;
    concentrationMinTasks: number;
    maxIdenticalRewardRepeats: number;
  };
}

export interface GovernancePolicyResponse {
  override: GovernanceOverride | null;
  effective: EffectiveGovernancePolicy;
  meta: { updatedBy: string | null; updatedAt: number } | null;
}

function policyKey(personaId: string): readonly unknown[] {
  return ['persona-governance', personaId];
}

/* ⚠️ 审计 #414：此处曾**双重解包**。后端 `earning.ts:145` 返回**单键**信封
 * `{data:{override,effective,meta}}`，而 `apiFetch`（client.ts:250）对单键信封
 * **已经解包**；这里再 `.then(r => r.data)` 就得到 `undefined` ——
 * `PersonaGovernance.tsx:110` 的 `!data` 守卫必定命中，页面**永远**只显示
 * loadError，花费上限/类目路由/AML 限额在 UI 中不可看也不可改。GET/PUT/DELETE 三个动词全中。
 *
 * 同目录 earning.ts / workforce.ts / decisions.ts 都写有防此错的注释，唯独本文件漏了。
 * 判据：`apiFetch<T>` 的 T 直接写**解包后**的类型，不要写 `{data: T}` 再手动取。 */

/** 读某 persona 的有效策略 + owner 覆盖。 */
export function useGovernancePolicy(personaId: string) {
  return useQuery({
    queryKey: policyKey(personaId),
    queryFn: () =>
      apiFetch<GovernancePolicyResponse>(`/api/v1/persona-core/${personaId}/governance/policy`),
    enabled: personaId.length > 0,
  });
}

/** 设置某 persona 的策略覆盖（整体替换）。 */
/** PUT 入参：override + 可选 ifMatch（乐观并发版本 = 上次读到的 meta.updatedAt）。 */
export interface SetGovernanceInput {
  override: GovernanceOverride;
  /** 客户端读到的版本；带上则做乐观并发——服务端版本不符 → 409。 */
  ifMatch?: number;
}

export function useSetGovernancePolicy(personaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ override, ifMatch }: SetGovernanceInput) =>
      apiFetch<GovernancePolicyResponse>(`/api/v1/persona-core/${personaId}/governance/policy`, {
        method: 'PUT',
        body: JSON.stringify(override),
        headers: ifMatch !== undefined ? { 'If-Match': String(ifMatch) } : undefined,
      }),
    onSuccess: (data) => qc.setQueryData(policyKey(personaId), data),
  });
}

/** 清除覆盖，恢复默认。 */
export function useResetGovernancePolicy(personaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<GovernancePolicyResponse>(`/api/v1/persona-core/${personaId}/governance/policy`, {
        method: 'DELETE',
      }),
    onSuccess: (data) => qc.setQueryData(policyKey(personaId), data),
  });
}
