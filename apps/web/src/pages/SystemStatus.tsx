import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { useHealthz, useReadyz, usePosSummary } from '../api/queries/system';
import { useSse } from '../api/queries/sse';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function SystemStatus() {
  const { t } = useTranslation();
  useDocumentTitle(t('systemStatus.title'));
  const qc = useQueryClient();
  const healthz = useHealthz();
  const readyz = useReadyz();
  const posSummary = usePosSummary();

  useSse('system', () => {
    void qc.invalidateQueries({ queryKey: ['healthz'] });
    void qc.invalidateQueries({ queryKey: ['readyz'] });
  });

  return (
    <>
      <PageHeader title={t('systemStatus.title')} subtitle={t('systemStatus.subtitle')} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface-elevated p-4" role="status" aria-live="polite">
          <h3 className="mb-2 text-sm font-medium text-text-secondary">/healthz</h3>
          {healthz.isLoading ? (
            <Skeleton variant="card" />
          ) : healthz.error ? (
            <div className="text-sm text-warning">{t('systemStatus.unreachable')}</div>
          ) : (
            <div>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                healthz.data?.status === 'ok' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${healthz.data?.status === 'ok' ? 'bg-success' : 'bg-warning'}`} />
                {healthz.data?.status ?? t('systemStatus.unknown')}
              </span>
              {healthz.data?.uptime != null && (
                <p className="mt-1 text-xs text-text-secondary">
                  {t('systemStatus.uptimeLabel')} {(healthz.data.uptime / 1000).toFixed(0)}s
                </p>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-surface-elevated p-4" role="status" aria-live="polite">
          <h3 className="mb-2 text-sm font-medium text-text-secondary">/readyz</h3>
          {readyz.isLoading ? (
            <Skeleton variant="card" />
          ) : readyz.error ? (
            <div className="text-sm text-warning">{t('systemStatus.unreachable')}</div>
          ) : (
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
              readyz.data?.status === 'ok' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${readyz.data?.status === 'ok' ? 'bg-success' : 'bg-warning'}`} />
              {readyz.data?.status ?? t('systemStatus.unknown')}
            </span>
          )}
        </div>

        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <h3 className="mb-2 text-sm font-medium text-text-secondary">{t('systemStatus.apiDocsLabel')}</h3>
          <a
            href="/api/v1/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary underline"
          >
            /api/v1/docs
          </a>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-border bg-surface-elevated p-4">
        <h3 className="mb-3 text-sm font-medium text-text-secondary">{t('systemStatus.personaSummaryTitle')}</h3>
        {posSummary.isLoading ? (
          <Skeleton variant="table" />
        ) : posSummary.error ? (
          <p className="text-sm text-text-secondary">{t('systemStatus.personaError')}</p>
        ) : (
          <pre className="whitespace-pre-wrap rounded-lg bg-surface p-3 text-xs leading-relaxed">
            {typeof posSummary.data?.summary === 'string'
              ? posSummary.data.summary
              : JSON.stringify(posSummary.data, null, 2)}
          </pre>
        )}
      </div>
    </>
  );
}
