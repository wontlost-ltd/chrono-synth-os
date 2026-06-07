import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

interface OnboardingStatus {
  completed: boolean;
  completedAt: string | null;
}

export function useOnboardingStatus() {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: ({ signal }) => apiFetch<OnboardingStatus>('/api/v1/users/me/onboarding', { signal }),
  });
}

export function useCompleteOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<OnboardingStatus>('/api/v1/users/me/onboarding', {
        method: 'POST',
        body: JSON.stringify({ completed: true }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['onboarding'] }); },
  });
}
