/**
 * Tool Invocations history (audit-style read-only view).
 * Backend: GET /api/v1/admin/personas/:personaId/tool-invocations?limit
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../hooks/useAuth';
import { useToolInvocations, type ToolInvocation } from '../api/queries/agent-tools';

const STATUS_VARIANT: Record<string, 'completed' | 'paused' | 'error' | 'syncing'> = {
  success: 'completed',
  pending_confirmation: 'paused',
  failed: 'error',
  denied_permission: 'error',
  denied_quota: 'error',
  denied_circuit_open: 'error',
  tool_not_found: 'error',
  timeout: 'error',
};

function formatTs(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

function pickVariant(status: string): 'completed' | 'paused' | 'error' | 'syncing' {
  return STATUS_VARIANT[status] ?? 'syncing';
}

export function AdminToolInvocations() {
  const { t } = useTranslation();
  useDocumentTitle(t('toolInvocations.title'));
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [personaId, setPersonaId] = useState('');
  const [limit, setLimit] = useState(50);

  const list = useToolInvocations(personaId || null, limit, isAdmin);

  if (!isAdmin) return <EmptyState variant="error" message={t('adminConfig.noPermission')} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('toolInvocations.title')}
        subtitle={t('toolInvocations.subtitle')}
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          type="text"
          className="rounded border border-border bg-surface px-2 py-1 flex-1 max-w-md"
          placeholder={t('toolInvocations.filters.personaPlaceholder')}
          value={personaId}
          onChange={(e) => setPersonaId(e.target.value)}
        />
        <label className="flex items-center gap-1">
          <span className="text-xs text-text-secondary">{t('toolInvocations.filters.limitLabel')}</span>
          <select
            className="rounded border border-border bg-surface px-2 py-1"
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10))}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </label>
      </div>

      {!personaId ? (
        <EmptyState illustration="search" message={t('toolInvocations.empty.enterPersona')} />
      ) : list.isLoading ? (
        <Skeleton variant="card" />
      ) : list.error ? (
        <EmptyState
          variant="error"
          message={t('toolInvocations.errors.loadFailed', { message: (list.error as Error).message })}
        />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState illustration="tools" message={t('toolInvocations.empty.personaEmpty', { personaId })} />
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left border-b border-border bg-surface">
              <tr>
                <th className="p-3">{t('toolInvocations.table.invoked')}</th>
                <th className="p-3">{t('toolInvocations.table.tool')}</th>
                <th className="p-3">{t('toolInvocations.table.invoker')}</th>
                <th className="p-3">{t('toolInvocations.table.status')}</th>
                <th className="p-3">{t('toolInvocations.table.duration')}</th>
                <th className="p-3">{t('toolInvocations.table.output')}</th>
                <th className="p-3">{t('toolInvocations.table.error')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data!.map((inv: ToolInvocation) => (
                <tr key={inv.id} className="border-b border-border/50">
                  <td className="p-3 text-xs">{formatTs(inv.invokedAt)}</td>
                  <td className="p-3 font-mono text-xs">{inv.toolId}</td>
                  <td className="p-3 text-xs">
                    <span className="rounded bg-surface px-1.5 py-0.5">{inv.invokerType}</span>
                    <span className="ml-1 font-mono text-text-secondary">{inv.invokerId}</span>
                  </td>
                  <td className="p-3">
                    <StatusBadge status={pickVariant(inv.status)} label={inv.status} />
                  </td>
                  <td className="p-3 text-xs">{t('toolInvocations.table.durationMs', { ms: inv.durationMs })}</td>
                  <td className="p-3 text-xs">
                    {inv.outputSizeBytes
                      ? t('toolInvocations.table.outputBytes', { bytes: inv.outputSizeBytes })
                      : '—'}
                  </td>
                  <td className="p-3 text-xs text-warning">
                    {inv.errorMessage ? inv.errorMessage.slice(0, 80) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
