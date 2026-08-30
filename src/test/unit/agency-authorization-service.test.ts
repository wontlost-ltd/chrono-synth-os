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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'any_tool', 'user1'), true);
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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'web_search', 'user1'), true);
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'payment.transfer', 'user1'), false);
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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'web_search', 'user1'), true);
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'email.send', 'user1'), false);
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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'any', 'user1'), false);
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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'any', 'user1'), false);

      assert.equal(service.resume('default', id), true);
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'any', 'user1'), true);
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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'any', 'user1'), false);
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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'wire_money', 'user_alice'), false, '前提：明确拒绝时不放行');

      /* 损坏拒绝清单（模拟写入 bug / 迁移截断 / 字符集问题）。 */
      db.prepare(`UPDATE agency_authorizations SET denied_tools_json = ? WHERE id = ?`)
        .run('{不是合法JSON', auth.id);

      /* 变异实测：把 toolListCorrupted 判据去掉 → 这里变 true（拒绝清单成死代码）。 */
      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'wire_money', 'user_alice'), false,
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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'read_email', 'user_alice'), true, '前提：白名单内放行');
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'wire_money', 'user_alice'), false, '前提：白名单外不放行');

      db.prepare(`UPDATE agency_authorizations SET allowed_tools_json = ? WHERE id = ?`)
        .run('null', auth.id);   /* 合法 JSON 但非数组 —— 同样视为损坏 */

      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'wire_money', 'user_alice'), false,
        '白名单损坏不得退化成「空白名单=按 scope 放行」',
      );
      /* 连原本允许的也不放行 —— 整条授权书不可信。 */
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'read_email', 'user_alice'), false, '损坏授权书整条作废');
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
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'a', 'user_alice'), true);
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'b', 'user_alice'), true);
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'c', 'user_alice'), false);
      assert.equal(service.isToolAllowedForPrincipal('default', 'p1', 'zzz', 'user_alice'), false, '白名单外不放行');
    } finally { db.close(); }
  });

  /* ── 审计 #440-2：principal_user_id 同时是审计字段与授权键 ──
   *
   * 缺陷：判定只看「该 persona 上有没有任意一份 active 授权书覆盖该工具」，
   * `principal_user_id` 从不参与。而 `idx_agency_authorizations_persona` 是
   * **非唯一**索引，同一 persona 上可并存多份授权书 —— 于是任何一位委托人的
   * 宽泛授权都会替**所有人**放行。
   *
   * 后果：「Alice 只授权了只读」这条约束在系统里根本无法表达。 */
  it('审计 #440-2：别人签发的宽泛授权不得替本调用者放行', () => {
    const { db, service } = makeService();
    try {
      /* Alice 只授权只读。 */
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user_alice',
        scope: 'communication', scopeDescription: 'Alice grants read-only email access for support triage.',
        allowedTools: ['read_email'],
      });
      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'read_email', 'user_alice'), true,
        '前置：Alice 自己的授权内放行',
      );
      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'wire_money', 'user_alice'), false,
        '前置：Alice 未授权的工具不放行',
      );

      /* Bob 在**同一 persona** 上另签一份全权委托。 */
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user_bob',
        scope: 'all', scopeDescription: 'Bob grants full delegation for his own workflows.',
      });

      /* ★核心断言★：Bob 的授权不得替 Alice 放行。
       * 变异实测：去掉 coversPrincipal 判据 → 本行变 true 转红
       * （这正是缺陷版的实际行为：alice 借 bob 的授权用上了 wire_money）。 */
      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'wire_money', 'user_alice'), false,
        'Bob 的宽泛授权不得替 Alice 放行 wire_money',
      );

      /* 对照：Bob 用自己的授权当然可以 —— 修复不是「把功能一起关掉」。 */
      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'wire_money', 'user_bob'), true,
        'Bob 用自己签发的授权仍应放行',
      );
      /* 对照：Alice 自己的只读授权仍然有效，没被连带否掉。 */
      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'read_email', 'user_alice'), true,
        'Alice 自己的授权不受影响',
      );
    } finally { db.close(); }
  });

  /* ⚠️ 自主路径（persona-earning-service / draft-github-reply 明确传
   * `invokerUserId: null`）没有人类主体，拿谁去比 principal 都不对。
   * 它的约束来自 allowedTools/deniedTools 与叠加的 ToolPermission 层。
   *
   * ⚠️ 我先试过用 `scope === 'all'` 当自主许可，**是错的**：真实夹具
   * （autonomous-earning-e2e）用 `scope: 'research'` + 精确工具清单授权自主
   * 接活 —— 窄 scope 恰恰是更好的安全实践，按 scope='all' 判会把它拒掉
   * （实测 2 条 E2E 转红），反而逼用户去要全权委托。故不按 scope 设门。 */
  it('审计 #440-2：自主行动在窄 scope + 工具清单下应放行（真实夹具形状）', () => {
    const { db, service } = makeService();
    try {
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user_owner',
        scope: 'research', scopeDescription: 'Owner grants autonomous research gig acceptance.',
        allowedTools: ['marketplace.act'],
      });
      /* 变异实测：自主分支改成 `return false` → 本行转红（自主赚钱闭环全挂）；
       * 改成 `auth.scope === 'all'` → 同样转红（我最初写错的那版）。 */
      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'marketplace.act', null), true,
        '窄 scope + 工具清单内的自主行动应放行',
      );
    } finally { db.close(); }
  });

  it('审计 #440-2：自主行动仍受工具清单约束（不是无限授权）', () => {
    const { db, service } = makeService();
    try {
      service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user_owner',
        scope: 'research', scopeDescription: 'Owner grants autonomous research gig acceptance.',
        allowedTools: ['marketplace.act'],
      });
      /* 自主不等于放任：工具边界由 allowed/denied 把关，这一层没被绕过。
       * 变异实测：把 allowedTools 判据去掉 → 本行转红。 */
      assert.equal(
        service.isToolAllowedForPrincipal('default', 'p1', 'wire_money', null), false,
        '清单外的工具即便自主也不放行',
      );
    } finally { db.close(); }
  });

  it('审计 #440-2：principal_user_id 仍是审计字段（两个角色并存）', () => {
    const { db, service } = makeService();
    try {
      const created = service.create({
        tenantId: 'default', personaId: 'p1', principalUserId: 'user_alice',
        scope: 'communication', scopeDescription: 'Alice grants read-only email access for support triage.',
      });
      /* 授权键的作用不影响记录：签发者照常可查、可按委托人列举（法律取证用）。 */
      assert.equal(service.getById('default', created.id)?.principalUserId, 'user_alice',
        'principal 必须仍可从授权书读出（审计取证）');
      assert.equal(service.listByPrincipal('default', 'user_alice').length, 1,
        '仍可按委托人列举其签发的全部授权书');
    } finally { db.close(); }
  });
});
