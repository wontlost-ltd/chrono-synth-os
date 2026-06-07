import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface MemoryNode {
  id: string;
  kind: 'episodic' | 'semantic' | 'procedural';
  content: string;
  valence: number;
  salience: number;
  createdAt: string;
}

export interface MemoryLink {
  source: string;
  target: string;
  relation: string;
  strength: number;
}

export interface RelatedMemoryGraph {
  nodes: MemoryNode[];
  links: MemoryLink[];
}

export function useRelatedMemories(id: string, depth = 2) {
  return useQuery({
    queryKey: ['memories', id, 'related', depth],
    queryFn: ({ signal }) =>
      apiFetch<RelatedMemoryGraph>(`/api/v1/memories/${encodeURIComponent(id)}/related?depth=${encodeURIComponent(String(depth))}`, { signal }),
    enabled: !!id,
  });
}

export function useLinkMemories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { source: string; target: string; relation: string; strength: number }) =>
      apiFetch<void>('/api/v1/memories/link', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['memories'] }); },
  });
}
