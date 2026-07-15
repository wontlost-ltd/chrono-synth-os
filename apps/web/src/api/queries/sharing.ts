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
    /* 后端分享端点是**单数** /share（POST）。 */
    mutationFn: (body: { userId: string; permission: ShareEntry['permission'] }) =>
      apiFetch<ShareEntry>(`/api/v1/simulations/${encodeURIComponent(simId)}/share`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shares', simId] }); },
  });
}

export function useRevokeShare(simId: string) {
  const qc = useQueryClient();
  return useMutation({
    /* 后端按**目标 userId** 取消分享（DELETE /share/:userId），不是 shareId。 */
    mutationFn: (targetUserId: string) =>
      apiFetch<void>(`/api/v1/simulations/${encodeURIComponent(simId)}/share/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shares', simId] }); },
  });
}
