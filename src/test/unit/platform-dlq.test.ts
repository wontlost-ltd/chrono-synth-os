import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import {
  getPlatformDlqBacklog,
  listPlatformDlqEvents,
  recordPlatformDlqEvent,
  replayPlatformDlqEvent,
} from '../../events/platform-dlq.js';
import { OBSERVABILITY_TOPIC } from '../../observability/observability-outbox.js';

describe('Platform DLQ', () => {
  let db: IDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
  });

  it('会把事件存入按领域分流的 DLQ 主题', () => {
    const runtimeId = recordPlatformDlqEvent(db, {
      tenantId: 'tenant_dlq',
      sourceComponent: 'observability_worker',
      sourceTopic: OBSERVABILITY_TOPIC,
      eventType: 'task.outcome',
      partitionKey: 'task_1',
      payload: { outcome: 'accepted' },
      errorMessage: 'boom',
    });
    const walletId = recordPlatformDlqEvent(db, {
      tenantId: 'tenant_dlq',
      sourceComponent: 'observability_worker',
      sourceTopic: OBSERVABILITY_TOPIC,
      eventType: 'wallet.settlement_completed',
      partitionKey: 'wallet_1',
      payload: { totalAmountMinor: 1000 },
      errorMessage: 'boom',
    });

    const rows = listPlatformDlqEvents(db, 'tenant_dlq', 10);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === runtimeId)?.dlqTopic, 'runtime.dlq');
    assert.equal(rows.find((row) => row.id === walletId)?.dlqTopic, 'wallet.dlq');
    assert.equal(getPlatformDlqBacklog(db).pending, 2);
  });

  it('支持把可重放的 observability DLQ 事件重新入队', () => {
    const id = recordPlatformDlqEvent(db, {
      tenantId: 'tenant_dlq',
      sourceComponent: 'observability_worker',
      sourceTopic: OBSERVABILITY_TOPIC,
      eventType: 'runtime.completed',
      partitionKey: 'runtime_1',
      payload: { durationMs: 200, updatedAt: 1000 },
      errorMessage: 'transient',
    });

    assert.equal(replayPlatformDlqEvent(db, id), true);
    assert.equal(getPlatformDlqBacklog(db).pending, 0);
    assert.equal(getPlatformDlqBacklog(db).replayed, 1);

    const replayedOutbox = db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM observability_outbox
       WHERE tenant_id = ? AND event_type = ?`,
    ).get('tenant_dlq', 'runtime.completed');
    assert.equal(replayedOutbox?.count ?? 0, 1);
  });
});
