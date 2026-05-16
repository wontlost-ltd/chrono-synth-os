/**
 * 单元测试：AgencyAuthorizationService（P3-A）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { AgencyAuthorizationService } from '../../agent/agency-authorization-service.js';

function makeService() {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return { db, service: new AgencyAuthorizationService(db) };
}

describe('AgencyAuthorizationService', () => {
  it('create 创建授权书（含详细 scopeDescription 用于审计）', () => {
    const { db, service } = makeService();
    try {
      const result = service.create({
        tenantId: 'default',
        personaId: 'p1',
        principalUserId: 'user_alice',
        scope: 'communication',
        scopeDescription: 'Allow this persona to send emails on behalf of Alice for customer support inquiries during business hours.',
      });
      assert.ok(result.id.startsWith('agauth_'));
      assert.ok(result.revocationKey.startsWith('rk_'));
    } finally { db.close(); }
  });

  it('isToolAllowed：active + 空白名单 = 放行', () => {
    const { db, service } = makeService();
    try {
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user1',
        scope: 'all', scopeDescription: 'Full delegation for testing purposes',
      });
      assert.equal(service.isToolAllowed('default', 'p1', 'any_tool'), true);
    } finally { db.close(); }
  });

  it('isToolAllowed：deniedTools 列表中的工具被拒', () => {
    const { db, service } = makeService();
    try {
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user1',
        scope: 'all', scopeDescription: 'Most tools allowed except dangerous ones',
        deniedTools: ['payment.transfer', 'admin.delete_persona'],
      });
      assert.equal(service.isToolAllowed('default', 'p1', 'web_search'), true);
      assert.equal(service.isToolAllowed('default', 'p1', 'payment.transfer'), false);
    } finally { db.close(); }
  });

  it('isToolAllowed：allowedTools 严格白名单', () => {
    const { db, service } = makeService();
    try {
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user1',
        scope: 'research', scopeDescription: 'Read-only research tools only',
        allowedTools: ['web_search', 'knowledge.query'],
      });
      assert.equal(service.isToolAllowed('default', 'p1', 'web_search'), true);
      assert.equal(service.isToolAllowed('default', 'p1', 'email.send'), false);
    } finally { db.close(); }
  });

  it('revoke 后 isToolAllowed 返回 false', () => {
    const { db, service } = makeService();
    try {
      const { id } = service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user1',
        scope: 'all', scopeDescription: 'Initial broad authorization',
      });
      service.revoke('default', id, 'principal changed mind');
      assert.equal(service.isToolAllowed('default', 'p1', 'any'), false);
    } finally { db.close(); }
  });

  it('suspend → resume：状态切换', () => {
    const { db, service } = makeService();
    try {
      const { id } = service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user1',
        scope: 'all', scopeDescription: 'For suspension test',
      });

      assert.equal(service.suspend('default', id), true);
      assert.equal(service.isToolAllowed('default', 'p1', 'any'), false);

      assert.equal(service.resume('default', id), true);
      assert.equal(service.isToolAllowed('default', 'p1', 'any'), true);
    } finally { db.close(); }
  });

  it('expiresAt 过期后 isToolAllowed 返回 false', () => {
    const { db, service } = makeService();
    try {
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user1',
        scope: 'all', scopeDescription: 'Time-limited test authorization',
        expiresAt: Date.now() - 1000,
      });
      assert.equal(service.isToolAllowed('default', 'p1', 'any'), false);
    } finally { db.close(); }
  });

  it('scopeDescription 必填；空值抛 ValidationError', () => {
    const { db, service } = makeService();
    try {
      assert.throws(() => service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user1',
        scope: 'all', scopeDescription: '   ',
      }), /授权范围描述必填/);
    } finally { db.close(); }
  });
});
