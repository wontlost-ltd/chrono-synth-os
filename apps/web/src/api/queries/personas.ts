import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface Persona {
  id: string;
  label: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  resourceQuota: number;
  createdAt: string;
}

export function usePersonas() {
  return useQuery({
    queryKey: ['personas'],
    queryFn: ({ signal }) => apiFetch<Persona[]>('/api/v1/personas', { signal }),
  });
}

export function useForkPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { label: string; resourceQuota?: number }) =>
      apiFetch<Persona>('/api/v1/personas/fork', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['personas'] }); },
  });
}

export function useSimulatePersona() {
  return useMutation({
    mutationFn: (body: { personaId: string; scenario: { id: string; description: string; params?: Record<string, unknown> } }) =>
      apiFetch<unknown>('/api/v1/personas/simulate', { method: 'POST', body: JSON.stringify(body) }),
  });
}

export function useUpdatePersonaStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: Persona['status']) =>
      apiFetch<void>(`/api/v1/personas/${encodeURIComponent(id)}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['personas'] }); },
  });
}
