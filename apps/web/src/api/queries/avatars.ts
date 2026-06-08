import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface Avatar {
  id: string;
  label: string;
  kind: 'general' | 'work' | 'social' | 'family' | 'creative';
  status: string;
  deviceCount?: number;
  lastSnapshot?: string;
  behaviorOverrides?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface CreateAvatarDto {
  label: string;
  kind?: Avatar['kind'];
  behaviorOverrides?: Record<string, unknown>;
}

type UpdateAvatarDto = Partial<CreateAvatarDto>;

export function useAvatars() {
  return useQuery({
    queryKey: ['avatars'],
    queryFn: ({ signal }) => apiFetch<Avatar[]>('/api/v1/avatars', { signal }),
  });
}

export function useAvatar(id: string) {
  return useQuery({
    queryKey: ['avatars', id],
    queryFn: ({ signal }) => apiFetch<Avatar>(`/api/v1/avatars/${encodeURIComponent(id)}`, { signal }),
    enabled: !!id,
  });
}

export function useCreateAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAvatarDto) =>
      apiFetch<Avatar>('/api/v1/avatars', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['avatars'] }); },
  });
}

export function useUpdateAvatar(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAvatarDto) =>
      apiFetch<Avatar>(`/api/v1/avatars/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['avatars'] });
      qc.invalidateQueries({ queryKey: ['avatars', id] });
    },
  });
}

export function useDeleteAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/avatars/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['avatars'] }); },
  });
}

export function useProjectAvatar(id: string) {
  return useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/v1/avatars/${id}/project`, { method: 'POST' }),
  });
}
