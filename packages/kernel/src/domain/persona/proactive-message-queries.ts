/**
 * 主动消息 outbound 队列的 Query/Command kind 契约（ADR-0054 Phase 2：主动性管道）。
 *
 * kernel 只声明形状；执行器在 src/storage/executors。数字人据内部信号「主动开口」的消息落此队列，
 * 客户端拉取未读 nudge。Phase 2 只建管道（enqueue / list / markRead），触发逻辑留待 Phase 3。
 *
 * 幂等（ADR-0054 红线 8）：enqueue 用 (tenant_id, persona_id, signal_type, source_id, signal_version)
 * 唯一索引，冲突即忽略——EventBus 重复投递同一信号最多落一条主动消息。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const PROACTIVE_MESSAGE_CMD_ENQUEUE = 'proactiveMessage.enqueue' as const;
export const PROACTIVE_MESSAGE_QUERY_LIST = 'proactiveMessage.list' as const;
export const PROACTIVE_MESSAGE_QUERY_BY_ID = 'proactiveMessage.byId' as const;
export const PROACTIVE_MESSAGE_QUERY_WINDOW_STATS = 'proactiveMessage.windowStats' as const;
export const PROACTIVE_MESSAGE_CMD_MARK_READ = 'proactiveMessage.markRead' as const;

/* ── Row ── */

export interface ProactiveMessageRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly signal_type: string;
  readonly source_id: string;
  readonly signal_version: number;
  readonly body: string;
  readonly kind: string;
  readonly status: string;
  readonly created_at: number;
  readonly read_at: number | null;
}

/* ── Params ── */

export interface ProactiveMessageEnqueueParams {
  id: string;
  tenantId: string;
  personaId: string;
  signalType: string;
  sourceId: string;
  signalVersion: number;
  body: string;
  kind: string;
  now: number;
}

export interface ProactiveMessageListParams {
  tenantId: string;
  personaId: string;
  /** 'unread' | 'read' | 'dismissed'；省略则取全部该 persona 的消息（最新在前）。 */
  status?: string;
  limit: number;
}

export interface ProactiveMessageByIdParams {
  id: string;
  tenantId: string;
  personaId: string;
}

export interface ProactiveMessageWindowStatsParams {
  tenantId: string;
  personaId: string;
  /** 频率上限窗口起点（epoch ms）：统计 created_at ≥ since 的消息数。 */
  since: number;
}

/** 窗口统计：用于 Gate 的频率上限（windowCount）+ 静默期（lastCreatedAt）。 */
export interface ProactiveMessageWindowStatsRow {
  readonly window_count: number;
  /** 该 persona 最近一条主动消息的 created_at（无则 null）。 */
  readonly last_created_at: number | null;
}

export interface ProactiveMessageMarkReadParams {
  id: string;
  tenantId: string;
  personaId: string;
  now: number;
}

/* ── 工厂 ── */

/**
 * 入队一条主动消息（幂等：信号唯一索引冲突即忽略，rowsAffected=0 表示该信号已入过队）。
 */
export function proactiveMessageCmdEnqueue(
  params: ProactiveMessageEnqueueParams,
): Command<ProactiveMessageEnqueueParams> {
  return { kind: PROACTIVE_MESSAGE_CMD_ENQUEUE, params };
}

/** 列出某 persona 的主动消息（可按 status 过滤，最新在前）。 */
export function proactiveMessageQueryList(
  params: ProactiveMessageListParams,
): Query<ProactiveMessageRow, ProactiveMessageListParams> {
  return { kind: PROACTIVE_MESSAGE_QUERY_LIST, params };
}

/** 窗口统计（窗口内消息数 + 最近一条时间）——供 Gate 的频率上限 + 静默期判定。 */
export function proactiveMessageQueryWindowStats(
  params: ProactiveMessageWindowStatsParams,
): Query<ProactiveMessageWindowStatsRow | null, ProactiveMessageWindowStatsParams> {
  return { kind: PROACTIVE_MESSAGE_QUERY_WINDOW_STATS, params };
}

/** 按 id 取某条主动消息（带租户/persona 归属，供 markRead 区分 404 vs 已读幂等）。 */
export function proactiveMessageQueryById(
  params: ProactiveMessageByIdParams,
): Query<ProactiveMessageRow | null, ProactiveMessageByIdParams> {
  return { kind: PROACTIVE_MESSAGE_QUERY_BY_ID, params };
}

/** 标记某条主动消息为已读（按 id + 租户/persona 归属，防跨租户改他人消息）。 */
export function proactiveMessageCmdMarkRead(
  params: ProactiveMessageMarkReadParams,
): Command<ProactiveMessageMarkReadParams> {
  return { kind: PROACTIVE_MESSAGE_CMD_MARK_READ, params };
}
