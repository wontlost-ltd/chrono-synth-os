/**
 * AI 安全治理 API hooks（T0-B：人格漂移监测 + 告警）
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../client';

export type DriftAlertLevel = 'ok' | 'warning' | 'critical';

export interface DriftValueDelta {
  valueId: string;
  label: string;
  baseline: number;
  current: number;
  delta: number;
  alertLevel: DriftAlertLevel;
}

export interface DriftReport {
  reportId: string;
  tenantId: string;
  baselineSnapshotId: string | null;
  analyzedAt: number;
  valueDrifts: DriftValueDelta[];
  overallDriftScore: number;
  alertLevel: DriftAlertLevel;
  /** 仅 POST /drift-report 后由 service 注入 */
  alertEmitted?: boolean;
  auditId?: string | null;
}

export function useLatestDriftReport(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'safety', 'drift-report'],
    queryFn: async ({ signal }) => {
      try {
        return await apiFetch<DriftReport>('/api/v1/admin/safety/drift-report', { signal });
      } catch (err) {
        /* 404 = 还没生成过报告，前端展示 EmptyState 而非错误 */
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled,
  });
}

export function useGenerateDriftReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<DriftReport>('/api/v1/admin/safety/drift-report', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'safety', 'drift-report'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'safety', 'status'] });
    },
  });
}

export interface SafetyStatusSummary {
  memoryConfidence: {
    /** 服务端字段名为 totalCount（string 序列化的 bigint） */
    totalCount: string | number;
    unverifiedCount: number;
    unverifiedRatio?: number;
    bySourceKind: Record<string, number>;
  };
  /** 服务端字段名为 personaDrift */
  personaDrift: {
    /** 服务端字段名为 lastReport */
    lastReport: DriftReport | null;
    recentAlerts: Array<{
      reportId: string;
      analyzedAt: number;
      alertLevel: DriftAlertLevel;
      overallDriftScore: number;
    }>;
  };
  /** 0–100，越高越安全 */
  safetyScore: number;
}

export function useSafetyStatus(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'safety', 'status'],
    queryFn: ({ signal }) =>
      apiFetch<SafetyStatusSummary>('/api/v1/admin/safety/status', { signal }),
    enabled,
  });
}
