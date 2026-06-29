/**
 * 单元测试：ToolPermissionService（P3-A）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';

function makeService() {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const service = new ToolPermissionService(db);
  return { db, service };
}

describe('ToolPermissionService', () => {
  it('grant 创建权限并返回 revocation_key', () => {
    const { db, service } = makeService();
    try {
      const result = service.grant({
        tenantId: 'default',
        personaId: 'p1',
        toolId: 'web_search',
        scope: 'execute',
        constraints: { maxActionsPerDay: 100 },
        grantedBy: 'admin_user',
      });
      assert.ok(result.id.startsWith('tperm_'));
      assert.ok(result.revocationKey.startsWith('rk_'));
    } finally { db.close(); }
  });

  it('check 在权限存在且未撤销时返回 allowed', () => {
    const { db, service } = makeService();
    try {
      service.grant({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        scope: 'execute', constraints: {}, grantedBy: 'admin',
      });

      const check = service.check({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search', now: Date.now(),
      });
      assert.equal(check.allowed, true);
    } finally { db.close(); }
  });

  it('check 在未授予时返回 not_granted', () => {
    const { db, service } = makeService();
    try {
      const check = service.check({
        tenantId: 'default', personaId: 'p1', toolId: 'unknown', now: Date.now(),
      });
      assert.equal(check.allowed, false);
      if (!check.allowed) assert.equal(check.reason, 'not_granted');
    } finally { db.close(); }
  });

  it('revoke 后 check 返回 revoked', () => {
    const { db, service } = makeService();
    try {
      const { id } = service.grant({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        scope: 'execute', constraints: {}, grantedBy: 'admin',
      });

      const ok = service.revoke(id, 'no longer needed');
      assert.equal(ok, true);

      const check = service.check({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search', now: Date.now(),
      });
      assert.equal(check.allowed, false);
      if (!check.allowed) assert.equal(check.reason, 'revoked');
    } finally { db.close(); }
  });

  it('revokeByKey 通过紧急 key 撤销', () => {
    const { db, service } = makeService();
    try {
      const { revocationKey } = service.grant({
        tenantId: 'default', personaId: 'p1', toolId: 'email',
        scope: 'execute', constraints: {}, grantedBy: 'admin',
      });

      const ok = service.revokeByKey('default', revocationKey, 'urgent: leaked credentials');
      assert.equal(ok, true);

      const check = service.check({
        tenantId: 'default', personaId: 'p1', toolId: 'email', now: Date.now(),
      });
      assert.equal(check.allowed, false);
    } finally { db.close(); }
  });

  it('revokeByKey/findByRevocationKey 跨租户隔离：他租户 key 无法查/撤销（P1-7）', () => {
    const { db, service } = makeService();
    try {
      const { revocationKey } = service.grant({
        tenantId: 'tenant-a', personaId: 'p1', toolId: 'email',
        scope: 'execute', constraints: {}, grantedBy: 'admin',
      });

      /* 攻击者在 tenant-b 上下文用 tenant-a 的 key：查不到、撤不掉 */
      assert.equal(service.findByRevocationKey('tenant-b', revocationKey), null, '他租户 key 不应查到');
      assert.equal(service.revokeByKey('tenant-b', revocationKey, 'cross-tenant attempt'), false, '他租户 key 不应撤销成功');

      /* 本租户 key 仍可查到、可撤销 */
      assert.ok(service.findByRevocationKey('tenant-a', revocationKey), '本租户 key 应查到');
      assert.equal(service.revokeByKey('tenant-a', revocationKey, 'legit'), true, '本租户 key 应撤销成功');
    } finally { db.close(); }
  });

  it('expiresAt 过期后 check 返回 expired', () => {
    const { db, service } = makeService();
    try {
      const past = Date.now() - 60_000;
      service.grant({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        scope: 'execute', constraints: {}, grantedBy: 'admin',
        expiresAt: past,
      });

      const check = service.check({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search', now: Date.now(),
      });
      assert.equal(check.allowed, false);
      if (!check.allowed) assert.equal(check.reason, 'expired');
    } finally { db.close(); }
  });

  it('grant 同一 (persona, tool) 走 upsert：覆盖原 constraints', () => {
    const { db, service } = makeService();
    try {
      service.grant({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        scope: 'read', constraints: { maxActionsPerDay: 10 },
        grantedBy: 'admin',
      });

      service.grant({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        scope: 'execute', constraints: { maxActionsPerDay: 100 },
        grantedBy: 'admin',
      });

      const list = service.listByPersona('default', 'p1');
      assert.equal(list.length, 1);
      assert.equal(list[0].scope, 'execute');
      assert.equal(list[0].constraints.maxActionsPerDay, 100);
    } finally { db.close(); }
  });

  it('recordInvocation 写入 tool_invocations，可查询', () => {
    const { db, service } = makeService();
    try {
      const id = service.recordInvocation({
        tenantId: 'default',
        personaId: 'p1',
        toolId: 'web_search',
        invokerType: 'mcp',
        invokerId: 'client_123',
        status: 'success',
        inputHash: 'abc',
        outputSizeBytes: 1024,
        errorMessage: null,
        costCents: 1,
        durationMs: 250,
        confirmationTokenId: null,
      });
      assert.ok(id.startsWith('tinv_'));

      const inv = service.getInvocation('default', id);
      assert.ok(inv);
      assert.equal(inv?.status, 'success');
    } finally { db.close(); }
  });

  it('ADR-0055 D1：org_worker invokerType 可记审计 + 保人类 principal（invokerUserId）', () => {
    const { db, service } = makeService();
    try {
      const id = service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        invokerType: 'org_worker', invokerId: 'worker:w1', invokerUserId: 'human-principal-alice',
        status: 'success', inputHash: 'h', outputSizeBytes: 0, errorMessage: null, costCents: 0, durationMs: 1, confirmationTokenId: null,
      });
      const inv = service.getInvocation('default', id);
      assert.equal(inv?.invokerType, 'org_worker', '数字员工 actor 类型落审计');
      assert.equal(inv?.invokerId, 'worker:w1', '归因到具体 worker');
      assert.equal(inv?.invokerUserId, 'human-principal-alice', '人类法律 principal 保留在审计链');
    } finally { db.close(); }
  });

  it('dailyUsageCount 仅统计当天 success 调用', () => {
    const { db, service } = makeService();
    try {
      const now = Date.now();
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        invokerType: 'mcp', invokerId: 'c1', status: 'success',
        inputHash: '1', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 1, confirmationTokenId: null,
        invokedAt: now,
      });
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        invokerType: 'mcp', invokerId: 'c1', status: 'failed',
        inputHash: '2', outputSizeBytes: 0, errorMessage: 'err',
        costCents: 0, durationMs: 1, confirmationTokenId: null,
        invokedAt: now,
      });
      const count = service.dailyUsageCount('default', 'p1', 'web_search', now);
      assert.equal(count, 1);
    } finally { db.close(); }
  });

  it('dailyCostCents 累加当天 success 成本，忽略 failed（ADR-0048 budget gate）', () => {
    const { db, service } = makeService();
    try {
      const now = Date.now();
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        invokerType: 'mcp', invokerId: 'c1', status: 'success',
        inputHash: '1', outputSizeBytes: 0, errorMessage: null,
        costCents: 30, durationMs: 1, confirmationTokenId: null, invokedAt: now,
      });
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        invokerType: 'mcp', invokerId: 'c1', status: 'success',
        inputHash: '2', outputSizeBytes: 0, errorMessage: null,
        costCents: 12, durationMs: 1, confirmationTokenId: null, invokedAt: now,
      });
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'web_search',
        invokerType: 'mcp', invokerId: 'c1', status: 'failed',
        inputHash: '3', outputSizeBytes: 0, errorMessage: 'err',
        costCents: 99, durationMs: 1, confirmationTokenId: null, invokedAt: now,
      });
      assert.equal(service.dailyCostCents('default', 'p1', 'web_search', now), 42);
      /* 无任何记录的工具返回 0（不抛、不 NULL） */
      assert.equal(service.dailyCostCents('default', 'p1', 'email', now), 0);
    } finally { db.close(); }
  });

  it('listPendingByUser 仅返回当前用户的 pending_confirmation', () => {
    const { db, service } = makeService();
    try {
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'email',
        invokerType: 'mcp', invokerId: 'c1', invokerUserId: 'user_a',
        status: 'pending_confirmation',
        inputHash: 'h1', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: 'cct_1',
      });
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'email',
        invokerType: 'mcp', invokerId: 'c1', invokerUserId: 'user_b',
        status: 'pending_confirmation',
        inputHash: 'h2', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: 'cct_2',
      });
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'email',
        invokerType: 'mcp', invokerId: 'c1', invokerUserId: 'user_a',
        status: 'success',
        inputHash: 'h3', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: null,
      });
      const list = service.listPendingByUser('default', 'user_a', 50);
      assert.equal(list.length, 1);
      assert.equal(list[0].confirmationTokenId, 'cct_1');
      assert.equal(list[0].invokerUserId, 'user_a');
    } finally { db.close(); }
  });

  it('getByConfirmationToken 通过 token id 反查', () => {
    const { db, service } = makeService();
    try {
      const id = service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'email',
        invokerType: 'mcp', invokerId: 'c1', invokerUserId: 'user_a',
        status: 'pending_confirmation',
        inputHash: 'h1', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: 'cct_xyz',
      });
      const found = service.getByConfirmationToken('default', 'cct_xyz');
      assert.ok(found);
      assert.equal(found?.id, id);
    } finally { db.close(); }
  });

  it('pruneInvocationsBefore 跳过 pending_confirmation 行', () => {
    const { db, service } = makeService();
    try {
      const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000;
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'email',
        invokerType: 'mcp', invokerId: 'c1', invokerUserId: 'user_a',
        status: 'success',
        inputHash: 'h1', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: null,
        invokedAt: oldTime,
      });
      service.recordInvocation({
        tenantId: 'default', personaId: 'p1', toolId: 'email',
        invokerType: 'mcp', invokerId: 'c1', invokerUserId: 'user_a',
        status: 'pending_confirmation',
        inputHash: 'h2', outputSizeBytes: 0, errorMessage: null,
        costCents: 0, durationMs: 0, confirmationTokenId: 'cct_keep',
        invokedAt: oldTime,
      });
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const removed = service.pruneInvocationsBefore(cutoff, 100);
      assert.equal(removed, 1);
      const stillPending = service.getByConfirmationToken('default', 'cct_keep');
      assert.ok(stillPending);
    } finally { db.close(); }
  });
});
