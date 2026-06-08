/**
 * 用户级 Google OAuth API hooks (F2)
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface UserOauthTokenMeta {
  id: string;
  tenantId: string;
  userId: string;
  provider: 'google';
  scope: string;
  accessExpiresAt: number;
  grantedAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export function useUserOauthTokens(enabled = true) {
  return useQuery({
    queryKey: ['agent', 'oauth', 'google'],
    queryFn: ({ signal }) =>
      apiFetch<UserOauthTokenMeta[]>('/api/v1/agent/oauth/google', { signal }),
    enabled,
  });
}

export interface AuthorizeUrlInput {
  scope: string;
  redirectAfter?: string;
}

/**
 * Returns the authorize URL the user must navigate to. Does NOT actually
 * redirect — caller decides whether to window.open() or window.location.assign().
 */
export function useStartGoogleAuthorize() {
  return useMutation({
    mutationFn: (input: AuthorizeUrlInput) =>
      apiFetch<{ authorizeUrl: string }>(
        '/api/v1/agent/oauth/google/authorize',
        { method: 'POST', body: JSON.stringify(input) },
      ),
  });
}

export function useRevokeGoogleToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      apiFetch<void>(`/api/v1/agent/oauth/google/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: reason ?? 'user_initiated' }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent', 'oauth', 'google'] }),
  });
}

/* Common scopes the UI surfaces. Backend whitelists these and a couple more. */
export const GOOGLE_SCOPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'https://www.googleapis.com/auth/calendar', label: 'Calendar (read/write)' },
  { value: 'https://www.googleapis.com/auth/calendar.readonly', label: 'Calendar (read-only)' },
  { value: 'https://www.googleapis.com/auth/calendar.events', label: 'Calendar — events only' },
  { value: 'https://www.googleapis.com/auth/gmail.send', label: 'Gmail send' },
];
