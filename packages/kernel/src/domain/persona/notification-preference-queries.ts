/**
 * 通知偏好（notification_preferences）的 Query/Command kind 契约（ADR-0054 红线 9）。
 *
 * per (tenant_id, user_id) 一行——主动消息系统推送的总开关 + 安静时段。无 row → 调用方回退
 * DEFAULT_NOTIFICATION_PREFERENCE（推送默认关，红线 9）。kernel 只声明形状；执行器在 storage。
 */

import type { Query, Command } from '../../ports/query.js';

export const NOTIF_PREF_QUERY_BY_USER = 'notifPref.byUser' as const;
export const NOTIF_PREF_CMD_UPSERT = 'notifPref.upsert' as const;

/* ── Row ── */

export interface NotificationPreferenceRow {
  readonly tenant_id: string;
  readonly user_id: string;
  /** 0/1（SQLite）或 boolean（PG）——执行器归一为 boolean。 */
  readonly nudge_push_enabled: number | boolean;
  readonly quiet_start_minute: number | null;
  readonly quiet_end_minute: number | null;
  readonly updated_at: number;
}

/* ── Params ── */

export interface NotifPrefByUserParams {
  tenantId: string;
  userId: string;
}

export interface NotifPrefUpsertParams {
  tenantId: string;
  userId: string;
  nudgePushEnabled: boolean;
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  now: number;
}

/* ── 工厂 ── */

/** 取某用户的通知偏好（无 row → 调用方回退 DEFAULT_NOTIFICATION_PREFERENCE）。 */
export function notifPrefQueryByUser(
  params: NotifPrefByUserParams,
): Query<NotificationPreferenceRow | null, NotifPrefByUserParams> {
  return { kind: NOTIF_PREF_QUERY_BY_USER, params };
}

/** upsert：一用户一行，覆盖更新（偏好是当前生效配置）。 */
export function notifPrefCmdUpsert(
  params: NotifPrefUpsertParams,
): Command<NotifPrefUpsertParams> {
  return { kind: NOTIF_PREF_CMD_UPSERT, params };
}
