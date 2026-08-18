import type { RuntimeSyncStateV2 } from '@chrono/contracts';
import clsx from 'clsx';

interface SyncStateView {
  color: string;
  icon: string;
  label: string;
  pulse?: boolean;
}

const syncStateViews: Record<RuntimeSyncStateV2, SyncStateView> = {
/* 这些是 8px 装饰圆点（h-2 w-2），状态语义由相邻文字与 aria-label 承担，
 * 故用亮调 status token 而非 *-fill（后者是实色底承载白字时才需要的更深一档）。 */
  initial_sync: { color: 'bg-chrono-info', icon: '↻', label: 'Syncing…', pulse: true },
  online_synced: { color: 'bg-chrono-success', icon: '✓', label: 'Synced' },
  online_dirty: { color: 'bg-chrono-warning', icon: '●', label: 'Pending' },
  syncing: { color: 'bg-chrono-info', icon: '↻', label: 'Syncing…', pulse: true },
  offline_queueing: { color: 'bg-chrono-warning', icon: '↯', label: 'Offline' },
  /* 迁移脚本把原 bg-gray-400 机械映射成了 elevated——那正是徽章自身的底色，
   * 圆点直接隐形。改用 text-tertiary（相对徽章底 3.07，过非文本 AA 3.0），
   * 语义上也正好表达「静默/只读」。 */
  offline_readonly: { color: 'bg-chrono-text-tertiary', icon: '🔒', label: 'Read-only' },
  conflict_inbox: { color: 'bg-chrono-error', icon: '⚠', label: 'Conflicts' },
  degraded_remote: { color: 'bg-chrono-warning', icon: '⚡', label: 'Degraded' },
  reauth_required: { color: 'bg-chrono-error', icon: '✕', label: 'Re-auth' },
  recovery_required: { color: 'bg-chrono-error', icon: '✕', label: 'Recovery' },
  /* 单机模式：本地即真源，无远端同步——settled 绿点「本地」（非 Syncing 脉冲）。 */
  local: { color: 'bg-chrono-success', icon: '🖥', label: '本地' },
};

export function SyncBadge({ state }: { state: RuntimeSyncStateV2 }) {
  const view = syncStateViews[state];

  return (
    <span
      role="status"
      aria-label={`Sync status: ${view.label}`}
      className="inline-flex items-center gap-2 rounded-full border border-chrono-border bg-chrono-elevated px-2.5 py-1 text-xs font-medium text-chrono-text-primary"
    >
      <span
        className={clsx(
          'h-2 w-2 rounded-full',
          view.color,
          view.pulse && 'motion-safe:animate-pulse',
        )}
      />
      <span className="text-[11px] leading-none text-chrono-text-secondary">{view.icon}</span>
      <span className="leading-none">{view.label}</span>
    </span>
  );
}
