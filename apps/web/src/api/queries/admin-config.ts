/**
 * 管理后台配置 API hooks
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

interface ConfigItem {
  key: string;
  value: unknown;
  category: string;
  requiresRestart: boolean;
  groupKey: string;
  updatedAt: number;
  updatedBy: string;
}

interface ConfigAuditEntry {
  key: string;
  old_value_json: string;
  new_value_json: string;
  changed_by: string;
  changed_at: number;
}

interface ApplyPatchResult {
  updated: number;
  requiresRestart: string[];
}

interface AdminConfigResponse {
  items: ConfigItem[];
  effective: Record<string, unknown>;
}

/** 将 effective 对象中未出现在 items 里的键补为默认 ConfigItem */
function mergeEffective(resp: AdminConfigResponse): ConfigItem[] {
  const itemKeys = new Set(resp.items.map(i => i.key));
  const fromEffective: ConfigItem[] = Object.entries(resp.effective)
    .filter(([k]) => !itemKeys.has(k))
    .map(([k, v]) => ({
      key: k,
      value: v,
      category: 'default',
      requiresRestart: false,
      groupKey: k.split('.')[0] ?? k,
      updatedAt: 0,
      updatedBy: 'system',
    }));
  return [...resp.items, ...fromEffective];
}

export function useAdminConfig(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'config'],
    queryFn: async ({ signal }) => {
      const resp = await apiFetch<AdminConfigResponse>('/api/v1/admin/config', { signal });
      return mergeEffective(resp);
    },
    enabled,
  });
}

export function useAdminConfigAudit(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'config', 'audit'],
    queryFn: ({ signal }) => apiFetch<ConfigAuditEntry[]>('/api/v1/admin/config/audit', { signal }),
    enabled,
  });
}

export function useApplyConfigPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch<ApplyPatchResult>('/api/v1/admin/config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'config'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'config', 'audit'] });
    },
  });
}
