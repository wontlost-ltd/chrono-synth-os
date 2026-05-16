/**
 * 单元测试：ToolInvocationsRetentionWorker（F4）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { ToolInvocationsRetentionWorker } from '../../agent/tool-invocations-retention-worker.js';
import { SilentLogger } from '../../utils/logger.js';

function setup() {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const permissions = new ToolPermissionService(db);
  const worker = new ToolInvocationsRetentionWorker(permissions, new SilentLogger(), {
    intervalMs: 60_000,
    retentionMs: 90 * 24 * 60 * 60 * 1000,
    batchSize: 100,
    maxBatchesPerCycle: 5,
  });
  return { db, permissions, worker };
}

describe('ToolInvocationsRetentionWorker', () => {
  it('flushOnce 删除超期 invocations 并跳过 pending_confirmation', async () => {
    const { db, permissions, worker } = setup();
    try {
      const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
      const recentTime = Date.now() - 10 * 24 * 60 * 60 * 1000;

      const oldSuccessId = permissions.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        invokerType: 'mcp', invokerId: 'c', invokerUserId: 'u',
        status: 'success',
        inputHash: 'h1', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: null,
        invokedAt: oldTime,
      });
      const oldPendingId = permissions.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'email',
        invokerType: 'mcp', invokerId: 'c', invokerUserId: 'u',
        status: 'pending_confirmation',
        inputHash: 'h2', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: 'cct_keep',
        invokedAt: oldTime,
      });
      const recentId = permissions.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        invokerType: 'mcp', invokerId: 'c', invokerUserId: 'u',
        status: 'success',
        inputHash: 'h3', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: null,
        invokedAt: recentTime,
      });

      const result = await worker.flushOnce();
      assert.equal(result.deleted, 1);
      assert.equal(permissions.getInvocation('default', oldSuccessId), null);
      assert.ok(permissions.getInvocation('default', oldPendingId));
      assert.ok(permissions.getInvocation('default', recentId));
    } finally { db.close(); }
  });

  it('isHealthy 在 start 后为 true，stop 后为 false', async () => {
    const { db, worker } = setup();
    try {
      assert.equal(worker.isHealthy(), false);
      worker.start();
      assert.equal(worker.isHealthy(), true);
      await worker.stop();
      assert.equal(worker.isHealthy(), false);
    } finally { db.close(); }
  });
});
