/**
 * 时间感知（ADR-0056 类人化：存在的连续性）——确定性、零-LLM。
 *
 * 数字人对「时间在流逝」有觉察：好久不见了、又见面了、我们认识 N 天了。基于 relationship 已存的
 * last_seen_at / first_met_at + 当前时刻 now 确定性计算——相同 (lastSeen, firstMet, now) → 相同结果，
 * 可复现。问候只在对话「开头/久别重逢」时出现（同 session 连续聊不每句打招呼，避免烦人）。
 *
 * 时区说明：gap（间隔）与时区无关，最稳。timeOfDay（深夜/早安）依赖用户本地时区——本版用 UTC 粗算，
 * 对跨时区用户可能不准，登记为后续（按 Accept-Language/用户设置推断时区）。
 */

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** 距上次见面的间隔档。 */
export type TimeGap =
  | 'first'        /* 第一次见面（lastSeen 为 null） */
  | 'longGap'      /* 好久不见（> LONG_GAP_DAYS 天） */
  | 'dayGap'       /* 隔天/隔段时间又见（> DAY_GAP_HOURS 小时） */
  | 'sameSession';  /* 同一段对话内（间隔短，不重复打招呼） */

/** 好久不见阈值（天）。 */
const LONG_GAP_DAYS = 3;
/** 隔段时间阈值（小时）。 */
const DAY_GAP_HOURS = 12;

/** 计算距上次见面的间隔档（确定性）。 */
export function timeGap(lastSeenAt: number | null, now: number): TimeGap {
  if (lastSeenAt === null || !Number.isFinite(lastSeenAt)) return 'first';
  /* now 非有限（理论不应发生，纯函数容错）→ 当作同段对话，不冒充久别重逢。 */
  if (!Number.isFinite(now)) return 'sameSession';
  const elapsed = Math.max(0, now - lastSeenAt);
  if (elapsed > LONG_GAP_DAYS * MS_PER_DAY) return 'longGap';
  if (elapsed > DAY_GAP_HOURS * MS_PER_HOUR) return 'dayGap';
  return 'sameSession';
}

/** 认识多少天（first_met 到 now，向下取整；null/未来 → 0）。 */
export function daysSinceFirstMet(firstMetAt: number | null, now: number): number {
  if (firstMetAt === null || !Number.isFinite(firstMetAt)) return 0;
  return Math.max(0, Math.floor((now - firstMetAt) / MS_PER_DAY));
}

/** 一天中的时段（按 UTC 小时粗算；时区敏感，登记后续按用户时区）。 */
export type TimeOfDay = 'lateNight' | 'morning' | 'afternoon' | 'evening' | 'day';

/** 按 now 的 UTC 小时判时段。 */
export function timeOfDayUtc(now: number): TimeOfDay {
  if (!Number.isFinite(now)) return 'day';
  const h = new Date(now).getUTCHours();
  if (h >= 0 && h < 5) return 'lateNight';   // 0-5 点 深夜
  if (h >= 5 && h < 11) return 'morning';     // 5-11 点 早上
  if (h >= 11 && h < 17) return 'afternoon';  // 11-17 点 下午
  if (h >= 17 && h < 22) return 'evening';    // 17-22 点 晚上
  return 'lateNight';                          // 22-24 点 深夜
}
