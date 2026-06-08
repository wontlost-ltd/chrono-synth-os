/**
 * Agency Authorizations admin page (P3-A).
 *
 * Distinct from tool permissions: this is the legal-level authorization
 * (人类授权 AI 代理 X 范围). Creating one requires a personaId +
 * principalUserId + scope + scopeDescription (legal evidence).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../hooks/useAuth';
import {
  useAgencyAuthorizationsByPersona,
  useCreateAgencyAuthorization,
  useSuspendAgencyAuthorization,
  useResumeAgencyAuthorization,
  useRevokeAgencyAuthorization,
  type AgencyAuthorization,
  type AgencyScope,
  type AgencyStatus,
} from '../api/queries/agent-tools';

const SCOPE_OPTIONS: AgencyScope[] = ['communication', 'scheduling', 'research', 'finance', 'all'];

const STATUS_BADGE: Record<AgencyStatus, 'active' | 'paused' | 'error' | 'completed'> = {
  active: 'active',
  suspended: 'paused',
  revoked: 'error',
  expired: 'error',
};

function formatTs(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

export function AdminAgencyAuthorizations() {
  const { t } = useTranslation();
  useDocumentTitle(t('agencyAuthorizations.title'));
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [personaId, setPersonaId] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const list = useAgencyAuthorizationsByPersona(personaId || null, isAdmin);
  const create = useCreateAgencyAuthorization();
  const suspend = useSuspendAgencyAuthorization();
  const resume = useResumeAgencyAuthorization();
  const revoke = useRevokeAgencyAuthorization();

  if (!isAdmin) return <EmptyState variant="error" message={t('adminConfig.noPermission')} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('agencyAuthorizations.title')}
        subtitle={t('agencyAuthorizations.subtitle')}
        actions={
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-light disabled:opacity-50"
            onClick={() => setShowCreate((v) => !v)}
            disabled={!personaId}
            title={personaId ? '' : t('agencyAuthorizations.filters.enterPersonaTooltip')}
          >
            {showCreate ? t('agencyAuthorizations.actions.cancel') : t('agencyAuthorizations.actions.create')}
          </button>
        }
      />

      <div className="flex items-center gap-2 text-sm">
        <input
          type="text"
          className="rounded border border-border bg-surface px-2 py-1 flex-1 max-w-md"
          placeholder={t('agencyAuthorizations.filters.personaPlaceholder')}
          value={personaId}
          onChange={(e) => setPersonaId(e.target.value)}
        />
      </div>

      {showCreate && personaId && (
        <CreateAgencyForm
          personaId={personaId}
          isPending={create.isPending}
          error={create.error}
          onCancel={() => setShowCreate(false)}
          onSubmit={async (input) => {
            await create.mutateAsync(input);
            setShowCreate(false);
          }}
        />
      )}

      {!personaId ? (
        <EmptyState message={t('agencyAuthorizations.empty.enterPersona')} />
      ) : list.isLoading ? (
        <Skeleton variant="card" />
      ) : list.error ? (
        <EmptyState
          variant="error"
          message={t('agencyAuthorizations.errors.loadFailed', { message: (list.error as Error).message })}
        />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState message={t('agencyAuthorizations.empty.personaEmpty', { personaId })} />
      ) : (
        <ul className="space-y-3">
          {list.data!.map((a) => (
            <AuthorizationCard
              key={a.id}
              auth={a}
              onSuspend={() => suspend.mutate(a.id)}
              onResume={() => resume.mutate(a.id)}
              onRevoke={() => {
                const reason = window.prompt(t('agencyAuthorizations.prompts.revokeReason'));
                if (!reason) return;
                revoke.mutate({ id: a.id, reason });
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface CardProps {
  auth: AgencyAuthorization;
  onSuspend: () => void;
  onResume: () => void;
  onRevoke: () => void;
}

function AuthorizationCard({ auth, onSuspend, onResume, onRevoke }: CardProps) {
  const { t } = useTranslation();
  const isActive = auth.status === 'active';
  const isSuspended = auth.status === 'suspended';
  const isFinal = auth.status === 'revoked' || auth.status === 'expired';
  return (
    <li className="rounded-xl border border-border bg-surface-elevated p-4 space-y-2">
      <header className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">{auth.id}</span>
            <StatusBadge status={STATUS_BADGE[auth.status]} label={auth.status.toUpperCase()} />
          </div>
          <p className="mt-1 text-sm">
            <strong>{t('agencyAuthorizations.card.scope')}:</strong> {auth.scope} ·{' '}
            <strong>{t('agencyAuthorizations.card.principal')}:</strong>{' '}
            <span className="font-mono text-xs">{auth.principalUserId}</span>
          </p>
        </div>
        <div className="flex gap-1">
          {isActive && (
            <button type="button" className="text-xs text-text-secondary hover:underline" onClick={onSuspend}>
              {t('agencyAuthorizations.actions.suspend')}
            </button>
          )}
          {isSuspended && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={onResume}>
              {t('agencyAuthorizations.actions.resume')}
            </button>
          )}
          {!isFinal && (
            <button type="button" className="text-xs text-warning hover:underline" onClick={onRevoke}>
              {t('agencyAuthorizations.actions.revoke')}
            </button>
          )}
        </div>
      </header>
      <p className="text-sm text-text-secondary">{auth.scopeDescription}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-text-secondary">
        <div>{t('agencyAuthorizations.card.grantedAt', { ts: formatTs(auth.grantedAt) })}</div>
        <div>{t('agencyAuthorizations.card.expiresAt', { ts: formatTs(auth.expiresAt) })}</div>
        <div>{t('agencyAuthorizations.card.allowedTools', { count: auth.allowedTools.length })}</div>
        <div>{t('agencyAuthorizations.card.deniedTools', { count: auth.deniedTools.length })}</div>
      </div>
      {auth.revokedAt !== null && (
        <p className="text-xs text-warning">
          {t('agencyAuthorizations.card.revokedNote', {
            ts: formatTs(auth.revokedAt),
            reason: auth.revocationReason,
          })}
        </p>
      )}
    </li>
  );
}

interface FormProps {
  personaId: string;
  isPending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (input: {
    personaId: string;
    principalUserId: string;
    scope: AgencyScope;
    scopeDescription: string;
    allowedTools?: string[];
    deniedTools?: string[];
    expiresAt?: number | null;
  }) => Promise<void>;
}

function CreateAgencyForm({ personaId, isPending, error, onCancel, onSubmit }: FormProps) {
  const { t } = useTranslation();
  const [principalUserId, setPrincipalUserId] = useState('');
  const [scope, setScope] = useState<AgencyScope>('research');
  const [scopeDescription, setScopeDescription] = useState('');
  const [allowedToolsRaw, setAllowedToolsRaw] = useState('');
  const [deniedToolsRaw, setDeniedToolsRaw] = useState('');
  const errorMsg = error instanceof Error ? error.message : null;

  return (
    <form
      className="rounded-xl border border-border p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const allowedTools = allowedToolsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const deniedTools = deniedToolsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        void onSubmit({
          personaId,
          principalUserId,
          scope,
          scopeDescription,
          allowedTools: allowedTools.length ? allowedTools : undefined,
          deniedTools: deniedTools.length ? deniedTools : undefined,
        });
      }}
    >
      <h2 className="text-base font-semibold">
        {t('agencyAuthorizations.createForm.title', { personaId })}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-text-secondary">{t('agencyAuthorizations.createForm.principalUserIdLabel')}</span>
          <input
            required
            className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
            value={principalUserId}
            onChange={(e) => setPrincipalUserId(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-text-secondary">{t('agencyAuthorizations.createForm.scopeLabel')}</span>
          <select
            className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value as AgencyScope)}
          >
            {SCOPE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <label className="space-y-1 block">
        <span className="text-xs text-text-secondary">{t('agencyAuthorizations.createForm.scopeDescriptionLabel')}</span>
        <textarea
          required
          minLength={10}
          maxLength={2000}
          className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
          rows={3}
          value={scopeDescription}
          onChange={(e) => setScopeDescription(e.target.value)}
        />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-text-secondary">{t('agencyAuthorizations.createForm.allowedToolsLabel')}</span>
          <input
            className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
            value={allowedToolsRaw}
            onChange={(e) => setAllowedToolsRaw(e.target.value)}
            placeholder={t('agencyAuthorizations.createForm.allowedToolsPlaceholder')}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-text-secondary">{t('agencyAuthorizations.createForm.deniedToolsLabel')}</span>
          <input
            className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
            value={deniedToolsRaw}
            onChange={(e) => setDeniedToolsRaw(e.target.value)}
            placeholder={t('agencyAuthorizations.createForm.deniedToolsPlaceholder')}
          />
        </label>
      </div>
      {errorMsg && <p className="text-xs text-warning">{errorMsg}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-light disabled:opacity-50"
          disabled={isPending}
        >
          {isPending ? t('agencyAuthorizations.createForm.submitting') : t('agencyAuthorizations.createForm.submit')}
        </button>
        <button
          type="button"
          className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-surface"
          onClick={onCancel}
        >
          {t('agencyAuthorizations.createForm.cancel')}
        </button>
      </div>
    </form>
  );
}
