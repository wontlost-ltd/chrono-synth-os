import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTLE_QUERY_SETTLEMENTS_BY_TENANT,
  SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT,
  SETTLE_QUERY_TENANTS_WITH_SETTLEMENTS,
  SETTLE_QUERY_RUNS_BY_TENANT,
  SETTLE_CMD_DELETE_SETTLEMENT_TRANSACTIONS,
  SETTLE_CMD_INSERT_TRANSACTION,
  SETTLE_CMD_DELETE_ORPHAN_TRANSACTIONS,
  SETTLE_CMD_INSERT_RUN,
} from '@chrono/kernel';
import { SettlementReconciliationService } from '../../billing/settlement-reconciliation-service.js';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveCommandExecutor, resolveQueryExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';

describe('SettlementReconciliationService', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部结算 query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(SETTLE_QUERY_SETTLEMENTS_BY_TENANT));
    assert.ok(resolveQueryExecutor(SETTLE_QUERY_TRANSACTIONS_BY_SETTLEMENT));
    assert.ok(resolveQueryExecutor(SETTLE_QUERY_TENANTS_WITH_SETTLEMENTS));
    assert.ok(resolveQueryExecutor(SETTLE_QUERY_RUNS_BY_TENANT));
    assert.ok(resolveCommandExecutor(SETTLE_CMD_DELETE_SETTLEMENT_TRANSACTIONS));
    assert.ok(resolveCommandExecutor(SETTLE_CMD_INSERT_TRANSACTION));
    assert.ok(resolveCommandExecutor(SETTLE_CMD_DELETE_ORPHAN_TRANSACTIONS));
    assert.ok(resolveCommandExecutor(SETTLE_CMD_INSERT_RUN));
  });

  it('空租户对账并持久化运行记录', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const service = new SettlementReconciliationService(db);

    const run = service.reconcileTenant('tenant-a');

    assert.equal(run.checkedSettlements, 0);
    assert.equal(run.mismatchedSettlements, 0);
    assert.equal(run.repairedSettlements, 0);
    assert.equal(run.deletedTransactions, 0);
    assert.equal(run.insertedTransactions, 0);
    assert.equal(run.orphanTransactionsRemoved, 0);

    const runs = service.listRuns('tenant-a');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, run.runId);
    assert.deepEqual(runs[0].mismatchedSettlementIds, []);
  });
});
