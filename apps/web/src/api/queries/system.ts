import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';

interface HealthCheck {
  status: string;
  uptime: number;
}

export function useHealthz() {
  return useQuery({
    queryKey: ['healthz'],
    queryFn: ({ signal }) => apiFetch<HealthCheck>('/healthz', { signal }),
    refetchInterval: 30_000,
  });
}

export function useReadyz() {
  return useQuery({
    queryKey: ['readyz'],
    queryFn: ({ signal }) => apiFetch<HealthCheck>('/readyz', { signal }),
    refetchInterval: 30_000,
  });
}

export function usePosSummary() {
  return useQuery({
    queryKey: ['pos', 'summary'],
    queryFn: ({ signal }) => apiFetch<{ summary: string }>('/api/v1/pos/state/summary', { signal }),
  });
}
