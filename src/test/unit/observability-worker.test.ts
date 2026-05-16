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
});
