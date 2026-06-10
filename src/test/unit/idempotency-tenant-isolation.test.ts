/**
 * 幂等键租户隔离回归（②b）：complete/delete 从 id-only 改为 id AND tenant_id 后，
 * 一个租户的 complete/delete **绝不**能命中另一租户的同 id 行（跨租户写隔离）。
 *
 * 原 id-only 写虽然 id 是服务端生成的 UUID（泄漏面理论性），但按 ratchet 标准这是真实
 * 跨租户写面：本测试钉死「带 tenant_id 后跨租户写命中 0 行」。
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { idemCmdInsert, idemCmdComplete, idemCmdDelete } from '@chrono/kernel';
import { resolveCommandExecutor } from '../../storage/legacy-sync-bridge.js';
import { registerIdempotencyExecutors } from '../../storage/executors/idempotency-executors.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

const TA = 'tenant_a';
const TB = 'tenant_b';

describe('幂等键租户隔离（②b）：complete/delete 跨租户写不命中', () => {
  let db: IDatabase;

  function run<P>(cmd: { kind: string; params: P }): number {
    const exec = resolveCommandExecutor(cmd.kind);
    assert.ok(exec, `executor not registered: ${cmd.kind}`);
    return exec(db, cmd.params).rowsAffected;
  }

  /* executor 是全局注册（重复注册会抛错），只注册一次；若别的测试文件已注册则忽略。 */
  before(() => { try { registerIdempotencyExecutors(); } catch { /* already registered */ } });

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    /* 两租户各插一条 in_progress 幂等键（不同 id）。 */
    run(idemCmdInsert({ id: 'idem_a', tenantId: TA, scopeKey: 's', idempotencyKey: 'k',
      requestHash: 'h', requestMethod: 'POST', requestPath: '/x', now: 1000, expiresAt: 9_000_000 }));
    run(idemCmdInsert({ id: 'idem_b', tenantId: TB, scopeKey: 's', idempotencyKey: 'k',
      requestHash: 'h', requestMethod: 'POST', requestPath: '/x', now: 1000, expiresAt: 9_000_000 }));
  });

  it('complete 用错租户 id → 命中 0 行（不污染别租户的键）', () => {
    /* 拿 A 的 id，但传 B 的 tenantId → 不应命中。 */
    const affected = run(idemCmdComplete({
      id: 'idem_a', tenantId: TB, responseStatus: 200,
      responseContentType: 'application/json', responseHeadersJson: '{}', responseBody: '{}',
    }));
    assert.equal(affected, 0, '跨租户 complete 不应命中任何行');
    /* A 的键仍是 in_progress（没被 B 改）。 */
    const stateA = db.prepare<{ state: string }>('SELECT state FROM idempotency_keys WHERE id = ?').get('idem_a')?.state;
    assert.equal(stateA, 'in_progress', 'A 的键不应被 B 的 complete 篡改');
  });

  it('complete 用对租户 id → 正常命中', () => {
    const affected = run(idemCmdComplete({
      id: 'idem_a', tenantId: TA, responseStatus: 200,
      responseContentType: 'application/json', responseHeadersJson: '{}', responseBody: '{}',
    }));
    assert.equal(affected, 1, '同租户 complete 应命中');
    const stateA = db.prepare<{ state: string }>('SELECT state FROM idempotency_keys WHERE id = ?').get('idem_a')?.state;
    assert.equal(stateA, 'completed');
  });

  it('delete 用错租户 id → 命中 0 行（别租户的键仍在）', () => {
    const affected = run(idemCmdDelete({ id: 'idem_a', tenantId: TB }));
    assert.equal(affected, 0, '跨租户 delete 不应命中任何行');
    const cntA = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM idempotency_keys WHERE id = ?').get('idem_a')?.c;
    assert.equal(cntA, 1, 'A 的键不应被 B 的 delete 删除');
  });

  it('delete 用对租户 id → 正常删除', () => {
    const affected = run(idemCmdDelete({ id: 'idem_a', tenantId: TA }));
    assert.equal(affected, 1, '同租户 delete 应命中');
    const cntA = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM idempotency_keys WHERE id = ?').get('idem_a')?.c;
    assert.equal(cntA, 0);
  });
});
