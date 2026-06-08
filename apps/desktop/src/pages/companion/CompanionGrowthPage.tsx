/**
 * ChronoCompanion ·「你最近探索的方向」(ADR-0046 Phase 2.4a)。
 *
 * 这是双产品「同内核两外壳」的核心证明点：企业控制台把 persona drift 渲染成
 * 「policy violation / alert」（见 SafetyDriftPage），companion 把**同一份** DriftReport
 * 重新组织成「探索方向」。映射逻辑是 @chrono/contracts 的共享纯函数 `driftReportToGrowth`
 * （服务端 companion 路由也用它，零分叉）。
 *
 * 数据来自**本地** SQLCipher（`getLatestDriftReport()`），离线可用——符合「视图渲染本地数据」决策。
 */

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { getLatestDriftReport, queryTenantSnapshotCount } from '@/bridge/tauri-commands';
import {
  driftReportToGrowth,
  type ExplorationDirectionV1,
  type ExplorationIntensityV1,
} from '@chrono/contracts';

/** 探索强度 → 中文标签 + 配色（与企业版 alert 配色刻意不同：这里是「成长」语气，不是「告警」）。 */
const INTENSITY_META: Record<ExplorationIntensityV1, { label: string; style: string }> = {
  steady: { label: '平稳', style: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40' },
  exploring: { label: '探索中', style: 'bg-sky-500/15 text-sky-200 border-sky-500/40' },
  leaping: { label: '跃迁', style: 'bg-violet-500/15 text-violet-200 border-violet-500/40' },
};

/** 方向 → 中文短语（toward=越来越看重，away=逐渐放下，steady=保持）。 */
const DIRECTION_LABEL: Record<ExplorationDirectionV1['direction'], string> = {
  toward: '越来越看重',
  away: '逐渐放下',
  steady: '保持',
};

function formatTimestamp(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function CompanionGrowthPage() {
  const drift = useQuery({
    queryKey: ['companion', 'growth', 'drift'],
    queryFn: getLatestDriftReport,
  });
  const snapshotCount = useQuery({
    queryKey: ['companion', 'growth', 'snapshotCount'],
    queryFn: queryTenantSnapshotCount,
  });

  const loading = drift.isLoading || snapshotCount.isLoading;
  const error = drift.error ?? snapshotCount.error;

  /* ≥2 个快照才算有可对比的历史基线（与服务端 countTenantSnapshots>=2 同义）。 */
  const hasComparisonBaseline = (snapshotCount.data ?? 0) >= 2;
  const growth = driftReportToGrowth(drift.data ?? null, hasComparisonBaseline);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">你最近探索的方向</h1>
        <p className="mt-1 text-sm text-chrono-text-muted">
          你的数字人在和你相处中，价值观悄悄发生的变化——这不是告警，是它在认识这个世界。
        </p>
      </header>

      {loading && (
        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-4 text-sm">
          加载中…
        </div>
      )}

      {!loading && error && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
        >
          读取本地成长数据失败：{error instanceof Error ? error.message : '未知错误'}
        </div>
      )}

      {!loading && !error && !growth.hasBaseline && (
        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-6 text-center text-sm text-chrono-text-muted">
          <p className="text-base text-chrono-text-primary">还在认识你 🌱</p>
          <p className="mt-2">
            你的数字人需要更多相处才能看出探索方向
            {growth.analyzedAt ? `（上次分析于 ${formatTimestamp(growth.analyzedAt)}）` : ''}。
            多聊聊、多记一些，过段时间再回来看看。
          </p>
        </div>
      )}

      {!loading && !error && growth.hasBaseline && (
        <section className="space-y-4">
          <div className="flex items-center gap-3 text-sm text-chrono-text-muted">
            <span>整体节奏</span>
            <span
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-medium',
                INTENSITY_META[growth.overallIntensity].style,
              )}
            >
              {INTENSITY_META[growth.overallIntensity].label}
            </span>
            <span>· 分析于 {formatTimestamp(growth.analyzedAt)}</span>
          </div>

          {growth.directions.length === 0 ? (
            <p className="text-sm text-chrono-text-muted">这段时间价值观保持稳定，没有明显的探索方向。</p>
          ) : (
            <ul className="space-y-2">
              {growth.directions.map((d) => (
                <li
                  key={d.valueId}
                  className="flex items-center gap-3 rounded-xl border border-chrono-border bg-chrono-elevated p-3"
                >
                  <span className="flex-1 font-medium text-chrono-text-primary">{d.label || d.valueId}</span>
                  <span className="text-sm text-chrono-text-secondary">{DIRECTION_LABEL[d.direction]}</span>
                  {/* magnitude 0..1 → 进度条，直观表达「变化幅度」。 */}
                  <span
                    aria-label={`变化幅度 ${(d.magnitude * 100).toFixed(0)}%`}
                    className="h-1.5 w-24 overflow-hidden rounded-full bg-chrono-border"
                  >
                    <span
                      className="block h-full rounded-full bg-chrono-primary"
                      style={{ width: `${Math.round(d.magnitude * 100)}%` }}
                    />
                  </span>
                  <span
                    className={clsx(
                      'rounded-full border px-2 py-0.5 text-xs',
                      INTENSITY_META[d.intensity].style,
                    )}
                  >
                    {INTENSITY_META[d.intensity].label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
