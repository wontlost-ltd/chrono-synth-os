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

/* ── persona 双边流程（ADR-0058）：申请 / 列申请者 / 发布者委派给 persona ── */

export interface TaskApplicant {
  id: string;
  taskId: string;
  personaId: string;
  personaName: string | null;
  rankingScore: number;
  status: string;
  createdAt: number;
}

/** persona 申请一个 open 工单（persona owner）。 */
export function useApplyToTask(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { personaId: string }) =>
      apiFetch(`/api/v1/tasks/${encodeURIComponent(taskId)}/apply`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidateMarketplaceQueries(qc); qc.invalidateQueries({ queryKey: ['task-applicants', taskId] }); },
  });
}

/** 发布者把工单委派给某 persona（发布者鉴权在后端：actor===publisher）。 */
export function useAssignTask(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { personaId: string }) =>
      apiFetch(`/api/v1/tasks/${encodeURIComponent(taskId)}/assign`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidateMarketplaceQueries(qc); qc.invalidateQueries({ queryKey: ['task-applicants', taskId] }); },
  });
}

/** 列某工单的 persona 申请者（含 personaName）——发布者据此选委派给谁。 */
export function useTaskApplicants(taskId: string) {
  return useQuery({
    queryKey: ['task-applicants', taskId],
    enabled: taskId.length > 0,
    queryFn: ({ signal }) => apiFetch<TaskApplicant[]>(`/api/v1/tasks/${encodeURIComponent(taskId)}/applicants`, { signal }),
  });
}
