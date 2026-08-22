import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, unwrapList } from '../client';

export interface AutorunConfig {
  enabled: boolean;
  intervalMinutes: number;
  driftThreshold: number;
  reviewRequired: boolean;
  knowledgeSourceIds: string[];
}

export interface AutorunRun {
  id: string;
  avatarId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'review_required';
  startedAt: string;
  completedAt?: string;
  itemsProcessed?: number;
  driftDetected?: boolean;
  error?: string;
}

interface ReviewDecision {
  path: string;
  action: 'accept' | 'reject' | 'modify';
  value?: unknown;
}

interface ReviewDto {
  decisions: ReviewDecision[];
  comment?: string;
}

export function useAutorunConfig(avatarId: string) {
  return useQuery({
    queryKey: ['autorun', avatarId],
    queryFn: ({ signal }) => apiFetch<AutorunConfig>(`/api/v1/avatars/${encodeURIComponent(avatarId)}/autorun`, { signal }),
    enabled: !!avatarId,
  });
}

export function useUpdateAutorunConfig(avatarId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AutorunConfig) =>
      apiFetch<AutorunConfig>(`/api/v1/avatars/${encodeURIComponent(avatarId)}/autorun`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['autorun', avatarId] }); },
  });
}

export function useTriggerAutorun(avatarId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceIds: string[] | void) =>
      apiFetch<void>(`/api/v1/avatars/${encodeURIComponent(avatarId)}/autorun/trigger`, {
        method: 'POST',
        body: JSON.stringify(sourceIds ? { sourceIds } : {}),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['autorun-runs', avatarId] }); },
  });
}

export function useAutorunRuns(avatarId: string) {
  return useQuery({
    queryKey: ['autorun-runs', avatarId],
    /* ⚠️ 审计 P3：同 knowledgeSources —— 服务端返回 {data,pagination}，
     * apiFetch 只对单键 {data} 自动解包。此前直接标注成 AutorunRun[]，
     * 运行时拿到对象 → AutorunRunsPage **永远显示「暂无运行记录」**，
     * 用户会误以为 autorun 坏了并反复手动触发。 */
    queryFn: ({ signal }) => apiFetch<unknown>(`/api/v1/avatars/${encodeURIComponent(avatarId)}/autorun/runs`, { signal })
      .then(unwrapList<AutorunRun>),
    enabled: !!avatarId,
  });
}

export function useReviewRun(avatarId: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReviewDto) =>
      apiFetch<void>(`/api/v1/avatars/${encodeURIComponent(avatarId)}/autorun/runs/${encodeURIComponent(runId)}/review`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['autorun-runs', avatarId] }); },
  });
}
