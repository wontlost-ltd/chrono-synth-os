/**
 * AI 安全 / 人格漂移监测 (T0-B parity with web)
 *
 * 通过 Tauri 命令 get_latest_drift_report / generate_drift_report 与本地
 * Rust 后端通信。命令尚未实现时优雅降级为"等待 Rust 端实现"提示，与
 * chrono-synth-web 的页面保持视觉/语义一致。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  generateDriftReport,
  getLatestDriftReport,
  type DriftAlertLevel,
} from '@/bridge/tauri-commands';

const ALERT_STYLE: Record<DriftAlertLevel, string> = {
  ok: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40',
  warning: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
  critical: 'bg-red-500/15 text-red-200 border-red-500/40',
};

const ALERT_LABEL: Record<DriftAlertLevel, string> = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
};

function formatTimestamp(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function formatDelta(d: number): string {
  return `${d >= 0 ? '+' : ''}${d.toFixed(3)}`;
}

export function SafetyDriftPage() {
  const queryClient = useQueryClient();
  const latest = useQuery({
    queryKey: ['driftReport', 'latest'],
    queryFn: getLatestDriftReport,
  });

  const generate = useMutation({
    mutationFn: generateDriftReport,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['driftReport', 'latest'] });
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">AI 安全 / 人格漂移</h1>
          <p className="mt-1 text-sm text-chrono-text-muted">
            对比最近两次快照的价值权重变化；超过阈值时本地 Rust 端写审计 + 触发 webhook。
          </p>
        </div>
        <button
          type="button"
          className={clsx(
            'rounded-lg border border-chrono-border bg-chrono-elevated px-3 py-2 text-sm',
            generate.isPending && 'opacity-60',
          )}
          disabled={generate.isPending}
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? '分析中…' : '立即生成报告'}
        </button>
      </header>

      {latest.isLoading && (
        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-4 text-sm">
          加载中…
        </div>
      )}

      {latest.isError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          加载漂移报告失败：{latest.error instanceof Error ? latest.error.message : '未知错误'}
        </div>
      )}

      {!latest.isLoading && !latest.isError && latest.data === null && (
        <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-4 text-sm text-chrono-text-muted">
          尚无漂移报告，或 Rust 端命令 <code>get_latest_drift_report</code> 尚未实现。
          点击右上角「立即生成报告」尝试触发；若仍无响应，请确认 src-tauri 已注册命令处理器。
        </div>
      )}

      {latest.data && (
        <section className="rounded-xl border border-chrono-border bg-chrono-elevated p-4 space-y-3">
          <header className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">最近报告</h2>
              <p className="text-sm text-chrono-text-muted">
                生成于 {formatTimestamp(latest.data.analyzedAt)} · 基线{' '}
                {latest.data.baselineSnapshotId ?? '—'}
              </p>
            </div>
            <span
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-medium',
                ALERT_STYLE[latest.data.alertLevel],
              )}
            >
              {ALERT_LABEL[latest.data.alertLevel]}
            </span>
          </header>

          <div className="text-sm">
            综合漂移分：<strong>{latest.data.overallDriftScore.toFixed(3)}</strong>
          </div>

          {latest.data.valueDrifts.length === 0 ? (
            <p className="text-sm text-chrono-text-muted">
              本次分析没有可对比的价值变化（可能只有一份快照）。
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left border-b border-chrono-border">
                <tr>
                  <th className="py-2">价值</th>
                  <th className="py-2">基线</th>
                  <th className="py-2">当前</th>
                  <th className="py-2">变化</th>
                  <th className="py-2">告警</th>
                </tr>
              </thead>
              <tbody>
                {latest.data.valueDrifts.map((d) => (
                  <tr key={d.valueId} className="border-b border-chrono-border/50">
                    <td className="py-2 font-mono text-xs">{d.label || d.valueId}</td>
                    <td className="py-2">{d.baseline.toFixed(3)}</td>
                    <td className="py-2">{d.current.toFixed(3)}</td>
                    <td className="py-2 font-mono">{formatDelta(d.delta)}</td>
                    <td className="py-2">
                      <span
                        className={clsx(
                          'rounded-full border px-2 py-0.5 text-xs',
                          ALERT_STYLE[d.alertLevel],
                        )}
                      >
                        {ALERT_LABEL[d.alertLevel]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
