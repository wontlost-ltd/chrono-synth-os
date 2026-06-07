import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface ShareEntry {
  id: string;
  targetUserId: string;
  targetUserName?: string;
  permission: 'view' | 'edit' | 'admin';
  createdAt: string;
}

export function useSimulationShares(simId: string) {
  return useQuery({
    queryKey: ['shares', simId],
    queryFn: ({ signal }) =>
      apiFetch<ShareEntry[]>(`/api/v1/simulations/${encodeURIComponent(simId)}/shares`, { signal }),
    enabled: !!simId,
  });
}

export function useShareSimulation(simId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { userId: string; permission: ShareEntry['permission'] }) =>
      apiFetch<ShareEntry>(`/api/v1/simulations/${encodeURIComponent(simId)}/shares`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shares', simId] }); },
  });
}

export function useRevokeShare(simId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      apiFetch<void>(`/api/v1/simulations/${encodeURIComponent(simId)}/shares/${encodeURIComponent(shareId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shares', simId] }); },
  });
}
