import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useSimulationList } from '../api/queries/simulations';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  running: 'bg-blue-100 text-blue-800',
  pending: 'bg-yellow-100 text-yellow-800',
  failed: 'bg-red-100 text-red-800',
};

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function Simulations() {
  const { t } = useTranslation();
  useDocumentTitle(t('simulations.title'));
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useSimulationList(page);

  return (
    <>
      <PageHeader
        title={t('simulations.title')}
        subtitle={t('simulations.subtitle')}
        actions={
          <Link to="/simulations/new" className="rounded-lg bg-primary px-4 py-2 text-sm text-white">
            {t('simulations.createNew')}
          </Link>
        }
      />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      )}

      {error && (
        <EmptyState variant="error" message={t('simulations.loadError', { message: error.message })} />
      )}

      {data && data.data.length === 0 && (
        <EmptyState
          message={t('simulations.emptyState')}
          action={
            <Link to="/simulations/new" className="rounded-lg bg-primary px-4 py-2 text-sm text-white">
              {t('simulations.createFirst')}
            </Link>
          }
        />
      )}

      {data && data.data.length > 0 && (
        <>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-elevated">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium text-text-secondary">{t('simulations.colId')}</th>
                  <th scope="col" className="px-4 py-3 font-medium text-text-secondary">{t('simulations.colStatus')}</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium text-text-secondary sm:table-cell">{t('simulations.colCreated')}</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium text-text-secondary md:table-cell">{t('simulations.colCompleted')}</th>
                  <th scope="col" className="px-4 py-3 font-medium text-text-secondary">{t('simulations.colActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.data.map(sim => (
                  <tr key={sim.simulationId} className="hover:bg-surface transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs" title={sim.simulationId}>
                        {sim.simulationId.slice(0, 16)}...
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[sim.status] ?? 'bg-gray-100 text-gray-800'}`}>
                        {t(`simulations.status.${sim.status}`)}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-text-secondary sm:table-cell">{formatDate(sim.createdAt)}</td>
                    <td className="hidden px-4 py-3 text-text-secondary md:table-cell">{formatDate(sim.completedAt)}</td>
                    <td className="px-4 py-3">
                      {sim.status === 'completed' ? (
                        <Link
                          to="/dashboard"
                          onClick={() => {
                            try { localStorage.setItem('last-sim-id', sim.simulationId); } catch { /* ignored */ }
                          }}
                          className="text-sm text-primary hover:underline"
                        >
                          {t('simulations.view')}
                        </Link>
                      ) : (
                        <span className="text-xs text-text-secondary">{t('simulations.inProgress')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 分页 */}
          {data.pagination.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-text-secondary">
                {t('simulations.pageInfo', { page: data.pagination.page, total: data.pagination.totalPages })}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  {t('simulations.prev')}
                </button>
                <button
                  type="button"
                  disabled={page >= data.pagination.totalPages}
                  onClick={() => setPage(p => p + 1)}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  {t('simulations.next')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
