import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { MetricCard } from '../components/ui/MetricCard';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { LiveIndicator } from '../components/ui/LiveIndicator';
import { LiveMetricStream } from '../components/charts/LiveMetricStream';
import { useOverview } from '../api/queries/visualization';
import { useSimulationList, type SimulationListItem } from '../api/queries/simulations';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/** 落地总览卡片——指向产品核心能力。人生模拟列为入口之一（降位），不再是首屏唯一叙事。 */
const OVERVIEW_CARDS = [
  { to: '/workforce', titleKey: 'overview.cards.workforce.title', descKey: 'overview.cards.workforce.desc' },
  { to: '/persona-core', titleKey: 'overview.cards.persona.title', descKey: 'overview.cards.persona.desc' },
  { to: '/admin/agency-authorizations', titleKey: 'overview.cards.governance.title', descKey: 'overview.cards.governance.desc' },
  { to: '/knowledge-sources', titleKey: 'overview.cards.knowledge.title', descKey: 'overview.cards.knowledge.desc' },
  { to: '/marketplace', titleKey: 'overview.cards.marketplace.title', descKey: 'overview.cards.marketplace.desc' },
  { to: '/simulations', titleKey: 'overview.cards.simulations.title', descKey: 'overview.cards.simulations.desc' },
] as const;

export function Dashboard() {
  const { t } = useTranslation();
  const [simId, setSimId] = useState(() => {
    try { return localStorage.getItem('last-sim-id') ?? ''; } catch { return ''; }
  });
  /* 标题随内容：无选中模拟=总览（避免「人生模拟仪表盘」霸占首屏标题），选中后=模拟仪表盘。 */
  useDocumentTitle(simId ? t('dashboard.title') : t('overview.title'));

  /* 无已选模拟时，自动选取最近完成的模拟 */
  const { data: listData } = useSimulationList(1, 20);
  useEffect(() => {
    if (!simId && listData?.data?.length) {
      const completed = listData.data.reduce<SimulationListItem | undefined>((latest, sim) => {
        if (sim.status !== 'completed') return latest;
        const simTs = sim.completedAt ?? sim.createdAt ?? 0;
        if (!latest) return sim;
        const latestTs = latest.completedAt ?? latest.createdAt ?? 0;
        return simTs > latestTs ? sim : latest;
      }, undefined);
      if (completed) {
        setSimId(completed.simulationId);
        try { localStorage.setItem('last-sim-id', completed.simulationId); } catch { /* ignored */ }
      }
    }
  }, [simId, listData]);

  const { data, isLoading, error } = useOverview(simId);
  const ws = useWebSocket({ autoConnect: !!simId });

  if (!simId) {
    /* 默认落地（无选中模拟）：呈现产品真正的核心（数字员工/治理/人格/知识），而非把用户推向
     * 「建人生模拟」。人生模拟降为众入口之一（ADR-0047 论点载体仍在，但不再霸占首屏叙事）。 */
    return (
      <>
        <PageHeader title={t('overview.title')} subtitle={t('overview.subtitle')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {OVERVIEW_CARDS.map((c) => (
            <Link
              key={c.to}
              to={c.to}
              className="group rounded-xl border border-border bg-surface-elevated p-5 transition-colors hover:border-primary"
            >
              <h3 className="text-base font-semibold text-text-primary group-hover:text-primary">{t(c.titleKey)}</h3>
              <p className="mt-1 text-sm text-text-secondary">{t(c.descKey)}</p>
            </Link>
          ))}
        </div>
      </>
    );
  }

  if (isLoading) {
    return (
      <>
        <PageHeader title={t('dashboard.title')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
        <Skeleton variant="chart" className="mt-4" />
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHeader title={t('dashboard.title')} />
        <EmptyState
          variant={error ? 'error' : 'empty'}
          message={error ? t('dashboard.loadError', { message: error.message }) : t('dashboard.noData')}
          action={<button type="button" onClick={() => setSimId('')} className="text-sm text-primary underline">{t('dashboard.reselect')}</button>}
        />
      </>
    );
  }

  const recommended = data.paths.find(p => p.pathId === data.recommendedPathId);
  const retro = data.retrospective as { summary?: string; confidence?: number; regretByPath?: Record<string, number> } | string | undefined;
  const retroSummary = typeof retro === 'string' ? retro : retro?.summary ?? '';
  const confidence = typeof retro === 'object' ? retro?.confidence : undefined;

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle', { id: data.simulationId.slice(0, 20), years: data.meta.horizonYears })}
        actions={
          <div className="flex items-center gap-3">
            <LiveIndicator status={ws.status} />
            <Link
              to="/simulations"
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-surface"
            >
              {t('dashboard.switchSimulation')}
            </Link>
          </div>
        }
      />

      {/* 推荐路径 */}
      {recommended && (
        <div className="mb-6 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
            <div>
              <span className="text-xs font-medium text-primary">{t('dashboard.recommendedPath')}</span>
              <h2 className="text-lg font-bold">{recommended.pathId}</h2>
            </div>
            <div className="sm:text-right">
              <div className="text-sm text-text-secondary">{t('dashboard.compositeScore')}</div>
              <div className="text-xl font-bold">{recommended.compositeScore.toFixed(3)}</div>
            </div>
          </div>
        </div>
      )}

      {/* 关键指标 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data.paths.map(p => (
          <MetricCard
            key={p.pathId}
            title={p.label ?? p.pathId}
            value={p.compositeScore}
            unit=""
          />
        ))}
        {confidence != null && <MetricCard title={t('dashboard.confidence')} value={confidence} unit="" />}
        {recommended && <MetricCard title={t('dashboard.regretProbability')} value={recommended.regretProbability} unit="" />}
      </div>

      {/* 回顾分析 */}
      {retroSummary && (
        <div className="mt-6 rounded-xl border border-border bg-surface-elevated p-4">
          <h3 className="mb-2 text-sm font-medium text-text-secondary">{t('dashboard.retrospective')}</h3>
          <p className="text-sm leading-relaxed">{retroSummary}</p>
        </div>
      )}

      {/* 实时事件流 */}
      <div className="mt-6 rounded-xl border border-border bg-surface-elevated p-4" aria-live="polite">
        <h3 className="mb-3 text-sm font-medium text-text-secondary">{t('dashboard.liveEvents')}</h3>
        <LiveMetricStream subscribe={ws.subscribe} status={ws.status} />
      </div>

      {/* 导航操作 */}
      <div className="mt-6 flex flex-wrap gap-3">
        <Link to={`/simulations/${encodeURIComponent(simId)}/paths`} className="rounded-lg bg-primary px-4 py-2 text-sm text-white">
          {t('dashboard.comparePaths')}
        </Link>
        <Link to={`/simulations/${encodeURIComponent(simId)}/branches`} className="rounded-lg border border-border px-4 py-2 text-sm">
          {t('dashboard.viewBranches')}
        </Link>
        <Link to={`/simulations/${encodeURIComponent(simId)}/stress`} className="rounded-lg border border-border px-4 py-2 text-sm">
          {t('dashboard.stressTest')}
        </Link>
        <Link to={`/simulations/${encodeURIComponent(simId)}/milestones`} className="rounded-lg border border-border px-4 py-2 text-sm">
          {t('dashboard.milestones')}
        </Link>
      </div>
    </>
  );
}
