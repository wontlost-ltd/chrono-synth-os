import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { useKnowledgeSources, useDeleteKnowledgeSource, useSyncKnowledgeSource, type KnowledgeSource } from '../../../api/queries/knowledgeSources';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

export default function KnowledgeSourceListPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('knowledgeSources.title'));
  const { data: sources, isLoading, error } = useKnowledgeSources();
  const deleteSrc = useDeleteKnowledgeSource();
  const navigate = useNavigate();

  const columns: Column<KnowledgeSource>[] = [
    { id: 'name', header: t('knowledgeSources.colName'), cell: row => <span className="font-medium">{row.name}</span> },
    { id: 'type', header: t('knowledgeSources.colType'), cell: row => (
      <span className="rounded bg-neutral-1 px-2 py-0.5 text-xs font-medium uppercase">{row.type}</span>
    )},
    { id: 'enabled', header: t('knowledgeSources.colStatus'), cell: row => (
      <StatusBadge status={row.enabled ? 'active' : 'paused'} label={row.enabled ? t('knowledgeSources.enabled') : t('knowledgeSources.disabled')} />
    )},
    { id: 'lastSyncAt', header: t('knowledgeSources.colLastSync'), cell: row =>
      row.lastSyncAt ? new Date(row.lastSyncAt).toLocaleString() : '—'
    },
    { id: 'itemCount', header: t('knowledgeSources.colItems'), cell: row => String(row.itemCount ?? 0) },
  ];

  return (
    <>
      <PageHeader
        title={t('knowledgeSources.title')}
        subtitle={t('knowledgeSources.subtitle')}
        actions={
          <button onClick={() => navigate('/knowledge-sources/create')} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            {t('knowledgeSources.create')}
          </button>
        }
      />

      {error ? (
        <EmptyState variant="error" message={t('knowledgeSources.loadError', { message: error.message })} />
      ) : (
        <DataTable
          rows={sources ?? []}
          columns={columns}
          getRowId={r => r.id}
          loading={isLoading}
          emptyState={
            <EmptyState
              illustration="memories"
              title={t('knowledgeSources.emptyTitle')}
              message={t('knowledgeSources.emptyDescription')}
              primaryAction={{
                label: t('knowledgeSources.emptyAction'),
                to: '/knowledge-sources/create',
              }}
            />
          }
          rowActions={row => <RowActions source={row} onDelete={deleteSrc} navigate={navigate} />}
        />
      )}
    </>
  );
}

function RowActions({ source, onDelete, navigate }: { source: KnowledgeSource; onDelete: ReturnType<typeof useDeleteKnowledgeSource>; navigate: ReturnType<typeof useNavigate> }) {
  const { t } = useTranslation();
  const sync = useSyncKnowledgeSource(source.id);

  return (
    <div className="flex gap-2">
      <button onClick={() => sync.mutate()} disabled={sync.isPending} className="text-sm text-info hover:underline">
        {sync.isPending ? t('knowledgeSources.syncing') : t('knowledgeSources.sync')}
      </button>
      <button onClick={() => navigate(`/knowledge-sources/${source.id}`)} className="text-sm text-primary hover:underline">
        {t('knowledgeSources.view')}
      </button>
      <button
        onClick={() => { if (confirm(t('knowledgeSources.confirmDelete'))) onDelete.mutate(source.id); }}
        className="text-sm text-warning hover:underline"
      >
        {t('knowledgeSources.delete')}
      </button>
    </div>
  );
}
