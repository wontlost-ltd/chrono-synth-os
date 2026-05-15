import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  USAGE_QUERY_GET, USAGE_QUERY_SUMMARY, USAGE_CMD_RECORD,
  BOUTBOX_QUERY_PENDING, BOUTBOX_QUERY_PENDING_COUNT, BOUTBOX_QUERY_FAILED_COUNT,
  BOUTBOX_CMD_ENQUEUE, BOUTBOX_CMD_REQUEUE_STALE, BOUTBOX_CMD_CLAIM,
  BOUTBOX_CMD_MARK_SENT, BOUTBOX_CMD_MARK_FAILED,
} from '@chrono/kernel';
import { UsageTracker } from '../../billing/usage-tracker.js';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveCommandExecutor, resolveQueryExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';

describe('UsageTracker & BillingOutbox 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部用量 query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(USAGE_QUERY_GET));
    assert.ok(resolveQueryExecutor(USAGE_QUERY_SUMMARY));
    assert.ok(resolveCommandExecutor(USAGE_CMD_RECORD));
  });

  it('全部计费发件箱 query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(BOUTBOX_QUERY_PENDING));
    assert.ok(resolveQueryExecutor(BOUTBOX_QUERY_PENDING_COUNT));
    assert.ok(resolveQueryExecutor(BOUTBOX_QUERY_FAILED_COUNT));
    assert.ok(resolveCommandExecutor(BOUTBOX_CMD_ENQUEUE));
    assert.ok(resolveCommandExecutor(BOUTBOX_CMD_REQUEUE_STALE));
    assert.ok(resolveCommandExecutor(BOUTBOX_CMD_CLAIM));
    assert.ok(resolveCommandExecutor(BOUTBOX_CMD_MARK_SENT));
    assert.ok(resolveCommandExecutor(BOUTBOX_CMD_MARK_FAILED));
  });

  it('UsageTracker record 和 getUsage 通过 data plane 契约持久化', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const tracker = new UsageTracker(db);

    tracker.record('t1', 'llm_tokens', 100);
    tracker.record('t1', 'llm_tokens', 50);

    const total = tracker.getUsage('t1', 'llm_tokens');
    assert.equal(total, 150);
  });

  it('UsageTracker getSummary 返回按资源分组的用量', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const tracker = new UsageTracker(db);

    tracker.record('t1', 'llm_tokens', 100);
    tracker.record('t1', 'simulations', 3);

    const summary = tracker.getSummary('t1');
    assert.equal(summary['llm_tokens'], 100);
    assert.equal(summary['simulations'], 3);
  });
});
