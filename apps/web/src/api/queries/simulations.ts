import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';
import type { SimulationStatus, CreateSimulationRequest, CreateStressTestRequest } from '../../types';

/** 模拟列表条目（来自 GET /api/v1/simulations） */
export interface SimulationListItem {
  simulationId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt: number | null;
}

interface PaginatedResponse<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export function useSimulationList(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: ['simulations', 'list', page, pageSize],
    queryFn: async ({ signal }) => {
      /* apiFetch 会自动取 json.data，但我们也需要 pagination，所以用原生 fetch */
      const res = await apiFetch<SimulationListItem[] | PaginatedResponse<SimulationListItem>>(
        `/api/v1/simulations?page=${page}&pageSize=${pageSize}`,
        { signal },
      );
      /* apiFetch 返回 data (数组) 或完整结构，归一化 */
      if (Array.isArray(res)) {
        return { data: res, pagination: { page, pageSize, total: res.length, totalPages: 1 } };
      }
      return res as PaginatedResponse<SimulationListItem>;
    },
  });
}

export function useSimulation(simId: string) {
  return useQuery({
    queryKey: ['simulation', simId],
    queryFn: ({ signal }) => apiFetch<SimulationStatus>(`/api/v1/simulations/${encodeURIComponent(simId)}`, { signal }),
    enabled: !!simId,
  });
}

export function useCreateSimulation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSimulationRequest) =>
      apiFetch<{ simulationId: string }>('/api/v1/simulations/life', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['simulation'] }); },
  });
}

export function useCancelTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      apiFetch<{ taskId: string; cancelled: boolean }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['simulations'] });
      qc.invalidateQueries({ queryKey: ['simulation'] });
    },
  });
}

export function useCreateStressTest(simId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateStressTestRequest) =>
      apiFetch<{ simulationId: string }>(`/api/v1/simulations/${encodeURIComponent(simId)}/stress-test`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['visualization', 'stress-comparison', simId] });
    },
  });
}
