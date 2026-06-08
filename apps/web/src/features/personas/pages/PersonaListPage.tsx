import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Modal } from '../../../components/ui/Modal';
import { FormField } from '../../../components/ui/FormField';
import { usePersonas, useForkPersona, useUpdatePersonaStatus, type Persona } from '../../../api/queries/personas';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

const PERSONA_STATUS_MAP: Record<string, 'active' | 'paused' | 'completed' | 'error'> = {
  active: 'active', paused: 'paused', completed: 'completed', failed: 'error',
};

export default function PersonaListPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('personas.title'));
  const { data: personas, isLoading, error } = usePersonas();
  const forkPersona = useForkPersona();
  const [showFork, setShowFork] = useState(false);
  const [forkLabel, setForkLabel] = useState('');

  const columns: Column<Persona>[] = [
    { id: 'label', header: t('personas.colLabel'), cell: r => <span className="font-medium">{r.label}</span> },
    { id: 'status', header: t('personas.colStatus'), cell: r => <StatusBadge status={PERSONA_STATUS_MAP[r.status] ?? 'offline'} label={r.status} /> },
    { id: 'resourceQuota', header: t('personas.colQuota'), cell: r => `${(r.resourceQuota * 100).toFixed(0)}%` },
    { id: 'createdAt', header: t('personas.colCreated'), cell: r => new Date(r.createdAt).toLocaleDateString() },
  ];

  return (
    <>
      <PageHeader
        title={t('personas.title')}
        subtitle={t('personas.subtitle')}
        actions={
          <button onClick={() => setShowFork(true)} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            {t('personas.fork')}
          </button>
        }
      />

      {error ? (
        <EmptyState variant="error" message={error.message} />
      ) : (
        <DataTable
          rows={personas ?? []}
          columns={columns}
          getRowId={r => r.id}
          loading={isLoading}
          emptyState={
            <EmptyState
              illustration="personas"
              title={t('personas.emptyTitle')}
              message={t('personas.emptyDescription')}
              primaryAction={{
                label: t('personas.emptyAction'),
                onClick: () => setShowFork(true),
              }}
            />
          }
          rowActions={row => <PersonaActions persona={row} />}
        />
      )}

      <Modal open={showFork} onClose={() => setShowFork(false)} title={t('personas.forkTitle')}>
        <form onSubmit={e => {
          e.preventDefault();
          if (!forkLabel.trim()) return;
          forkPersona.mutate({ label: forkLabel }, { onSuccess: () => { setShowFork(false); setForkLabel(''); } });
        }} className="space-y-4">
          <FormField label={t('personas.labelField')} required>
            {(props) => (
              <input {...props} type="text" value={forkLabel} onChange={e => setForkLabel(e.target.value)}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
            )}
          </FormField>
          <button type="submit" disabled={forkPersona.isPending}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50">
            {forkPersona.isPending ? t('common.loading') : t('personas.fork')}
          </button>
        </form>
      </Modal>
    </>
  );
}

function PersonaActions({ persona }: { persona: Persona }) {
  const { t } = useTranslation();
  const updateStatus = useUpdatePersonaStatus(persona.id);
  const nextStatus = persona.status === 'active' ? 'paused' : 'active';

  return (
    <button
      onClick={() => updateStatus.mutate(nextStatus as Persona['status'])}
      disabled={updateStatus.isPending}
      className="text-sm text-primary hover:underline"
    >
      {persona.status === 'active' ? t('personas.pause') : t('personas.resume')}
    </button>
  );
}
