/**
 * 用户级 Google OAuth 管理 (F2 — desktop parity).
 *
 * 通过配置的 chrono-synth-os HTTP API 调用；授权流程会跳出 Tauri 窗口
 * 到 Google 同意页，回来时由后端 callback 路由处理。
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiNotConfiguredError, apiFetch } from '@/bridge/http-client';

interface UserOauthTokenMeta {
  id: string;
  scope: string;
  accessExpiresAt: number;
  grantedAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

interface Envelope<T> { data: T }

const GOOGLE_SCOPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'https://www.googleapis.com/auth/calendar', label: 'Calendar (read/write)' },
  { value: 'https://www.googleapis.com/auth/calendar.readonly', label: 'Calendar (read-only)' },
  { value: 'https://www.googleapis.com/auth/calendar.events', label: 'Calendar — events only' },
  { value: 'https://www.googleapis.com/auth/gmail.send', label: 'Gmail send' },
];

function shortenScope(s: string): string {
  return s.replace('https://www.googleapis.com/auth/', '');
}

function formatTs(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

export function AgentOauthGooglePage() {
  const queryClient = useQueryClient();

  const tokens = useQuery({
    queryKey: ['agentOauthGoogle'],
    queryFn: async () => {
      const r = await apiFetch<Envelope<UserOauthTokenMeta[]>>('/api/v1/agent/oauth/google');
      return r.data;
    },
  });

  const startAuthorize = useMutation({
    mutationFn: async (scope: string) => {
      const r = await apiFetch<Envelope<{ authorizeUrl: string }>>(
        '/api/v1/agent/oauth/google/authorize',
        { method: 'POST', body: { scope, redirectAfter: '/' } },
      );
      return r.data;
    },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch<void>(`/api/v1/agent/oauth/google/${id}`, {
        method: 'DELETE',
        body: { reason: 'user_initiated' },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agentOauthGoogle'] }),
  });

  const grantedScopes = useMemo(
    () => new Set((tokens.data ?? []).filter((t) => !t.revokedAt).map((t) => t.scope)),
    [tokens.data],
  );

  const isApiMissing = tokens.error instanceof ApiNotConfiguredError;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Google 账户授权</h1>
        <p className="mt-1 text-sm text-chrono-text-muted">
          授予 Chrono Synth 代表你访问 Calendar / Gmail 的权限；可随时撤销。
        </p>
      </header>

      {isApiMissing && <NotConfiguredBanner />}

      <section className="rounded-xl border border-chrono-border bg-chrono-elevated p-4 space-y-2">
        <h2 className="text-base font-semibold">添加新授权</h2>
        <ul className="space-y-2">
          {GOOGLE_SCOPES.map((s) => {
            const granted = grantedScopes.has(s.value);
            return (
              <li key={s.value} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">{s.label}</p>
                  <p className="font-mono text-xs text-chrono-text-muted truncate">{s.value}</p>
                </div>
                <button
                  type="button"
                  className={clsx(
                    'rounded border border-chrono-border bg-chrono-elevated px-3 py-1 text-sm',
                    (granted || startAuthorize.isPending) && 'opacity-60',
                  )}
                  disabled={granted || startAuthorize.isPending}
                  onClick={async () => {
                    const r = await startAuthorize.mutateAsync(s.value);
                    if (typeof window !== 'undefined') {
                      window.open(r.authorizeUrl, '_blank', 'noopener,noreferrer');
                    }
                  }}
                >
                  {granted ? '已授权' : startAuthorize.isPending ? '准备中…' : '授权'}
                </button>
              </li>
            );
          })}
        </ul>
        {startAuthorize.error && !(startAuthorize.error instanceof ApiNotConfiguredError) && (
          <p className="text-xs text-red-300">
            授权启动失败：{(startAuthorize.error as Error).message}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">已授权 scope</h2>
        {tokens.isLoading && <p className="text-sm text-chrono-text-muted">加载中…</p>}
        {tokens.error && !isApiMissing && (
          <p className="text-sm text-red-300">加载失败：{(tokens.error as Error).message}</p>
        )}
        {!tokens.isLoading && !tokens.error && (tokens.data ?? []).length === 0 && (
          <p className="text-sm text-chrono-text-muted">还没有授权任何 Google scope。</p>
        )}
        {!tokens.isLoading && (tokens.data ?? []).length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left border-b border-chrono-border">
              <tr>
                <th className="py-2">Scope</th>
                <th className="py-2">Granted</th>
                <th className="py-2">Expires</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {tokens.data!.map((t) => (
                <tr key={t.id} className="border-b border-chrono-border/50">
                  <td className="py-2 font-mono text-xs">{shortenScope(t.scope)}</td>
                  <td className="py-2 text-xs">{formatTs(t.grantedAt)}</td>
                  <td className="py-2 text-xs">{formatTs(t.accessExpiresAt)}</td>
                  <td className="py-2">
                    {t.revokedAt === null && (
                      <button
                        type="button"
                        className="text-xs text-red-300 hover:underline"
                        disabled={revoke.isPending}
                        onClick={() => {
                          if (!window.confirm(`撤销 ${shortenScope(t.scope)} 授权？`)) return;
                          revoke.mutate(t.id);
                        }}
                      >
                        撤销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function NotConfiguredBanner() {
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
      <p className="font-medium">未配置 chrono-synth-os API</p>
      <p className="mt-1 text-xs">
        在 Settings → API 中填入 base URL 和 JWT；本页面通过 HTTP 调用 OAuth 端点。
      </p>
    </div>
  );
}
