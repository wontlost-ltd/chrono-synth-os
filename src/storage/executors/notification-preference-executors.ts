/**
 * 通知偏好 SQL 执行器（ADR-0054 红线 9）。
 * per (tenant_id, user_id) 一行，upsert 覆盖。全部 tenant scoped。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  NotificationPreferenceRow,
  NotifPrefByUserParams,
  NotifPrefUpsertParams,
} from '@chrono/kernel';
import {
  NOTIF_PREF_QUERY_BY_USER,
  NOTIF_PREF_CMD_UPSERT,
} from '@chrono/kernel';

export function registerNotificationPreferenceExecutors(): void {
  registerQuery<NotificationPreferenceRow | null, NotifPrefByUserParams>(
    NOTIF_PREF_QUERY_BY_USER,
    (db, p) => {
      return db.prepare<NotificationPreferenceRow>(
        'SELECT * FROM notification_preferences WHERE tenant_id = ? AND user_id = ?',
      ).get(p.tenantId, p.userId) ?? null;
    },
  );

  registerCommand<NotifPrefUpsertParams>(NOTIF_PREF_CMD_UPSERT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO notification_preferences
         (tenant_id, user_id, nudge_push_enabled, quiet_start_minute, quiet_end_minute, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET
         nudge_push_enabled = excluded.nudge_push_enabled,
         quiet_start_minute = excluded.quiet_start_minute,
         quiet_end_minute = excluded.quiet_end_minute,
         updated_at = excluded.updated_at`,
    ).run(p.tenantId, p.userId, p.nudgePushEnabled ? 1 : 0, p.quietStartMinute, p.quietEndMinute, p.now);
    return { rowsAffected: result.changes };
  });
}
