/**
 * AI 安全 / 人格漂移报告 (T0-B)
 * 后端：POST /api/v1/admin/safety/drift-report 触发分析
 *      GET  /api/v1/admin/safety/drift-report 拉取最近一份
 *      GET  /api/v1/admin/safety/status       聚合视图
 */

import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../hooks/useAuth';
import {
  useLatestDriftReport,
  useGenerateDriftReport,
  useSafetyStatus,
  type DriftAlertLevel,
} from '../api/queries/safety';

const ALERT_BADGE_STATUS: Record<DriftAlertLevel, 'completed' | 'paused' | 'error'> = {
  ok: 'completed',
  warning: 'paused',
  critical: 'error',
};

const ALERT_LABEL: Record<DriftAlertLevel, string> = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
};

function formatTimestamp(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined || ms === '') return '—';
  const n = typeof ms === 'string' ? parseInt(ms, 10) : ms;
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n).toLocaleString();
}

function formatDelta(d: number): string {
  return `${d >= 0 ? '+' : ''}${d.toFixed(3)}`;
}

export function SafetyDriftReport() {
  const { t } = useTranslation();
  useDocumentTitle(t('safetyDrift.documentTitle'));
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const status = useSafetyStatus(isAdmin);
  const latest = useLatestDriftReport(isAdmin);
  const generate = useGenerateDriftReport();

  if (!isAdmin) {
    return <EmptyState variant="error" message={t('adminConfig.noPermission')} />;
  }

  const isLoading = status.isLoading || latest.isLoading;
  if (isLoading) return <Skeleton variant="card" />;

  const summary = status.data;
  const report = latest.data ?? summary?.personaDrift?.lastReport ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('safetyDrift.title')}
        subtitle={t('safetyDrift.subtitle')}
        actions={
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-light disabled:opacity-50"
            disabled={generate.isPending}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? t('safetyDrift.actions.generating') : t('safetyDrift.actions.generate')}
          </button>
        }
      />

      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-xl border border-border p-4">
            <div className="text-xs uppercase text-text-secondary">{t('safetyDrift.cards.safetyScore')}</div>
            <div className="mt-1 text-3xl font-bold">
              {t('safetyDrift.cards.safetyScoreValue', { score: summary.safetyScore })}
            </div>
          </div>
          <div className="rounded-xl border border-border p-4">
            <div className="text-xs uppercase text-text-secondary">{t('safetyDrift.cards.unverifiedMemory')}</div>
            <div className="mt-1 text-3xl font-bold">
              {summary.memoryConfidence.unverifiedCount}
              <span className="text-base font-normal text-text-secondary">
                /{summary.memoryConfidence.totalCount}
              </span>
            </div>
            <p className="mt-1 text-xs text-text-secondary">{t('safetyDrift.cards.unverifiedMemorySubtitle')}</p>
          </div>
          <div className="rounded-xl border border-border p-4">
            <div className="text-xs uppercase text-text-secondary">{t('safetyDrift.cards.recentAlerts')}</div>
            <div className="mt-1 text-3xl font-bold">{summary.personaDrift?.recentAlerts.length ?? 0}</div>
            <p className="mt-1 text-xs text-text-secondary">{t('safetyDrift.cards.recentAlertsSubtitle')}</p>
          </div>
        </div>
      )}

      {!report && (
        <EmptyState message={t('safetyDrift.empty.noReport')} />
      )}

      {report && (
        <section className="border rounded-lg p-4 space-y-3">
          <header className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">{t('safetyDrift.report.heading')}</h2>
              <p className="text-sm text-text-secondary">
                {t('safetyDrift.report.generatedAt', {
                  ts: formatTimestamp(report.analyzedAt),
                  baseline: report.baselineSnapshotId ?? '—',
                })}
              </p>
            </div>
            <StatusBadge
              status={ALERT_BADGE_STATUS[report.alertLevel]}
              label={ALERT_LABEL[report.alertLevel]}
            />
          </header>

          <div className="text-sm">
            {t('safetyDrift.report.overallScore')}<strong>{report.overallDriftScore.toFixed(3)}</strong>
            {report.alertEmitted ? (
              <span className="ml-2 text-warning">
                {t('safetyDrift.report.auditWritten', { id: report.auditId })}
              </span>
            ) : null}
          </div>

          {report.valueDrifts.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('safetyDrift.empty.noValueDrifts')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left border-b">
                <tr>
                  <th className="py-2">{t('safetyDrift.table.value')}</th>
                  <th className="py-2">{t('safetyDrift.table.baseline')}</th>
                  <th className="py-2">{t('safetyDrift.table.current')}</th>
                  <th className="py-2">{t('safetyDrift.table.delta')}</th>
                  <th className="py-2">{t('safetyDrift.table.alert')}</th>
                </tr>
              </thead>
              <tbody>
                {report.valueDrifts.map((d) => (
                  <tr key={d.valueId} className="border-b">
                    <td className="py-2 font-mono text-xs">{d.label || d.valueId}</td>
                    <td className="py-2">{d.baseline.toFixed(3)}</td>
                    <td className="py-2">{d.current.toFixed(3)}</td>
                    <td className="py-2 font-mono">{formatDelta(d.delta)}</td>
                    <td className="py-2">
                      <StatusBadge
                        status={ALERT_BADGE_STATUS[d.alertLevel]}
                        label={ALERT_LABEL[d.alertLevel]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {summary && (summary.personaDrift?.recentAlerts.length ?? 0) > 0 && (
        <section className="border rounded-lg p-4 space-y-2">
          <h2 className="text-lg font-semibold">{t('safetyDrift.recentAlerts.heading')}</h2>
          <ul className="text-sm space-y-1">
            {summary.personaDrift!.recentAlerts.map((a) => (
              <li key={a.reportId} className="flex items-center gap-3">
                <span className="font-mono text-xs flex-1 truncate">{a.reportId}</span>
                <span className="text-text-secondary">{formatTimestamp(a.analyzedAt)}</span>
                <StatusBadge
                  status={ALERT_BADGE_STATUS[a.alertLevel]}
                  label={ALERT_LABEL[a.alertLevel]}
                />
                <span className="font-mono w-20 text-right">{a.overallDriftScore.toFixed(3)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
