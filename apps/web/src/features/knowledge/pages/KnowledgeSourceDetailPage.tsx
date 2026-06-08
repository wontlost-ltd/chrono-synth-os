import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { Breadcrumbs } from '../../../components/ui/Breadcrumbs';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import { Skeleton } from '../../../components/ui/Skeleton';
import { EmptyState } from '../../../components/ui/EmptyState';
import { useKnowledgeSource, useSyncKnowledgeSource } from '../../../api/queries/knowledgeSources';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';

export default function KnowledgeSourceDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { data: source, isLoading, error } = useKnowledgeSource(id ?? '');
  const sync = useSyncKnowledgeSource(id ?? '');

  useDocumentTitle(source?.name ?? t('knowledgeSources.detail'));

  if (isLoading) return <Skeleton variant="card" />;
  if (error || !source) return <EmptyState variant="error" message={error?.message ?? t('knowledgeSources.notFound')} />;

  return (
    <>
      <Breadcrumbs items={[
        { label: t('knowledgeSources.title'), to: '/knowledge-sources' },
        { label: source.name },
      ]} />

      <PageHeader
        title={source.name}
        actions={
          <div className="flex items-center gap-3">
            <StatusBadge status={source.enabled ? 'active' : 'paused'} size="md" />
            <span className="rounded bg-neutral-1 px-2 py-1 text-xs font-medium uppercase">{source.type}</span>
            <button
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
            >
              {sync.isPending ? t('knowledgeSources.syncing') : t('knowledgeSources.sync')}
            </button>
          </div>
        }
      />

      <div className="space-y-6">
        <section className="rounded-lg border border-border p-4">
          <h3 className="mb-3 text-sm font-semibold">{t('knowledgeSources.configSection')}</h3>
          <pre className="text-xs text-text-secondary whitespace-pre-wrap">{JSON.stringify(source.config, null, 2)}</pre>
        </section>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-text-secondary">{t('knowledgeSources.colItems')}</p>
            <p className="text-xl font-semibold">{source.itemCount ?? 0}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-text-secondary">{t('knowledgeSources.colLastSync')}</p>
            <p className="text-sm font-medium">{source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : '—'}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-text-secondary">{t('knowledgeSources.colCreated')}</p>
            <p className="text-sm font-medium">{new Date(source.createdAt).toLocaleString()}</p>
          </div>
        </div>
      </div>
    </>
  );
}
