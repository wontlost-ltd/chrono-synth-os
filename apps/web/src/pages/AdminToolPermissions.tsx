/**
 * Tool Permissions admin page (P3-A).
 *
 * Lists all tool_permissions for the tenant; supports grant + revoke +
 * filter-by-persona inline. Doesn't expose all constraints — keeps the
 * common subset (maxActionsPerDay, requireConfirmation) and points
 * admins at the API for advanced shapes.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../hooks/useAuth';
import {
  useToolPermissions,
  useGrantToolPermission,
  useRevokeToolPermission,
  type ToolPermission,
  type ToolScope,
} from '../api/queries/agent-tools';

/** Server returns grantedAt/expiresAt as bigint-string ("1779771002185") for
 *  precision; coerce to number before constructing a Date. Pure number input
 *  is also handled for forward-compat. */
function formatTimestamp(ms: number | string | null): string {
  if (ms === null || ms === undefined || ms === '') return '—';
  const n = typeof ms === 'string' ? parseInt(ms, 10) : ms;
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toLocaleString();
}

function permissionStatus(p: ToolPermission): 'active' | 'paused' | 'error' | 'completed' {
  if (p.revokedAt !== null) return 'error';
  if (p.expiresAt !== null && p.expiresAt < Date.now()) return 'paused';
  return 'active';
}

function permissionStatusLabel(p: ToolPermission, t: TFunction): string {
  if (p.revokedAt !== null) return t('toolPermissions.statusLabels.revoked');
  if (p.expiresAt !== null && p.expiresAt < Date.now()) return t('toolPermissions.statusLabels.expired');
  return t('toolPermissions.statusLabels.active');
}

const SCOPE_STYLE: Record<ToolScope, { bg: string; fg: string; border: string }> = {
  read:    { bg: 'rgba(34, 211, 238, 0.12)',  fg: '#67E8F9', border: 'rgba(34, 211, 238, 0.3)' },
  write:   { bg: 'rgba(251, 191, 36, 0.12)',  fg: '#FCD34D', border: 'rgba(251, 191, 36, 0.3)' },
  execute: { bg: 'rgba(168, 85, 247, 0.14)',  fg: '#D8B4FE', border: 'rgba(168, 85, 247, 0.35)' },
};

function ScopeBadge({ scope }: { scope: ToolScope }) {
  const s = SCOPE_STYLE[scope];
  return (
    <span
      className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
      style={{ backgroundColor: s.bg, color: s.fg, border: `1px solid ${s.border}` }}
    >
      {scope}
    </span>
  );
}

export function AdminToolPermissions() {
  const { t } = useTranslation();
  useDocumentTitle(t('toolPermissions.title'));
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const list = useToolPermissions(isAdmin);
  const grant = useGrantToolPermission();
  const revoke = useRevokeToolPermission();

  const [filterPersona, setFilterPersona] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'revoked'>('all');
  const [showGrantForm, setShowGrantForm] = useState(false);

  if (!isAdmin) return <EmptyState variant="error" message={t('adminConfig.noPermission')} />;
  if (list.isLoading) return <Skeleton variant="card" />;
  if (list.error) {
    return (
      <EmptyState
        variant="error"
        message={t('toolPermissions.errors.loadFailed', { message: (list.error as Error).message })}
      />
    );
  }

  const rows = (list.data ?? []).filter((p) => {
    if (filterPersona && !p.personaId.includes(filterPersona)) return false;
    if (filterStatus === 'active' && p.revokedAt !== null) return false;
    if (filterStatus === 'revoked' && p.revokedAt === null) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('toolPermissions.title')}
        subtitle={t('toolPermissions.subtitle')}
        actions={
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-light disabled:opacity-50"
            onClick={() => setShowGrantForm((v) => !v)}
          >
            {showGrantForm ? t('toolPermissions.actions.cancel') : t('toolPermissions.actions.grant')}
          </button>
        }
      />

      {showGrantForm && (
        <GrantPermissionForm
          isPending={grant.isPending}
          error={grant.error}
          onCancel={() => setShowGrantForm(false)}
          onSubmit={async (input) => {
            await grant.mutateAsync(input);
            setShowGrantForm(false);
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          type="text"
          className="rounded border border-border bg-surface px-2 py-1"
          placeholder={t('toolPermissions.filters.personaPlaceholder')}
          value={filterPersona}
          onChange={(e) => setFilterPersona(e.target.value)}
        />
        <select
          className="rounded border border-border bg-surface px-2 py-1"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
        >
          <option value="all">{t('toolPermissions.filters.statusAll')}</option>
          <option value="active">{t('toolPermissions.filters.statusActive')}</option>
          <option value="revoked">{t('toolPermissions.filters.statusRevoked')}</option>
        </select>
        <span className="text-text-secondary">
          {t('toolPermissions.filters.countSummary', {
            shown: rows.length,
            total: list.data?.length ?? 0,
          })}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState message={t('toolPermissions.empty.noMatch')} />
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left border-b border-border bg-surface">
              <tr>
                <th className="p-3">{t('toolPermissions.table.persona')}</th>
                <th className="p-3">{t('toolPermissions.table.tool')}</th>
                <th className="p-3">{t('toolPermissions.table.scope')}</th>
                <th className="p-3">{t('toolPermissions.table.constraints')}</th>
                <th className="p-3">{t('toolPermissions.table.granted')}</th>
                <th className="p-3">{t('toolPermissions.table.expires')}</th>
                <th className="p-3">{t('toolPermissions.table.status')}</th>
                <th className="p-3">{t('toolPermissions.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="p-3">
                    <span className="chip-mono" title={p.personaId}>
                      {p.personaId.length > 18 ? `${p.personaId.slice(0, 14)}…${p.personaId.slice(-3)}` : p.personaId}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-[13px] text-text-primary">{p.toolId}</td>
                  <td className="p-3">
                    <ScopeBadge scope={p.scope} />
                  </td>
                  <td className="p-3 font-mono text-xs text-text-secondary">
                    {summarizeConstraints(p.constraints)}
                  </td>
                  <td className="p-3 text-xs text-text-secondary tabular-nums">{formatTimestamp(p.grantedAt)}</td>
                  <td className="p-3 text-xs text-text-secondary tabular-nums">{formatTimestamp(p.expiresAt)}</td>
                  <td className="p-3">
                    <StatusBadge status={permissionStatus(p)} label={permissionStatusLabel(p, t)} />
                  </td>
                  <td className="p-3">
                    {p.revokedAt === null && (
                      <button
                        type="button"
                        className="text-xs text-warning hover:underline"
                        disabled={revoke.isPending}
                        onClick={() => {
                          const reason = window.prompt(t('toolPermissions.prompts.revokeReason'));
                          if (!reason) return;
                          revoke.mutate({ id: p.id, reason });
                        }}
                      >
                        {t('toolPermissions.actions.revoke')}
                      </button>
                    )}
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

function summarizeConstraints(c: ToolPermission['constraints']): string {
  const parts: string[] = [];
  if (c.maxActionsPerDay !== undefined) parts.push(`max/d=${c.maxActionsPerDay}`);
  if (c.requireConfirmation) parts.push('confirm');
  if (c.budgetLimitCents !== undefined) parts.push(`$${(c.budgetLimitCents / 100).toFixed(2)}`);
  if (c.allowList?.length) parts.push(`allow:${c.allowList.length}`);
  if (c.denyList?.length) parts.push(`deny:${c.denyList.length}`);
  return parts.length === 0 ? '—' : parts.join(' · ');
}

interface GrantFormProps {
  isPending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (input: {
    personaId: string;
    toolId: string;
    scope: ToolScope;
    constraints?: ToolPermission['constraints'];
    expiresAt?: number | null;
  }) => Promise<void>;
}

function GrantPermissionForm({ isPending, error, onCancel, onSubmit }: GrantFormProps) {
  const { t } = useTranslation();
  const [personaId, setPersonaId] = useState('');
  const [toolId, setToolId] = useState('');
  const [scope, setScope] = useState<ToolScope>('execute');
  const [maxPerDay, setMaxPerDay] = useState('');
  const [requireConfirm, setRequireConfirm] = useState(false);
  const errorMsg = useMemo(() => (error instanceof Error ? error.message : null), [error]);

  return (
    <form
      className="rounded-xl border border-border p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const constraints: ToolPermission['constraints'] = {};
        if (maxPerDay) constraints.maxActionsPerDay = parseInt(maxPerDay, 10);
        if (requireConfirm) constraints.requireConfirmation = true;
        void onSubmit({ personaId, toolId, scope, constraints });
      }}
    >
      <h2 className="text-base font-semibold">{t('toolPermissions.grantForm.title')}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-text-secondary">{t('toolPermissions.grantForm.personaIdLabel')}</span>
          <input
            required
            className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-text-secondary">{t('toolPermissions.grantForm.toolIdLabel')}</span>
          <input
            required
            className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
            value={toolId}
            onChange={(e) => setToolId(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-text-secondary">{t('toolPermissions.grantForm.scopeLabel')}</span>
          <select
            className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value as ToolScope)}
          >
            <option value="read">read</option>
            <option value="write">write</option>
            <option value="execute">execute</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-text-secondary">{t('toolPermissions.grantForm.maxPerDayLabel')}</span>
          <input
            type="number"
            min="1"
            className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
            value={maxPerDay}
            onChange={(e) => setMaxPerDay(e.target.value)}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={requireConfirm}
          onChange={(e) => setRequireConfirm(e.target.checked)}
        />
        <span>{t('toolPermissions.grantForm.requireConfirmLabel')}</span>
      </label>
      {errorMsg && <p className="text-xs text-warning">{errorMsg}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-light disabled:opacity-50" disabled={isPending}>
          {isPending ? t('toolPermissions.grantForm.submitting') : t('toolPermissions.grantForm.submit')}
        </button>
        <button type="button" className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-surface" onClick={onCancel}>
          {t('toolPermissions.grantForm.cancel')}
        </button>
      </div>
    </form>
  );
}
