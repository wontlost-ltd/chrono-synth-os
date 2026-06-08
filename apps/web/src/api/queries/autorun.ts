import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

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
    queryFn: ({ signal }) => apiFetch<AutorunRun[]>(`/api/v1/avatars/${encodeURIComponent(avatarId)}/autorun/runs`, { signal }),
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
