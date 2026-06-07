import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../client';

export function useInstallAvatar(deviceId: string) {
  return useMutation({
    mutationFn: (avatarId: string) =>
      apiFetch<void>(`/api/v1/devices/${encodeURIComponent(deviceId)}/install`, {
        method: 'POST',
        body: JSON.stringify({ avatarId }),
      }),
  });
}
