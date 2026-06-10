/**
 * ChronoCompanion ·「你最近探索的方向」(ADR-0046 Phase 2.4a / ② 路线 B)。
 *
 * 数据来源：在线取服务端**已映射**的 /api/v1/companion/me/growth（与 mobile 同源），缓存上次供离线
 * 显示（见 growth-data.ts）。desktop 本地无 snapshots/drift 表，真·本地算 drift（路线 A）留后续。
 *
 * 仍是双产品「同内核两外壳」证明点：企业控制台把 persona drift 渲染成「policy violation / alert」，
 * companion 把同一份 drift（服务端经 driftReportToGrowth 映射）渲染成「探索方向」。
 */

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  type ExplorationDirectionV1,
  type ExplorationIntensityV1,
} from '@chrono/contracts';
import { loadCompanionGrowth, type GrowthSource } from '@/companion/growth-data';

/** 探索强度 → 中文标签 + 配色（成长语气，不是告警，与企业版 alert 配色刻意不同）。 */
const INTENSITY_META: Record<ExplorationIntensityV1, { label: string; style: string }> = {
  steady: { label: '平稳', style: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40' },
  exploring: { label: '探索中', style: 'bg-sky-500/15 text-sky-200 border-sky-500/40' },
  leaping: { label: '跃迁', style: 'bg-violet-500/15 text-violet-200 border-violet-500/40' },
};

const DIRECTION_LABEL: Record<ExplorationDirectionV1['direction'], string> = {
  toward: '越来越看重',
  away: '逐渐放下',
  steady: '保持',
};

const SOURCE_HINT: Record<GrowthSource, string> = {
  remote: '在线最新',
  cache: '上次同步（当前离线或服务器不可达）',
  none: '',
};

function formatTimestamp(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function CompanionGrowthPage() {
  const query = useQuery({
    queryKey: ['companion', 'growth'],
    queryFn: loadCompanionGrowth,
  });

  const result = query.data;
  const growth = result?.growth ?? null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">你最近探索的方向</h1>
        <p className="mt-1 text-sm text-chrono-text-muted">
          你的数字人在和你相处中，价值观悄悄发生的变化——这不是告警，是它在认识这个世界。
        </p>
      </header>

      {query.isLoading && (
        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-4 text-sm">
          加载中…
        </div>
      )}

      {!query.isLoading && result?.unconfigured && (
        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-6 text-center text-sm text-chrono-text-muted">
          <p className="text-base text-chrono-text-primary">还没连接服务器</p>
          <p className="mt-2">在「设置」里填好服务器地址和访问令牌，就能看到你数字人的成长。</p>
        </div>
      )}

      {!query.isLoading && !result?.unconfigured && growth && !growth.hasBaseline && (
        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-6 text-center text-sm text-chrono-text-muted">
          <p className="text-base text-chrono-text-primary">还在认识你 🌱</p>
          <p className="mt-2">
            你的数字人需要更多相处才能看出探索方向
            {growth.analyzedAt ? `（上次分析于 ${formatTimestamp(growth.analyzedAt)}）` : ''}。
            多聊聊、多记一些，过段时间再回来看看。
          </p>
        </div>
      )}

      {!query.isLoading && !result?.unconfigured && !growth && (
        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-6 text-center text-sm text-chrono-text-muted">
          <p className="text-base text-chrono-text-primary">还在认识你 🌱</p>
          <p className="mt-2">还没有成长数据。联网后会自动获取。</p>
        </div>
      )}

      {!query.isLoading && growth && growth.hasBaseline && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm text-chrono-text-muted">
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
            {result && result.source !== 'none' && (
              <span className="text-xs text-chrono-text-tertiary">· {SOURCE_HINT[result.source]}</span>
            )}
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
