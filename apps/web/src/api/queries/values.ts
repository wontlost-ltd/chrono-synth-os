import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { CoreValue } from '../../types';

export function useValues() {
  return useQuery({
    queryKey: ['values'],
    queryFn: ({ signal }) => apiFetch<CoreValue[]>('/api/v1/values', { signal }),
  });
}

export function useCreateValue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { label: string; weight: number }) =>
      apiFetch<CoreValue>('/api/v1/values', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['values'] }); },
  });
}
