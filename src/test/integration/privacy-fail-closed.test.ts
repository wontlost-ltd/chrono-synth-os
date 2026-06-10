/**
 * GDPR fail-closed（②）：擦除/导出失败**绝不**静默吞成「删了 0 行 / 空导出」并误报成功。
 *
 * 旧实现 `catch { return 0 }` 把 DELETE 抛错当成「删了 0 行」，eraseData 的事务照常提交，
 * 返回 deleted:true——用户被告知数据已删，实则未删（GDPR Art.17 fail-open 真 bug）。
 * 本测试构造一次「擦除中途某表 DELETE 失败」的场景，断言：
 *   1. eraseData **抛错**（不再返回 deleted:true）；
 *   2. 事务**回滚**——同批本应被删的其它表数据仍在（要么全删，要么全不删，不留半删态）。
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { ResponseTemplateStore } from '../../storage/response-template-store.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { IDatabase } from '../../storage/index.js';

const TENANT = 'default';
const PERSONA = 'persona_x';

describe('GDPR fail-closed：擦除/导出失败不静默吞错（②）', () => {
  let os: ChronoSynthOS | undefined;
  afterEach(() => { os?.close(); os = undefined; });

  function setup(): { db: IDatabase; privacy: PrivacyService } {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    os = new ChronoSynthOS({ db, skipMigrations: true, clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    return { db, privacy: new PrivacyService(os, undefined) };
  }

  it('擦除中途某表 DELETE 失败 → 抛错（不误报 deleted:true）且事务回滚', () => {
    const { db, privacy } = setup();
    /* 种一条 response_templates（擦除会删）；用它证明擦除失败后回滚、数据仍在。 */
    new ResponseTemplateStore(db, TENANT).appendVersion(PERSONA, 'greeting', '你好', null, 1000);

    /* 制造擦除失败：DROP 掉擦除清单里某张表 → 该表 DELETE 抛 "no such table"。
     * 用 distilled_artifacts（擦除必经，但**不**在 getState/关闭快照路径里，避免污染 os.close()）。 */
    db.exec('DROP TABLE distilled_artifacts');

    /* fail-closed：eraseData 抛错，绝不返回 deleted:true。 */
    assert.throws(() => privacy.eraseData(TENANT), /distilled_artifacts|no such table/i,
      '擦除遇 DELETE 失败必须抛错，而非静默吞成功');

    /* 事务回滚：response_templates 数据仍在（原子性：要么全删要么全不删，不留半删态）。 */
    assert.equal(
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM response_templates WHERE tenant_id = ?').get(TENANT)?.c, 1,
      '擦除失败回滚后，response_templates 数据应仍在（原子性）',
    );
  });

  it('导出中途某表 SELECT 失败 → 抛错（不返回「成功的空导出」）', () => {
    const { db, privacy } = setup();
    new ResponseTemplateStore(db, TENANT).appendVersion(PERSONA, 'greeting', '你好', null, 1000);

    /* 制造导出失败：DROP 掉导出清单里某张表 → 该表 SELECT 抛错。
     * 用 distilled_artifacts（导出必经，且不在关闭快照路径，避免污染 os.close()）。 */
    db.exec('DROP TABLE distilled_artifacts');

    /* fail-closed：导出失败抛错，而非静默给出缺表的「成功」导出。 */
    assert.throws(() => privacy.exportData(TENANT), /distilled_artifacts|no such table/i,
      '导出遇 SELECT 失败必须抛错，而非静默返回缺表的导出');
  });

  it('对照：正常擦除仍成功（fail-closed 不是「全失败」死门）', () => {
    const { db, privacy } = setup();
    const store = new ResponseTemplateStore(db, TENANT);
    store.appendVersion(PERSONA, 'greeting', '你好', null, 1000);

    const res = privacy.eraseData(TENANT);
    assert.equal(res.blocked, false);
    assert.equal(res.deleted, true, '无故障时擦除应正常成功');
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM response_templates WHERE tenant_id = ?').get(TENANT)?.c, 0);
  });

  /* fail-closed 暴露的真实潜伏 bug 回归：org→workspace→membership→role-binding 有 FK 链，
   * 删除途中会瞬时违反 FK。旧 catch{return 0} 静默吞掉「FOREIGN KEY constraint failed」→ 这些数据
   * 实际没删干净却误报成功。defer_foreign_keys=ON 让 FK 推迟到 COMMIT 统一校验 → 全删成功。 */
  it('FK 链表（org/workspace/membership/role-binding）擦除：defer FK 后全删，不留残留', () => {
    const { db, privacy } = setup();
    const now = 1000;
    db.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).run('u_fk', 'fk@example.com', 'h', 'admin', TENANT, now, now);
    db.prepare<void>(
      `INSERT INTO organizations (id, tenant_id, name, slug, created_by_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).run('org_fk', TENANT, 'Org', 'org-fk', 'u_fk', now, now);
    db.prepare<void>(
      `INSERT INTO workspaces (id, tenant_id, organization_id, name, slug, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('ws_fk', TENANT, 'org_fk', 'WS', 'ws-fk', 1, now, now);
    db.prepare<void>(
      `INSERT INTO organization_memberships (id, tenant_id, organization_id, user_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).run('m_fk', TENANT, 'org_fk', 'u_fk', 'active', now, now);
    db.prepare<void>(
      `INSERT INTO organization_role_bindings (id, tenant_id, organization_id, workspace_id, membership_id, role, created_at) VALUES (?,?,?,?,?,?,?)`,
    ).run('rb_fk', TENANT, 'org_fk', null, 'm_fk', 'org_admin', now);

    const res = privacy.eraseData(TENANT);
    assert.equal(res.deleted, true, 'FK 链表擦除应成功（defer FK 生效）');
    for (const t of ['organizations', 'workspaces', 'organization_memberships', 'organization_role_bindings']) {
      assert.equal(
        db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t} WHERE tenant_id = ?`).get(TENANT)?.c, 0,
        `${t} 应被擦除干净（无 FK 残留）`,
      );
    }
  });

  /* 锁死语义（Codex ② 复审建议）：defer_foreign_keys 是「推迟检查到 COMMIT」而非「取消检查」。
   * 用一对受控 FK 表证明：只删父、漏删子 → 留下孤儿 → COMMIT 时 FK 仍失败并整体回滚。
   * 这保证「漏删某子表」不会被 defer 静默放过——defer 不会把 fail-closed 偷换成 fail-open。 */
  it('defer 是推迟不是取消：只删父、漏删子 → COMMIT FK 失败 → 整体回滚', () => {
    const { db } = setup();
    db.exec('CREATE TABLE t_parent (id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE t_child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES t_parent(id))');
    db.prepare<void>('INSERT INTO t_parent (id) VALUES (?)').run('p1');
    db.prepare<void>('INSERT INTO t_child (id, parent_id) VALUES (?, ?)').run('c1', 'p1');

    /* 模拟「漏删子表」：开 defer，只删父表 → 中间态有孤儿子行。 */
    assert.throws(() => {
      db.transaction(() => {
        db.exec('PRAGMA defer_foreign_keys=ON');
        db.prepare<void>('DELETE FROM t_parent WHERE id = ?').run('p1');
        /* 故意不删 t_child → COMMIT 时孤儿被 FK 拦截。 */
      });
    }, /FOREIGN KEY|constraint/i, 'defer 不取消检查：COMMIT 时孤儿仍触发 FK 失败');

    /* 回滚：父行仍在（要么全删要么全不删）。 */
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM t_parent').get()?.c, 1, 'COMMIT 失败后父行应回滚仍在');
  });
});
