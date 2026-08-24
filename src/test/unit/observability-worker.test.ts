import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { SilentLogger } from '../../utils/logger.js';
import {
  OBSERVABILITY_TOPIC,
  getObservabilityRollup,
  markObservabilityEventProcessing,
  publishObservabilityEvent,
  requeueStaleObservabilityEvents,
  resetObservabilityPipelineMetrics,
} from '../../observability/observability-outbox.js';
import { applyObservabilityStoredEvent } from '../../observability/observability-rollups.js';
import { ObservabilityWorker } from '../../observability/observability-worker.js';
import { getPlatformDlqBacklog } from '../../events/platform-dlq.js';

describe('ObservabilityWorker', () => {
  let db: IDatabase;
  let logger: SilentLogger;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    logger = new SilentLogger();
    resetObservabilityPipelineMetrics();
  });

  it('将待处理观测事件聚合到租户 rollup', async () => {
    publishObservabilityEvent(db, {
      tenantId: 'tenant_obs',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'rs_1',
      payload: { durationMs: 1200, updatedAt: 1000 },
    });
    publishObservabilityEvent(db, {
      tenantId: 'tenant_obs',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'task.outcome',
      partitionKey: 'task_1',
      payload: { outcome: 'accepted', terminal: true, success: true, updatedAt: 1000 },
    });
    publishObservabilityEvent(db, {
      tenantId: 'tenant_obs',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'wallet.settlement_completed',
      partitionKey: 'wallet_1',
      payload: { totalAmountMinor: 18000, latencyMs: 900, updatedAt: 1000 },
    });
    publishObservabilityEvent(db, {
      tenantId: 'tenant_obs',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'governance.case_opened',
      partitionKey: 'case_1',
      payload: { updatedAt: 1000 },
    });
    publishObservabilityEvent(db, {
      tenantId: 'tenant_obs',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'governance.action_applied',
      partitionKey: 'case_1',
      payload: { previousStatus: 'open', caseStatus: 'action_applied', updatedAt: 1000 },
    });
    publishObservabilityEvent(db, {
      tenantId: 'tenant_obs',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'persona.growth_recorded',
      partitionKey: 'persona_1',
      payload: { growthDelta: 3.5, reputationDelta: 1.25, updatedAt: 1000 },
    });

    const worker = new ObservabilityWorker(db, logger, { batchSize: 10 });
    const result = await worker.flush();

    assert.equal(result.processed, 6);
    assert.equal(result.failed, 0);
    assert.equal(result.backlog.pending, 0);

    const rollup = getObservabilityRollup(db, 'tenant_obs');
    assert.equal(rollup.runtime_completed_count, 1);
    assert.equal(rollup.runtime_duration_total_ms, 1200);
    assert.equal(rollup.task_terminal_count, 1);
    assert.equal(rollup.task_success_count, 1);
    assert.equal(rollup.wallet_settlement_count, 1);
    assert.equal(rollup.wallet_settlement_total_amount_minor, 18000);
    assert.equal(rollup.wallet_settlement_latency_total_ms, 900);
    assert.equal(rollup.governance_case_opened_count, 1);
    assert.equal(rollup.governance_case_active_count, 0);
    assert.equal(rollup.governance_action_applied_count, 1);
    assert.equal(rollup.persona_growth_total, 3.5);
    assert.equal(rollup.persona_growth_event_count, 1);
    assert.equal(rollup.persona_reputation_delta_total, 1.25);
  });

  it('会回收卡在 processing 的陈旧事件', async () => {
    const eventId = publishObservabilityEvent(db, {
      tenantId: 'tenant_obs',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'rs_stale',
      payload: { durationMs: 300 },
    });
    assert.equal(markObservabilityEventProcessing(db, eventId), true);
    db.prepare<void>(
      'UPDATE observability_outbox SET processed_at = ? WHERE id = ?',
    ).run(Date.now() - 10_000, eventId);

    const worker = new ObservabilityWorker(db, logger, {
      batchSize: 10,
      staleProcessingMs: 500,
    });
    const result = await worker.flush();

    assert.equal(result.recovered, 1);
    assert.equal(result.processed, 1);
    assert.equal(getObservabilityRollup(db, 'tenant_obs').runtime_completed_count, 1);
  });

  it('处理失败达到上限后会把消息写入 DLQ', async () => {
    const eventId = publishObservabilityEvent(db, {
      tenantId: 'tenant_obs',
      topic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'runtime_bad',
      payload: { durationMs: 123 },
    });

    db.prepare<void>(
      `UPDATE observability_outbox
       SET payload_json = ?
       WHERE id = ?`,
    ).run('"invalid-payload"', eventId);

    const worker = new ObservabilityWorker(db, logger, {
      batchSize: 10,
      maxAttempts: 1,
    });
    const result = await worker.flush();

    assert.equal(result.failed, 1);
    assert.equal(getPlatformDlqBacklog(db).pending, 1);

    const failedRow = db.prepare<{ status: string }>(
      `SELECT status FROM observability_outbox WHERE id = ?`,
    ).get(eventId);
    assert.equal(failedRow?.status, 'failed');
  });

  it('同一观测事件重复应用时只累计一次 rollup', () => {
    const appliedFirst = applyObservabilityStoredEvent(db, {
      id: 'obevt_dedupe',
      tenantId: 'tenant_obs',
      eventType: 'task.outcome',
      payload: {
        outcome: 'completed',
        terminal: true,
        success: true,
        updatedAt: 2000,
      },
      createdAt: 2000,
    });
    const appliedSecond = applyObservabilityStoredEvent(db, {
      id: 'obevt_dedupe',
      tenantId: 'tenant_obs',
      eventType: 'task.outcome',
      payload: {
        outcome: 'completed',
        terminal: true,
        success: true,
        updatedAt: 2000,
      },
      createdAt: 2000,
    });

    const rollup = getObservabilityRollup(db, 'tenant_obs');
    assert.equal(appliedFirst, true);
    assert.equal(appliedSecond, false);
    assert.equal(rollup.task_terminal_count, 1);
    assert.equal(rollup.task_success_count, 1);
  });

  /* ── issue #380：stale 判定必须由数据库单一时钟裁决 ────────────── */
  describe('stale 回收的时钟来源（issue #380）', () => {
    /**
     * 缺陷：认领方写自己的 `Date.now()` 进 `processed_at`，回收方用自己的
     * `Date.now() - staleProcessingMs` 算截止点 —— 而 outbox 是**跨进程**共享的
     * （k8s 实测：API 2 副本各自起 ObservabilityPipelineService + worker 1 副本，
     * 三进程一张表）。两侧机器钟差会直接平移判定：
     * 实测钟差 > staleProcessingMs 时，**正在处理中的事件被回收 → 重复投递**。
     *
     * 修法：`processed_at` 由 DB 盖戳、截止点也由 DB 算，调用方只传**时长**。
     * 于是「调用方的时钟」在结构上无法参与判定 —— 这是注入 Clock 治不了的一类问题
     * （跨机器物理钟差依然存在）。
     */
    const STALE_MS = 5 * 60 * 1000;

    /** 发一条事件并认领，返回其 id。 */
    function claimOne(partitionKey: string): string {
      publishObservabilityEvent(db, {
        tenantId: 'tenant_stale',
        topic: OBSERVABILITY_TOPIC,
        eventType: 'runtime.completed',
        partitionKey,
        payload: { durationMs: 1, updatedAt: 1000 },
      });
      const row = db.prepare<{ id: string }>(
        `SELECT id FROM observability_outbox WHERE partition_key = ?`,
      ).all(partitionKey)[0];
      assert.ok(row?.id, '前置：事件应已入库');
      assert.ok(markObservabilityEventProcessing(db, row.id), '前置：应能认领');
      return row.id;
    }

    const statusOf = (id: string): string | undefined =>
      db.prepare<{ status: string }>(
        `SELECT status FROM observability_outbox WHERE id = ?`,
      ).all(id)[0]?.status;

    it('刚认领的事件不得被回收；真正卡住的必须被回收', () => {
      /* ⚠️ 两条一起断言：只测「不误收」会被「干脆不回收」蒙混过关，
       * 只测「能回收」会被「全部回收」蒙混过关。 */
      const fresh = claimOne('fresh_1');
      const stuck = claimOne('stuck_1');
      /* 把 stuck 的认领时刻改到 10 分钟前（模拟消费者崩溃后卡住）。 */
      db.prepare<void>(
        `UPDATE observability_outbox SET processed_at = ? WHERE id = ?`,
      ).run(Date.now() - 10 * 60 * 1000, stuck);

      const recovered = requeueStaleObservabilityEvents(db, STALE_MS);

      assert.equal(recovered, 1, '应恰好回收 1 条');
      assert.equal(statusOf(fresh), 'processing', '刚认领的不得被回收');
      assert.equal(statusOf(stuck), 'pending', '卡住的必须被回收');
    });

    it('★核心★ 调用方的时钟无法影响判定（钟差不再改变结果）', () => {
      /* 修复前：回收方传的是「本机 now - STALE_MS」，钟差直接平移截止点，
       * 实测 B 比 A 快 6 分钟即可把 processing 中的事件误收成 pending。
       * 修复后：接口只收**时长**，调用方**没有任何入口**可以注入自己的时刻 ——
       * 故无论钟差多大，刚认领的事件都不会被回收。
       *
       * 这条用例同时钉死了接口形状：若有人把参数改回「绝对截止点」，
       * 下面这些调用会在类型层就失败（staleProcessingMs 是时长语义）。 */
      const fresh = claimOne('fresh_2');

      /* 用远大于任何真实钟差的时长反复回收：结果必须恒定。 */
      for (const ms of [STALE_MS, 60_000, 1_000]) {
        requeueStaleObservabilityEvents(db, ms);
        assert.equal(statusOf(fresh), 'processing',
          `传入时长 ${ms}ms 时，刚认领的事件仍不得被回收`);
      }
    });

    it('★核心★ processed_at 由数据库盖戳（不是应用进程的时钟）', () => {
      /* ⚠️ 上一条只钉死了「回收侧不能注入时刻」，**没有**钉死「认领侧的时间戳来自 DB」。
       * 变异实测证明了这个缺口：把认领侧改回应用时钟并注入 +6 分钟钟差，
       * 上面所有用例**仍然全绿** —— 而那正是本 issue 的缺陷本体。
       *
       * 判据：认领写下的 processed_at 必须落在**数据库当下**的邻域内。
       * SQLite 的 strftime 只有秒级精度（实测比 Date.now() 落后 0–999ms），
       * 故容差取 2 秒；任何进程级钟差（分钟级）都会远超它。 */
      const id = claimOne('dbstamp_1');
      const stamped = db.prepare<{ p: number }>(
        `SELECT processed_at AS p FROM observability_outbox WHERE id = ?`,
      ).all(id)[0]?.p;
      assert.ok(stamped, '认领应写下 processed_at');

      const dbNow = db.prepare<{ ms: number }>(
        `SELECT (CAST(strftime('%s','now') AS INTEGER) * 1000) AS ms`,
      ).all()[0]!.ms;

      assert.ok(Math.abs(Number(dbNow) - Number(stamped)) <= 2000,
        `processed_at 应由 DB 盖戳（DB 当下 ${dbNow} vs 实际 ${stamped}，`
        + '差值过大说明用的是应用进程时钟）');
    });
  });
});
