/**
 * 通知偏好 store（ADR-0054 红线 9）：per (tenant, user) 推送同意 + 安静时段。
 * 无 row → 回退 DEFAULT_NOTIFICATION_PREFERENCE（推送默认关，红线 9）。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  notifPrefQueryByUser,
  notifPrefCmdUpsert,
  DEFAULT_NOTIFICATION_PREFERENCE,
  type NotificationPreference,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';

/** 安静时段分钟数合法性：0..1439 整数或 null。非法 → null（不静默，安全侧）。 */
function sanitizeMinute(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number.isInteger(v) && v >= 0 && v <= 1439 ? v : null;
}

export class NotificationPreferenceStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly now: () => number,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /** 取某用户的通知偏好；无 row → DEFAULT（推送默认关）。 */
  get(userId: string): NotificationPreference {
    const row = this.tx.queryOne(notifPrefQueryByUser({ tenantId: this.tenantId, userId }));
    if (!row) return DEFAULT_NOTIFICATION_PREFERENCE;
    return {
      nudgePushEnabled: row.nudge_push_enabled === true || row.nudge_push_enabled === 1,
      quietStartMinute: sanitizeMinute(row.quiet_start_minute),
      quietEndMinute: sanitizeMinute(row.quiet_end_minute),
    };
  }

  /** upsert 某用户的通知偏好（安静时段分钟数越界 → null）。 */
  set(userId: string, pref: NotificationPreference): void {
    this.tx.execute(notifPrefCmdUpsert({
      tenantId: this.tenantId,
      userId,
      nudgePushEnabled: pref.nudgePushEnabled,
      quietStartMinute: sanitizeMinute(pref.quietStartMinute),
      quietEndMinute: sanitizeMinute(pref.quietEndMinute),
      now: this.now(),
    }));
  }
}
