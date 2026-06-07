/**
 * 待确认调用 API hooks (F3)
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface PendingConfirmation {
  invocationId: string;
  toolId: string;
  personaId: string;
  invokerType: 'mcp' | 'internal' | 'admin';
  confirmationTokenId: string | null;
  invokedAt: number;
  inputHash: string;
  status: string;
}

export function usePendingConfirmations(limit = 20, enabled = true) {
  return useQuery({
    queryKey: ['agent', 'confirmations', 'pending', limit],
    queryFn: ({ signal }) =>
      apiFetch<PendingConfirmation[]>(
        `/api/v1/agent/confirmations/pending?limit=${limit}`,
        { signal },
      ),
    enabled,
    refetchInterval: 30_000,
  });
}

export interface ApproveInput {
  tokenId: string;
  arguments: Record<string, unknown>;
  sessionId?: string;
}

export function useApproveConfirmation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApproveInput) => {
      const body: Record<string, unknown> = { arguments: input.arguments };
      if (input.sessionId) body.sessionId = input.sessionId;
      return apiFetch<unknown>(
        `/api/v1/agent/confirmations/${input.tokenId}/approve`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent', 'confirmations'] });
    },
  });
}

export function useRejectConfirmation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tokenId, reason }: { tokenId: string; reason?: string }) =>
      apiFetch<{ rejected: boolean }>(
        `/api/v1/agent/confirmations/${tokenId}/reject`,
        { method: 'POST', body: JSON.stringify({ reason: reason ?? 'user_rejected' }) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent', 'confirmations'] }),
  });
}
