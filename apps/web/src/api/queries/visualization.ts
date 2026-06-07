import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type {
  OverviewData,
  PathsData,
  BranchesData,
  StressComparisonData,
  MilestonesData,
  Resolution,
} from '../../types';

export function useOverview(simId: string) {
  return useQuery({
    queryKey: ['visualization', 'overview', simId],
    queryFn: ({ signal }) => apiFetch<OverviewData>(`/api/v1/simulations/${encodeURIComponent(simId)}/visualization/overview`, { signal }),
    enabled: !!simId,
  });
}

export function usePaths(simId: string, metrics?: string, resolution?: Resolution) {
  const params = new URLSearchParams();
  if (metrics) params.set('metrics', metrics);
  if (resolution) params.set('resolution', resolution);
  const qs = params.toString();

  return useQuery({
    queryKey: ['visualization', 'paths', simId, metrics, resolution],
    queryFn: ({ signal }) => apiFetch<PathsData>(`/api/v1/simulations/${encodeURIComponent(simId)}/visualization/paths${qs ? `?${qs}` : ''}`, { signal }),
    enabled: !!simId,
  });
}

export function useBranches(simId: string, pathId: string) {
  return useQuery({
    queryKey: ['visualization', 'branches', simId, pathId],
    queryFn: ({ signal }) => apiFetch<BranchesData>(`/api/v1/simulations/${encodeURIComponent(simId)}/visualization/branches/${encodeURIComponent(pathId)}`, { signal }),
    enabled: !!simId && !!pathId,
  });
}

export function useStressComparison(simId: string) {
  return useQuery({
    queryKey: ['visualization', 'stress-comparison', simId],
    queryFn: ({ signal }) => apiFetch<StressComparisonData>(`/api/v1/simulations/${encodeURIComponent(simId)}/visualization/stress-comparison`, { signal }),
    enabled: !!simId,
  });
}

export function useMilestones(simId: string, metrics?: string) {
  const params = new URLSearchParams();
  if (metrics) params.set('metrics', metrics);
  const qs = params.toString();

  return useQuery({
    queryKey: ['visualization', 'milestones', simId, metrics],
    queryFn: ({ signal }) => apiFetch<MilestonesData>(`/api/v1/simulations/${encodeURIComponent(simId)}/visualization/milestones${qs ? `?${qs}` : ''}`, { signal }),
    enabled: !!simId,
  });
}
