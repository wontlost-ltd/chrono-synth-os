import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

interface UserProfile {
  userId: string;
  email: string;
  role: string;
  tenantId: string;
  createdAt: string;
}

export function useProfile() {
  return useQuery({
    queryKey: ['user', 'profile'],
    queryFn: ({ signal }) => apiFetch<UserProfile>('/api/v1/users/me', { signal }),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email?: string }) =>
      apiFetch<UserProfile>('/api/v1/users/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['user', 'profile'] }); },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      apiFetch<{ success: boolean }>('/api/v1/users/me/password', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
  });
}
