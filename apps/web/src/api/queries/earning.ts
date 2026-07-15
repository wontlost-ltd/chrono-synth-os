import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

/* 数字人自主赚钱域（ADR-0048）——钱包只读 + 收益流水 + 触发赚钱周期。owner-only JWT，per-persona。
 * 响应均为单键 {data} 信封 → apiFetch<T> 已自动解包，直接拿内层（勿 .then(r=>r.data)）。 */

/** 钱包视图（只读；自主流只增不减，提现须人工确认，不在此路由）。 */
export interface EarningWallet {
  walletId: string;
  balance: number;
  tokenBalance: number;
  currency: string;
  withdrawalPolicy: 'human_confirmation_required';
}

/** 收益/工作流水的一条任务（MarketplaceTask 子集）。 */
export interface EarningTask {
  id: string;
  title: string;
  category: 'writing' | 'coding' | 'research' | 'operations' | 'general';
  reward: number;
  currency: string;
  status: 'open' | 'accepted' | 'completed' | 'cancelled';
  qualityScore: number | null;
  acceptedAt: string | null;
  completedAt: string | null;
}

export interface EarningFeed {
  tasks: EarningTask[];
  total: number;
}

/** 一次赚钱周期里对单个任务的确定性决策。 */
export interface EarningCycleTaskOutcome {
  taskId: string;
  title: string;
  decision: 'applied' | 'skipped' | 'needs_human_review' | 'forbidden';
  reasons: string[];
}

export interface EarningCycleResult {
  scanned: number;
  applied: number;
  reviewQueued: number;
  skipped: number;
  outcomes: EarningCycleTaskOutcome[];
}

const base = (personaId: string): string => `/api/v1/persona-core/${encodeURIComponent(personaId)}/earning`;

export function useEarningWallet(personaId: string) {
  return useQuery({
    queryKey: ['earning', 'wallet', personaId],
    queryFn: ({ signal }) => apiFetch<EarningWallet>(`${base(personaId)}/wallet`, { signal }),
    enabled: !!personaId,
  });
}

export function useEarningFeed(personaId: string) {
  return useQuery({
    queryKey: ['earning', 'feed', personaId],
    queryFn: ({ signal }) => apiFetch<EarningFeed>(`${base(personaId)}/feed`, { signal }),
    enabled: !!personaId,
  });
}

/** 触发一轮赚钱周期（自主接单/送审/跳过；限流 12/min，UI 须处理 429）。成功后刷新钱包+流水。 */
export function useRunEarningCycle(personaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { maxTasksPerCycle?: number }) =>
      apiFetch<EarningCycleResult>(`${base(personaId)}/cycle`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['earning', 'wallet', personaId] });
      qc.invalidateQueries({ queryKey: ['earning', 'feed', personaId] });
    },
  });
}
