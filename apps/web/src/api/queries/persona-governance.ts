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

/** 读某 persona 的有效策略 + owner 覆盖。 */
export function useGovernancePolicy(personaId: string) {
  return useQuery({
    queryKey: policyKey(personaId),
    queryFn: () =>
      apiFetch<{ data: GovernancePolicyResponse }>(`/api/v1/persona-core/${personaId}/governance/policy`)
        .then((r) => r.data),
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
      apiFetch<{ data: GovernancePolicyResponse }>(`/api/v1/persona-core/${personaId}/governance/policy`, {
        method: 'PUT',
        body: JSON.stringify(override),
        headers: ifMatch !== undefined ? { 'If-Match': String(ifMatch) } : undefined,
      }).then((r) => r.data),
    onSuccess: (data) => qc.setQueryData(policyKey(personaId), data),
  });
}

/** 清除覆盖，恢复默认。 */
export function useResetGovernancePolicy(personaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: GovernancePolicyResponse }>(`/api/v1/persona-core/${personaId}/governance/policy`, {
        method: 'DELETE',
      }).then((r) => r.data),
    onSuccess: (data) => qc.setQueryData(policyKey(personaId), data),
  });
}
