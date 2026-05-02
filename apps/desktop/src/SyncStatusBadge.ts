import { color, syncStateLabelsEn } from '@chrono/contracts';
import type { RuntimeSyncStateV1 } from '@chrono/contracts';

export interface SyncStatusBadgeOptions {
  readonly state: RuntimeSyncStateV1;
  readonly conflictCount?: number;
}

export function renderSyncStatusBadge(target: HTMLElement, options: SyncStatusBadgeOptions): void {
  const label = options.conflictCount && options.conflictCount > 0
    ? `${syncStateLabelsEn[options.state]} (${options.conflictCount})`
    : syncStateLabelsEn[options.state];

  target.replaceChildren();
  const badge = document.createElement('span');
  badge.textContent = label;
  badge.style.display = 'inline-flex';
  badge.style.alignItems = 'center';
  badge.style.minHeight = '28px';
  badge.style.borderRadius = '6px';
  badge.style.padding = '4px 10px';
  badge.style.font = '500 13px system-ui, sans-serif';
  badge.style.color = color.status[options.state];
  badge.style.background = `${color.status[options.state]}1A`;
  badge.setAttribute('aria-label', `Sync status: ${label}`);
  target.append(badge);
}
