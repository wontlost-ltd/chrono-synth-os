import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client';

export interface ConflictItem {
  id: string;
  tenantId: string;
  eventKind: string;
  conflictType: string;
  objectType: string;
  objectId: string;
  localVersion: number;
  remoteVersion: number;
  localData: unknown;
  remoteData: unknown;
  detectedAt: number;
  status: 'pending' | 'resolved' | 'dismissed';
}

export function useConflictInbox(enabled = true) {
  return useQuery({
    queryKey: ['conflicts', 'inbox', 'pending'],
    queryFn: () => apiFetch<ConflictItem[]>('/api/v1/conflicts/inbox?status=pending'),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
  });
}
