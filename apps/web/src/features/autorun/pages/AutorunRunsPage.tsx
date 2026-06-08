import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { Breadcrumbs } from '../../../components/ui/Breadcrumbs';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { useAutorunRuns, type AutorunRun } from '../../../api/queries/autorun';
import { useAvatar } from '../../../api/queries/avatars';
import { useSse } from '../../../api/queries/sse';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';
import { useQueryClient } from '@tanstack/react-query';

const STATUS_MAP: Record<string, 'active' | 'completed' | 'error' | 'paused' | 'syncing'> = {
  pending: 'paused',
  running: 'syncing',
  completed: 'completed',
  failed: 'error',
  review_required: 'paused',
};

export default function AutorunRunsPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const avatar = useAvatar(id ?? '');
  const { data: runs, isLoading, error } = useAutorunRuns(id ?? '');
  const qc = useQueryClient();
  useDocumentTitle(t('autorun.runsTitle'));

  useSse<{ avatarId: string }>('autorun', (msg) => {
    if (msg.avatarId === id) {
      void qc.invalidateQueries({ queryKey: ['autorun-runs', id] });
    }
  });

  const columns: Column<AutorunRun>[] = [
    { id: 'id', header: t('autorun.colRunId'), cell: r => <span className="font-mono text-xs">{r.id.slice(0, 8)}</span> },
    { id: 'status', header: t('autorun.colStatus'), cell: r => <StatusBadge status={STATUS_MAP[r.status] ?? 'offline'} label={r.status} /> },
    { id: 'startedAt', header: t('autorun.colStarted'), cell: r => new Date(r.startedAt).toLocaleString() },
    { id: 'itemsProcessed', header: t('autorun.colItems'), cell: r => String(r.itemsProcessed ?? 0) },
  ];

  return (
    <>
      <Breadcrumbs items={[
        { label: t('avatars.title'), to: '/avatars' },
        { label: avatar.data?.label ?? '...', to: `/avatars/${id}` },
        { label: t('autorun.title'), to: `/avatars/${id}/autorun` },
        { label: t('autorun.runsTitle') },
      ]} />

      <PageHeader title={t('autorun.runsTitle')} />

      {error ? (
        <EmptyState variant="error" message={error.message} />
      ) : (
        <DataTable
          rows={runs ?? []}
          columns={columns}
          getRowId={r => r.id}
          loading={isLoading}
          emptyState={
            <EmptyState
              illustration="confirmations"
              title={t('autorun.noRunsEmptyTitle')}
              message={t('autorun.noRunsEmptyDescription')}
              primaryAction={{
                label: t('autorun.noRunsEmptyAction'),
                to: id ? `/avatars/${id}/autorun` : '/avatars',
              }}
            />
          }
        />
      )}
    </>
  );
}
