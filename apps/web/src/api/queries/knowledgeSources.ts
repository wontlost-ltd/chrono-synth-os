import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export type KnowledgeSourceType = 'rss' | 'api' | 'file' | 'manual' | 'llm';

export interface KnowledgeSource {
  id: string;
  type: KnowledgeSourceType;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  lastSyncAt?: string;
  itemCount?: number;
  status?: string;
  createdAt: string;
  updatedAt: string;
}

interface CreateKnowledgeSourceDto {
  type: KnowledgeSourceType;
  name: string;
  config: Record<string, unknown>;
}

interface UpdateKnowledgeSourceDto {
  name?: string;
  type?: KnowledgeSourceType;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export function useKnowledgeSources() {
  return useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: ({ signal }) => apiFetch<KnowledgeSource[]>('/api/v1/knowledge-sources', { signal }),
  });
}

export function useKnowledgeSource(id: string) {
  return useQuery({
    queryKey: ['knowledge-sources', id],
    queryFn: ({ signal }) => apiFetch<KnowledgeSource>(`/api/v1/knowledge-sources/${encodeURIComponent(id)}`, { signal }),
    enabled: !!id,
  });
}

export function useCreateKnowledgeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateKnowledgeSourceDto) =>
      apiFetch<KnowledgeSource>('/api/v1/knowledge-sources', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge-sources'] }); },
  });
}

export function useUpdateKnowledgeSource(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateKnowledgeSourceDto) =>
      apiFetch<KnowledgeSource>(`/api/v1/knowledge-sources/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge-sources'] });
      qc.invalidateQueries({ queryKey: ['knowledge-sources', id] });
    },
  });
}

export function useDeleteKnowledgeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/knowledge-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge-sources'] }); },
  });
}

export function useSyncKnowledgeSource(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/knowledge-sources/${id}/sync`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge-sources', id] }); },
  });
}
