/**
 * 通知投递门控（ADR-0054 红线 9）——「该不该给用户发系统推送」的确定性纯函数。
 *
 * 与会话内 in-app nudge（SSE，默认开）不同：移动/桌面 OS 系统通知是侵入性更强的 consent 面，
 * 必须**默认关闭**、用户显式开启，且尊重**安静时段**（夜间不打扰）。本模块只做节制判定，零 LLM、纯函数。
 */

/** 用户的通知偏好（来自 notification_preferences 表）。 */
export interface NotificationPreference {
  /** 主动消息系统推送总开关。**默认 false**（红线 9：默认关，显式同意才开）。 */
  readonly nudgePushEnabled: boolean;
  /** 安静时段起（当地时间「分钟数」0..1439）；null = 无安静时段。 */
  readonly quietStartMinute: number | null;
  /** 安静时段止（当地时间「分钟数」0..1439）；null = 无安静时段。可小于 start 表示跨午夜。 */
  readonly quietEndMinute: number | null;
}

/** 默认偏好——红线 9：推送默认关闭，无安静时段（开启后由用户自定义）。 */
export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = {
  nudgePushEnabled: false,
  quietStartMinute: null,
  quietEndMinute: null,
};

export interface NotificationGateDecision {
  readonly deliver: boolean;
  readonly reason: 'ok' | 'disabled' | 'quiet_hours';
}

/**
 * 当前「分钟数」是否落在安静时段内（含跨午夜的环形区间）。
 * start===end 视为空区间（不静默，避免「全天静默」歧义）。
 */
export function isWithinQuietHours(nowMinute: number, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) {
    /* 同日区间：[start, end)。 */
    return nowMinute >= startMinute && nowMinute < endMinute;
  }
  /* 跨午夜：[start, 1440) ∪ [0, end)。 */
  return nowMinute >= startMinute || nowMinute < endMinute;
}

/**
 * 判定是否该投递系统推送（纯函数，确定性）。
 *   - 推送总开关关 → disabled（红线 9 默认关）。
 *   - 处于安静时段 → quiet_hours（不夜间打扰）。
 *   - 否则 ok。
 * `localNowMinute`：用户当地时间的当日分钟数（0..1439）——时区换算由调用方做（本函数不碰时区）。
 */
export function evaluateNotificationGate(
  pref: NotificationPreference,
  localNowMinute: number,
): NotificationGateDecision {
  if (!pref.nudgePushEnabled) return { deliver: false, reason: 'disabled' };
  if (pref.quietStartMinute !== null && pref.quietEndMinute !== null
    && isWithinQuietHours(localNowMinute, pref.quietStartMinute, pref.quietEndMinute)) {
    return { deliver: false, reason: 'quiet_hours' };
  }
  return { deliver: true, reason: 'ok' };
}
