import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { MarketplaceTask, MarketplaceTaskCategory, MarketplaceTaskStatus } from './personaCore';

function invalidateMarketplaceQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['marketplace-tasks'] });
  qc.invalidateQueries({ queryKey: ['persona-core'] });
}

export function useMarketplaceTasks(status: MarketplaceTaskStatus) {
  return useQuery({
    queryKey: ['marketplace-tasks', status],
    queryFn: ({ signal }) =>
      apiFetch<MarketplaceTask[]>(`/api/v1/marketplace/tasks?status=${encodeURIComponent(status)}`, { signal }),
  });
}

export function usePublishMarketplaceTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title: string;
      description: string;
      category: MarketplaceTaskCategory;
      reward: number;
      currency?: string;
    }) => apiFetch<MarketplaceTask>('/api/v1/marketplace/tasks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => invalidateMarketplaceQueries(qc),
  });
}

export function useAcceptMarketplaceTask(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { personaId: string; forkId?: string }) =>
      apiFetch<MarketplaceTask>(`/api/v1/marketplace/tasks/${encodeURIComponent(taskId)}/accept`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateMarketplaceQueries(qc),
  });
}

export function useCompleteMarketplaceTask(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { qualityScore: number; ownerTrainingHours?: number }) =>
      apiFetch<{
        task: MarketplaceTask;
        wallet: { balance: number; tokenBalance: number };
        persona: { id: string; growthIndex: number; reputation: number };
      }>(`/api/v1/marketplace/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateMarketplaceQueries(qc),
  });
}
