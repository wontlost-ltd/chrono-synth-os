/**
 * 可观测性 Outbox SQL 执行器 — 将内核 Query/Command kind 映射到 db.prepare 调用
 */

import { registerQuery, registerCommand } from '../legacy-sync-bridge.js';
import type { IDatabase } from '../database.js';

/**
 * 「数据库当前时刻」的毫秒 epoch 表达式（issue #380）。
 *
 * 为什么必须是 DB 侧时间：outbox 由**多个进程**共享（k8s 实测 API 2 副本 + worker 1 副本），
 * 认领与回收若各用本机 `Date.now()`，机器钟差会直接平移 stale 判定。
 * 让两侧都取同一个 DB 时钟，物理上消除多时钟 —— 这是注入 Clock 解决不了的一类问题。
 *
 * 方言差异（均已实测）：
 *   - PG    ：`now()` 在**事务内冻结**，正是我们要的语义（认领与回收各自单语句，互不干扰）；
 *             `EXTRACT(EPOCH FROM now())*1000` 得毫秒，`::bigint` 落 INTEGER 列。
 *   - SQLite：`strftime('%s','now')` 只有**秒级**精度（实测与 Date.now() 差 <1s）。
 *             对 staleProcessingMs 最小 1000ms、默认 5min 的窗口无实质影响。
 *
 * ⚠️ **PG 分支目前无自动化测试覆盖**：全仓没有跑 observability outbox 的 PG 集成测试
 * （单测走 SQLite）。我在真实 PG 17 上手工对拍过本分支（fresh 保持 processing、
 * stuck 被回收，与 SQLite 行为一致），但那不是可复现的门。
 * 若后续给 outbox 补 PG 集成测试，请优先覆盖这两条 SQL。
 *
 * ⚠️ 返回的是 **SQL 片段**而非参数：时间必须由数据库求值，一旦变成占位符参数就又回到
 * 「应用侧时钟」，缺陷原样复现。故此处刻意拼接常量片段（无外部输入，不构成注入面）。
 */
function dbNowMs(db: IDatabase): string {
  return db.dialect === 'postgres'
    ? '(EXTRACT(EPOCH FROM now()) * 1000)::bigint'
    : "(CAST(strftime('%s','now') AS INTEGER) * 1000)";
}

import type {
  ObsOutboxRow, ObsRollupRow,
  ObsPublishEventParams, ObsRequeueStaleParams,
  ObsMarkProcessingParams, ObsMarkSentParams, ObsMarkFailedParams,
  ObsApplyRollupDeltaParams, ObsClaimEventParams,
} from '@chrono/kernel';
import {
  OBS_QUERY_PENDING_EVENTS, OBS_QUERY_BACKLOG_PENDING,
  OBS_QUERY_BACKLOG_PROCESSING, OBS_QUERY_BACKLOG_FAILED, OBS_QUERY_ROLLUP,
  OBS_CMD_PUBLISH_EVENT, OBS_CMD_REQUEUE_STALE,
  OBS_CMD_MARK_PROCESSING, OBS_CMD_MARK_SENT, OBS_CMD_MARK_FAILED,
  OBS_CMD_APPLY_ROLLUP_DELTA, OBS_CMD_CLAIM_EVENT,
} from '@chrono/kernel';

export function registerObservabilityOutboxExecutors(): void {
  /* ── Queries ── */

  registerQuery<readonly ObsOutboxRow[], number>(OBS_QUERY_PENDING_EVENTS, (db, limit) => {
    return db.prepare<ObsOutboxRow>(
      `SELECT * FROM observability_outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(limit);
  });

  registerQuery<{ count: number } | null, void>(OBS_QUERY_BACKLOG_PENDING, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'pending'`,
    ).get() ?? null;
  });

  registerQuery<{ count: number } | null, void>(OBS_QUERY_BACKLOG_PROCESSING, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'processing'`,
    ).get() ?? null;
  });

  registerQuery<{ count: number } | null, void>(OBS_QUERY_BACKLOG_FAILED, (db) => {
    return db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM observability_outbox WHERE status = 'failed'`,
    ).get() ?? null;
  });

  registerQuery<ObsRollupRow | null, string>(OBS_QUERY_ROLLUP, (db, tenantId) => {
    return db.prepare<ObsRollupRow>(
      'SELECT * FROM observability_rollups WHERE tenant_id = ? LIMIT 1',
    ).get(tenantId) ?? null;
  });

  /* ── Commands ── */

  registerCommand<ObsPublishEventParams>(OBS_CMD_PUBLISH_EVENT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO observability_outbox (
        id, tenant_id, topic, event_type, partition_key, payload_json,
        status, attempts, created_at, processed_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL)`,
    ).run(p.id, p.tenantId, p.topic, p.eventType, p.partitionKey, p.payloadJson, p.now);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsRequeueStaleParams>(OBS_CMD_REQUEUE_STALE, (db, p) => {
    /* 「现在」取自**数据库**而非调用方进程 —— 与 MARK_PROCESSING 同源（见下方注释）。
     * 故这里收的是**时长**，截止点在 SQL 里用同一个 DB 时钟算出。 */
    const result = db.prepare<void>(
      `UPDATE observability_outbox
       SET status = 'pending', processed_at = NULL
       WHERE status = 'processing' AND processed_at IS NOT NULL
         AND processed_at < ${dbNowMs(db)} - ?`,
    ).run(p.staleProcessingMs);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsMarkProcessingParams>(OBS_CMD_MARK_PROCESSING, (db, p) => {
    /* ⚠️ `processed_at` 由**数据库**盖戳，不接受应用传入的时间（issue #380）。
     *
     * outbox 是跨进程共享的：k8s 实测 API 2 副本各自起 ObservabilityPipelineService、
     * 外加 worker 1 副本 —— 三个进程、三台机器消费同一张表。
     * 认领方写自己的 `Date.now()`、回收方用自己的 `Date.now()` 算截止点时，
     * 两者钟差会直接平移 stale 判定：实测钟差 > staleProcessingMs（默认 5min）时，
     * **正在处理中的事件被判为 stale 重新入队 → 重复投递**。
     *
     * 让 DB 当唯一时钟即可物理消除该问题（注入 Clock 治不了：跨机器的物理钟差依然存在）。 */
    const result = db.prepare<void>(
      `UPDATE observability_outbox
       SET status = 'processing', processed_at = ${dbNowMs(db)}
       WHERE id = ? AND status = 'pending'`,
    ).run(p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsMarkSentParams>(OBS_CMD_MARK_SENT, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE observability_outbox
       SET status = 'sent', processed_at = ?, last_error = NULL
       WHERE id = ?`,
    ).run(p.now, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsMarkFailedParams>(OBS_CMD_MARK_FAILED, (db, p) => {
    const result = db.prepare<void>(
      `UPDATE observability_outbox
       SET attempts = ?, last_error = ?, processed_at = ?, status = ?
       WHERE id = ?`,
    ).run(p.attempts, p.error, p.now, p.status, p.id);
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsApplyRollupDeltaParams>(OBS_CMD_APPLY_ROLLUP_DELTA, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO observability_rollups (
        tenant_id,
        runtime_completed_count, runtime_duration_total_ms,
        task_terminal_count, task_success_count, task_rejected_count, task_disputed_count,
        wallet_settlement_count, wallet_settlement_total_amount_minor, wallet_settlement_latency_total_ms,
        governance_case_opened_count, governance_case_active_count, governance_action_applied_count,
        persona_growth_total, persona_growth_event_count, persona_reputation_delta_total,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        runtime_completed_count = observability_rollups.runtime_completed_count + excluded.runtime_completed_count,
        runtime_duration_total_ms = observability_rollups.runtime_duration_total_ms + excluded.runtime_duration_total_ms,
        task_terminal_count = observability_rollups.task_terminal_count + excluded.task_terminal_count,
        task_success_count = observability_rollups.task_success_count + excluded.task_success_count,
        task_rejected_count = observability_rollups.task_rejected_count + excluded.task_rejected_count,
        task_disputed_count = observability_rollups.task_disputed_count + excluded.task_disputed_count,
        wallet_settlement_count = observability_rollups.wallet_settlement_count + excluded.wallet_settlement_count,
        wallet_settlement_total_amount_minor = observability_rollups.wallet_settlement_total_amount_minor + excluded.wallet_settlement_total_amount_minor,
        wallet_settlement_latency_total_ms = observability_rollups.wallet_settlement_latency_total_ms + excluded.wallet_settlement_latency_total_ms,
        governance_case_opened_count = observability_rollups.governance_case_opened_count + excluded.governance_case_opened_count,
        governance_case_active_count = CASE
          WHEN observability_rollups.governance_case_active_count + excluded.governance_case_active_count < 0 THEN 0
          ELSE observability_rollups.governance_case_active_count + excluded.governance_case_active_count
        END,
        governance_action_applied_count = observability_rollups.governance_action_applied_count + excluded.governance_action_applied_count,
        persona_growth_total = observability_rollups.persona_growth_total + excluded.persona_growth_total,
        persona_growth_event_count = observability_rollups.persona_growth_event_count + excluded.persona_growth_event_count,
        persona_reputation_delta_total = observability_rollups.persona_reputation_delta_total + excluded.persona_reputation_delta_total,
        updated_at = excluded.updated_at`,
    ).run(
      p.tenantId,
      p.runtimeCompletedCount, p.runtimeDurationTotalMs,
      p.taskTerminalCount, p.taskSuccessCount, p.taskRejectedCount, p.taskDisputedCount,
      p.walletSettlementCount, p.walletSettlementTotalAmountMinor, p.walletSettlementLatencyTotalMs,
      p.governanceCaseOpenedCount, p.governanceCaseActiveCount, p.governanceActionAppliedCount,
      p.personaGrowthTotal, p.personaGrowthEventCount, p.personaReputationDeltaTotal,
      p.updatedAt,
    );
    return { rowsAffected: result.changes };
  });

  registerCommand<ObsClaimEventParams>(OBS_CMD_CLAIM_EVENT, (db, p) => {
    const result = db.prepare<void>(
      `INSERT INTO observability_processed_events (
        event_id, tenant_id, event_type, processed_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING`,
    ).run(p.eventId, p.tenantId, p.eventType, p.processedAt);
    return { rowsAffected: result.changes };
  });
}
