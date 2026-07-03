/**
 * Tool Auto-Authorization admin page (ADR-0060 T7).
 *
 * Owner-facing operations for the tool auto-authorization bridge:
 *  - Run: process valid eligibility recommendations (whitelisted low-risk → auto-grant ToolPermission;
 *    others → create pending approval request).
 *  - Review pending tool authorization requests + approve/reject them.
 *
 * The governance whitelist itself (which tools are auto-authorizable) is configured on the
 * governance policy page (toolAutoAuthWhitelist field); this page only operates the bridge.
 * Backend enforces owner-only per-persona; this page is persona-scoped by a personaId input.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Button } from '../components/ui/Button';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  usePendingToolAuthorizations,
  useRunToolAutoAuth,
  useDecideToolAuthorization,
  type ToolAutoAuthRunResult,
} from '../api/queries/tool-auto-auth';

function formatTs(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

export function AdminToolAutoAuth() {
  const { t } = useTranslation();
  useDocumentTitle(t('toolAutoAuth.title'));

  const [personaId, setPersonaId] = useState('');
  const [lastRun, setLastRun] = useState<ToolAutoAuthRunResult | null>(null);

  const pending = usePendingToolAuthorizations(personaId || null);
  const run = useRunToolAutoAuth(personaId || null);
  const decide = useDecideToolAuthorization(personaId || null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('toolAutoAuth.title')}
        subtitle={t('toolAutoAuth.subtitle')}
        actions={
          <Button
            variant="primary"
            size="md"
            disabled={!personaId || run.isPending}
            onClick={async () => {
              const result = await run.mutateAsync();
              setLastRun(result);
            }}
          >
            {run.isPending ? t('toolAutoAuth.actions.running') : t('toolAutoAuth.actions.run')}
          </Button>
        }
      />

      <div className="flex items-center gap-2 text-sm">
        <input
          type="text"
          className="rounded border border-border bg-surface px-2 py-1 flex-1 max-w-md"
          placeholder={t('toolAutoAuth.filters.personaPlaceholder')}
          value={personaId}
          onChange={(e) => { setPersonaId(e.target.value); setLastRun(null); }}
        />
      </div>

      {run.error && (
        <EmptyState variant="error" message={t('toolAutoAuth.errors.runFailed', { message: (run.error as Error).message })} />
      )}

      {lastRun && (
        <section className="rounded border border-border bg-surface p-4 space-y-2 text-sm">
          <h2 className="font-medium">{t('toolAutoAuth.runResult.title')}</h2>
          <p>{t('toolAutoAuth.runResult.granted', { count: lastRun.granted.length })}</p>
          <p>{t('toolAutoAuth.runResult.requested', { count: lastRun.requested.length })}</p>
          <p>{t('toolAutoAuth.runResult.skipped', { count: lastRun.skipped.length })}</p>
          {lastRun.granted.length > 0 && (
            <ul className="list-disc pl-5 text-secondary">
              {lastRun.granted.map((g) => (
                <li key={g.toolId}>
                  {g.toolId} — {g.capability} · {t('toolAutoAuth.runResult.expiresAt', { at: formatTs(g.expiresAt) })}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t('toolAutoAuth.pending.title')}</h2>
        <p className="text-xs text-secondary">{t('toolAutoAuth.pending.approveHint')}</p>
        {!personaId ? (
          <EmptyState message={t('toolAutoAuth.empty.enterPersona')} />
        ) : pending.isLoading ? (
          <Skeleton variant="card" />
        ) : pending.error ? (
          <EmptyState variant="error" message={t('toolAutoAuth.errors.loadFailed', { message: (pending.error as Error).message })} />
        ) : (pending.data ?? []).length === 0 ? (
          <EmptyState message={t('toolAutoAuth.empty.noPending')} />
        ) : (
          <ul className="space-y-3">
            {pending.data!.map((req) => (
              <li key={req.id} className="rounded border border-border bg-surface p-4 flex items-start justify-between gap-4">
                <div className="space-y-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{req.toolId}</span>
                    <StatusBadge status={req.riskClass === 'high' ? 'error' : 'active'} label={req.riskClass} />
                  </div>
                  <div className="text-secondary">
                    {req.capability} · {t('toolAutoAuth.pending.reason', { reason: req.reason })} · {formatTs(req.requestedAt)}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="success"
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ requestId: req.id, decision: 'approved' })}
                  >
                    {t('toolAutoAuth.actions.approve')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ requestId: req.id, decision: 'rejected' })}
                  >
                    {t('toolAutoAuth.actions.reject')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
