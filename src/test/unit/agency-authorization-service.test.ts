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

  /* ⚠️ 审计 #424：工具清单 JSON 解析失败此前是 `catch { }` 静默退化成空数组，
   * 而空数组在 isToolAllowed 里恰是**放宽**语义：
   *   - deniedTools 损坏 → [] → 拒绝清单变成死代码；
   *   - allowedTools 损坏 → [] → 命中「空白名单=按 scope 放行」→ 全部工具放行。
   * 实测：写坏 denied_tools_json 后，被明确拒绝的 wire_money 变成 allowed，
   * 且 GET 详情看到的仍是 []，从外部看不出损坏。 */
  it('审计 #424：denied_tools_json 损坏 → fail-closed（不得放行被拒工具）', () => {
    const { db, service } = makeService();
    try {
      const auth = service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user_alice',
        scope: 'all', scopeDescription: '允许只读工具，明确拒绝转账',
        deniedTools: ['wire_money'],
      });
      assert.equal(service.isToolAllowed('default', 'p1', 'wire_money'), false, '前提：明确拒绝时不放行');

      /* 损坏拒绝清单（模拟写入 bug / 迁移截断 / 字符集问题）。 */
      db.prepare(`UPDATE agency_authorizations SET denied_tools_json = ? WHERE id = ?`)
        .run('{不是合法JSON', auth.id);

      /* 变异实测：把 toolListCorrupted 判据去掉 → 这里变 true（拒绝清单成死代码）。 */
      assert.equal(
        service.isToolAllowed('default', 'p1', 'wire_money'), false,
        '清单损坏必须 fail-closed，不得因退化成空数组而放行',
      );
    } finally { db.close(); }
  });

  it('审计 #424：allowed_tools_json 损坏 → fail-closed（不得退化成「全部放行」）', () => {
    const { db, service } = makeService();
    try {
      const auth = service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user_alice',
        scope: 'all', scopeDescription: '仅允许三个只读工具',
        allowedTools: ['read_email', 'read_calendar', 'read_doc'],
      });
      assert.equal(service.isToolAllowed('default', 'p1', 'read_email'), true, '前提：白名单内放行');
      assert.equal(service.isToolAllowed('default', 'p1', 'wire_money'), false, '前提：白名单外不放行');

      db.prepare(`UPDATE agency_authorizations SET allowed_tools_json = ? WHERE id = ?`)
        .run('null', auth.id);   /* 合法 JSON 但非数组 —— 同样视为损坏 */

      assert.equal(
        service.isToolAllowed('default', 'p1', 'wire_money'), false,
        '白名单损坏不得退化成「空白名单=按 scope 放行」',
      );
      /* 连原本允许的也不放行 —— 整条授权书不可信。 */
      assert.equal(service.isToolAllowed('default', 'p1', 'read_email'), false, '损坏授权书整条作废');
    } finally { db.close(); }
  });

  it('对照：清单正常时白名单/黑名单语义不变（别把功能一起关掉）', () => {
    const { db, service } = makeService();
    try {
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user_alice',
        scope: 'all', scopeDescription: '白名单两个工具，黑名单一个',
        allowedTools: ['a', 'b'], deniedTools: ['c'],
      });
      assert.equal(service.isToolAllowed('default', 'p1', 'a'), true);
      assert.equal(service.isToolAllowed('default', 'p1', 'b'), true);
      assert.equal(service.isToolAllowed('default', 'p1', 'c'), false);
      assert.equal(service.isToolAllowed('default', 'p1', 'zzz'), false, '白名单外不放行');
    } finally { db.close(); }
  });
});
