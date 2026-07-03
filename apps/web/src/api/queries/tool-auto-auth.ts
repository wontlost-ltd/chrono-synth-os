/**
 * ADR-0060 T7 工具自动授权运营 API 查询钩子（owner-only，per-persona）。
 *
 * 对接后端 /api/v1/persona-core/:personaId/tool-auto-auth/{run,pending,requests/:id/decide}。
 * run=据资格自动授权（白名单低险授权/其余建待审批）；pending=待审批列表；decide=批准/拒绝。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface ToolAutoAuthGranted {
  toolId: string;
  capability: string;
  permissionId: string;
  expiresAt: number;
}
export interface ToolAutoAuthRequested {
  toolId: string;
  capability: string;
  reason: string;
}
export interface ToolAutoAuthRunResult {
  granted: ToolAutoAuthGranted[];
  requested: ToolAutoAuthRequested[];
  skipped: { toolId: string; capability: string }[];
}

export interface PendingToolAuthorization {
  id: string;
  personaId: string;
  capability: string;
  toolId: string;
  sourceRuleVersion: string;
  riskClass: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

const pendingKey = (personaId: string) => ['tool-auto-auth', 'pending', personaId] as const;

/** 待审批工具授权请求列表。 */
export function usePendingToolAuthorizations(personaId: string | null, enabled = true) {
  return useQuery({
    queryKey: pendingKey(personaId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<PendingToolAuthorization[]>(
        `/api/v1/persona-core/${personaId}/tool-auto-auth/pending`,
        { signal },
      ),
    enabled: enabled && !!personaId,
  });
}

/** 触发一次据资格自动授权处理。 */
export function useRunToolAutoAuth(personaId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ToolAutoAuthRunResult>(
        `/api/v1/persona-core/${personaId}/tool-auto-auth/run`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pendingKey(personaId ?? '') });
    },
  });
}

/** 决议一条待审批请求。 */
export function useDecideToolAuthorization(personaId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, decision }: { requestId: string; decision: 'approved' | 'rejected' }) =>
      apiFetch<{ requestId: string; decision: string }>(
        `/api/v1/persona-core/${personaId}/tool-auto-auth/requests/${requestId}/decide`,
        { method: 'POST', body: JSON.stringify({ decision }) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pendingKey(personaId ?? '') });
    },
  });
}
