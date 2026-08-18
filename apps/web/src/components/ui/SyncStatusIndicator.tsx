import { useTranslation } from 'react-i18next';
import type { RuntimeSyncStateV2 } from '@chrono/contracts';

interface SyncStatusIndicatorProps {
  state: RuntimeSyncStateV2;
  pendingCount?: number;
  className?: string;
}

/**
 * 状态点颜色走**语义 token 的 CSS 变量**而非硬编码 hex。
 *
 * 原先是 11 个写死的 hex（浅色主题刻度），有两个问题：
 *   1. 不随主题切换——在 dark 画布上 degraded 的 #9f2621 只有 2.63，
 *      低于非文本 UI 指示器的 AA 3.0；
 *   2. 硬编码色 `lint:raw-palette`（按类名匹配）与 `lint:contrast`
 *      （按 token 对计算）**两道门都看不见**。
 *
 * 点本身是 8px 且 aria-hidden，状态语义由相邻文本承担，故按非文本
 * 指示器要求（3.0）而非正文 4.5 来选值。
 */
const STATE_COLORS: Record<RuntimeSyncStateV2, string> = {
  initial_sync:      'var(--color-info)',
  online_synced:     'var(--color-success)',
  online_dirty:      'var(--color-info)',
  syncing:           'var(--color-syncing)',
  offline_queueing:  'var(--color-offline)',
  offline_readonly:  'var(--color-offline)',
  conflict_inbox:    'var(--color-warning)',
  degraded_remote:   'var(--color-error)',
  reauth_required:   'var(--color-warning)',
  recovery_required: 'var(--color-error)',
  /* 单机模式 settled 态（本地即真源，无远端同步）——绿点同 online_synced。 */
  local:             'var(--color-success)',
};

export function SyncStatusIndicator({
  state,
  pendingCount = 0,
  className,
}: SyncStatusIndicatorProps) {
  const { t } = useTranslation();
  const label = t(`syncStatus.${state}`);
  const ariaLabel = pendingCount > 0 ? `${label} (${pendingCount})` : label;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <span
        aria-hidden="true"
        style={{
          backgroundColor: STATE_COLORS[state],
          borderRadius: '9999px',
          display: 'inline-block',
          height: 8,
          width: 8,
        }}
      />
      <span>
        {label}
        {pendingCount > 0 ? ` (${pendingCount})` : null}
      </span>
    </span>
  );
}
