/**
 * 用户级 Google OAuth 授权管理 (F2).
 *
 * 不同于其他 admin 页：这是终端用户自己管理自己的 Google 凭据，所有
 * 登录用户都能访问。授权流程会跳出当前域到 Google 同意页，回来时由
 * 后端的 callback 路由 /api/v1/agent/oauth/google/callback 处理。
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useUserOauthTokens,
  useStartGoogleAuthorize,
  useRevokeGoogleToken,
  GOOGLE_SCOPES,
  type UserOauthTokenMeta,
} from '../api/queries/agent-oauth';

function formatTs(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

function tokenStatus(token: UserOauthTokenMeta): 'active' | 'paused' | 'error' {
  if (token.revokedAt !== null) return 'error';
  if (token.accessExpiresAt < Date.now()) return 'paused';
  return 'active';
}

function tokenStatusLabel(token: UserOauthTokenMeta, t: TFunction): string {
  if (token.revokedAt !== null) return t('agentOauthGoogle.statusLabels.revoked');
  if (token.accessExpiresAt < Date.now()) return t('agentOauthGoogle.statusLabels.expired');
  return t('agentOauthGoogle.statusLabels.active');
}

function shortenScope(scope: string): string {
  return scope.replace('https://www.googleapis.com/auth/', '');
}

export function AgentOauthGoogle() {
  const { t } = useTranslation();
  useDocumentTitle(t('agentOauthGoogle.documentTitle'));

  const tokens = useUserOauthTokens();
  const start = useStartGoogleAuthorize();
  const revoke = useRevokeGoogleToken();

  const grantedScopes = new Set((tokens.data ?? []).filter((tok) => !tok.revokedAt).map((tok) => tok.scope));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('agentOauthGoogle.title')}
        subtitle={t('agentOauthGoogle.subtitle')}
      />

      <section className="rounded-xl border border-border bg-surface-elevated p-4 space-y-3">
        <h2 className="text-base font-semibold">{t('agentOauthGoogle.addSection.heading')}</h2>
        <ul className="space-y-2">
          {GOOGLE_SCOPES.map((s) => {
            const granted = grantedScopes.has(s.value);
            return (
              <li key={s.value} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">{s.label}</p>
                  <p className="font-mono text-xs text-text-secondary truncate">{s.value}</p>
                </div>
                <button
                  type="button"
                  className="rounded border border-border bg-surface px-3 py-1 text-sm hover:bg-surface/80 disabled:opacity-50"
                  disabled={granted || start.isPending}
                  onClick={() => {
                    /* Use mutate (fire-and-forget) — errors land in `start.error`
                     * for the banner below; never `mutateAsync` here because the
                     * rejection would propagate out as an unhandled promise. */
                    start.mutate(
                      { scope: s.value, redirectAfter: '/agent/oauth/google' },
                      {
                        onSuccess: (result) => {
                          if (typeof window !== 'undefined') {
                            window.location.assign(result.authorizeUrl);
                          }
                        },
                      },
                    );
                  }}
                >
                  {granted
                    ? t('agentOauthGoogle.addSection.authorized')
                    : start.isPending
                    ? t('agentOauthGoogle.addSection.authorizing')
                    : t('agentOauthGoogle.addSection.authorize')}
                </button>
              </li>
            );
          })}
        </ul>
        {start.error && (
          <p className="text-xs text-warning">
            {t('agentOauthGoogle.addSection.startError', { message: (start.error as Error).message })}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t('agentOauthGoogle.list.heading')}</h2>
        {tokens.isLoading ? (
          <Skeleton variant="card" />
        ) : tokens.error ? (
          <EmptyState
            variant="error"
            message={t('agentOauthGoogle.list.loadFailed', { message: (tokens.error as Error).message })}
          />
        ) : (tokens.data ?? []).length === 0 ? (
          <EmptyState message={t('agentOauthGoogle.list.empty')} />
        ) : (
          <div className="rounded-xl border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left border-b border-border bg-surface">
                <tr>
                  <th className="p-3">{t('agentOauthGoogle.table.scope')}</th>
                  <th className="p-3">{t('agentOauthGoogle.table.status')}</th>
                  <th className="p-3">{t('agentOauthGoogle.table.granted')}</th>
                  <th className="p-3">{t('agentOauthGoogle.table.expires')}</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {tokens.data!.map((tok) => (
                  <tr key={tok.id} className="border-b border-border/50">
                    <td className="p-3 font-mono text-xs">{shortenScope(tok.scope)}</td>
                    <td className="p-3">
                      <StatusBadge status={tokenStatus(tok)} label={tokenStatusLabel(tok, t)} />
                    </td>
                    <td className="p-3 text-xs">{formatTs(tok.grantedAt)}</td>
                    <td className="p-3 text-xs">{formatTs(tok.accessExpiresAt)}</td>
                    <td className="p-3">
                      {tok.revokedAt === null && (
                        <button
                          type="button"
                          className="text-xs text-warning hover:underline"
                          disabled={revoke.isPending}
                          onClick={() => {
                            if (!window.confirm(t('agentOauthGoogle.list.revokeConfirm', { scope: shortenScope(tok.scope) }))) return;
                            revoke.mutate({ id: tok.id });
                          }}
                        >
                          {t('agentOauthGoogle.list.revoke')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
