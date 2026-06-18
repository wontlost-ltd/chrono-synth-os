/**
 * 主动消息 outbound 队列 SQL 执行器（ADR-0054 Phase 2：主动性管道）。
 *
 * 全部 tenant scoped。enqueue 幂等（信号唯一索引冲突即忽略，红线 8）；markRead 按
 * id + tenant + persona 归属（红线 7，绝不跨租户改他人消息）。
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type {
  ProactiveMessageRow,
  ProactiveMessageEnqueueParams,
  ProactiveMessageListParams,
  ProactiveMessageByIdParams,
  ProactiveMessageWindowStatsParams,
  ProactiveMessageWindowStatsRow,
  ProactiveMessageMarkReadParams,
} from '@chrono/kernel';
import {
  PROACTIVE_MESSAGE_CMD_ENQUEUE,
  PROACTIVE_MESSAGE_QUERY_LIST,
  PROACTIVE_MESSAGE_QUERY_BY_ID,
  PROACTIVE_MESSAGE_QUERY_WINDOW_STATS,
  PROACTIVE_MESSAGE_CMD_MARK_READ,
} from '@chrono/kernel';

export function registerProactiveMessageExecutors(): void {
  /* ── Commands ── */

  /* 幂等入队：(tenant_id, persona_id, signal_type, source_id, signal_version) 唯一索引冲突即忽略
   * （ADR-0054 红线 8——EventBus 重复投递同一信号最多落一条）。rowsAffected=0 表示该信号已入过队。 */
  registerCommand<ProactiveMessageEnqueueParams>(PROACTIVE_MESSAGE_CMD_ENQUEUE, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO proactive_messages
         (id, tenant_id, persona_id, signal_type, source_id, signal_version, body, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?)
       ON CONFLICT (tenant_id, persona_id, signal_type, source_id, signal_version) DO NOTHING`,
    ).run(p.id, p.tenantId, p.personaId, p.signalType, p.sourceId, p.signalVersion, p.body, p.kind, p.now);
    return { rowsAffected: result.changes };
  });

  /* 标记已读：按 id + tenant + persona 归属（红线 7）；仅当当前未读才置 read（已读不重写 read_at）。 */
  registerCommand<ProactiveMessageMarkReadParams>(PROACTIVE_MESSAGE_CMD_MARK_READ, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE proactive_messages
         SET status = 'read', read_at = ?
       WHERE id = ? AND tenant_id = ? AND persona_id = ? AND status = 'unread'`,
    ).run(p.now, p.id, p.tenantId, p.personaId);
    return { rowsAffected: result.changes };
  });

  /* ── Queries ── */

  /* 列出某 persona 的主动消息（可按 status 过滤，最新在前；幂等键已防重，无需 distinct）。 */
  registerQuery<readonly ProactiveMessageRow[], ProactiveMessageListParams>(PROACTIVE_MESSAGE_QUERY_LIST, (db, p) => {
    if (p.status !== undefined) {
      return db.prepare<ProactiveMessageRow>(
        `SELECT * FROM proactive_messages
         WHERE tenant_id = ? AND persona_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?`,
      ).all(p.tenantId, p.personaId, p.status, p.limit);
    }
    return db.prepare<ProactiveMessageRow>(
      `SELECT * FROM proactive_messages
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(p.tenantId, p.personaId, p.limit);
  });

  /* 按 id 取（带归属，红线 7）——供 route 区分「不存在=404」与「已读=幂等 200」。 */
  registerQuery<ProactiveMessageRow | null, ProactiveMessageByIdParams>(PROACTIVE_MESSAGE_QUERY_BY_ID, (db, p) => {
    return db.prepare<ProactiveMessageRow>(
      'SELECT * FROM proactive_messages WHERE id = ? AND tenant_id = ? AND persona_id = ?',
    ).get(p.id, p.tenantId, p.personaId) ?? null;
  });

  /* 窗口统计（频率上限 + 静默期）：窗口内消息数 + 该 persona 最近一条 created_at。 */
  registerQuery<ProactiveMessageWindowStatsRow | null, ProactiveMessageWindowStatsParams>(
    PROACTIVE_MESSAGE_QUERY_WINDOW_STATS,
    (db, p) => {
      const row = db.prepare<{ window_count: number | bigint; last_created_at: number | bigint | null }>(
        `SELECT
           COUNT(CASE WHEN created_at >= ? THEN 1 END) AS window_count,
           MAX(created_at) AS last_created_at
         FROM proactive_messages
         WHERE tenant_id = ? AND persona_id = ?`,
      ).get(p.since, p.tenantId, p.personaId);
      if (!row) return { window_count: 0, last_created_at: null };
      return {
        window_count: Number(row.window_count),
        last_created_at: row.last_created_at === null ? null : Number(row.last_created_at),
      };
    },
  );
}
