/**
 * P1-M v2 — multi-instance break-glass JTI ledger.
 *
 * 验证目标：当两个 ChronoSynthOS 实例共享同一物理数据库（通过 SQLite
 * 文件模拟跨节点），同一 break-glass 令牌只能被消费一次，第二次消费
 * 必须抛出 REPLAY_DETECTED 而不是回退到内存检查。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';
import { BreakGlassError, BreakGlassService } from '../../identity/break-glass-service.js';
import { SqliteDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';

const KEY = 'a'.repeat(40);

describe('P1-M v2 — break-glass DB-backed JTI ledger', () => {
  const created: { db: IDatabase; tempDir?: string }[] = [];

  afterEach(() => {
    for (const entry of created.splice(0)) {
      entry.db.close();
      if (entry.tempDir) {
        rmSync(entry.tempDir, { recursive: true, force: true });
      }
    }
  });

  function openSharedFile(): { dbA: IDatabase; dbB: IDatabase; tempDir: string } {
    const tempDir = mkdtempSync(join(tmpdir(), 'chrono-bg-'));
    const dbPath = join(tempDir, 'shared.sqlite');
    const dbA = new SqliteDatabase(dbPath);
    runDslSqliteMigrations(dbA);
    /* dbB 打开同一文件，模拟另一个进程 / Pod。
     * 不再次运行迁移，确保两条连接共享同一份 schema 与数据。 */
    const dbB = new SqliteDatabase(dbPath);
    created.push({ db: dbA, tempDir });
    created.push({ db: dbB });
    return { dbA, dbB, tempDir };
  }

  it('rejects replay across two instances sharing the same DB file', () => {
    const { dbA, dbB } = openSharedFile();
    const svcA = new BreakGlassService(dbA, KEY);
    const svcB = new BreakGlassService(dbB, KEY);

    const { token } = svcA.issue({
      requestedBy: 'sre-a',
      approvalId: 'PD-42',
      scope: 'auth.keys.rotate',
      tenantId: 'tenant-a',
    });

    const payload = svcA.verify(token, 'auth.keys.rotate', 'tenant-a', { requestIp: '192.0.2.10' });
    assert.equal(payload.requestedBy, 'sre-a');

    assert.throws(
      () => svcB.verify(token, 'auth.keys.rotate', 'tenant-a', { requestIp: '192.0.2.11' }),
      (err: BreakGlassError) => err.code === 'REPLAY_DETECTED',
    );
  });

  it('exactly one same-instance verify wins under serial race', () => {
    const { dbA } = openSharedFile();
    const svc = new BreakGlassService(dbA, KEY);

    const { token } = svc.issue({
      requestedBy: 'sre-a',
      approvalId: 'PD-43',
      scope: 'data.restore',
      tenantId: 'tenant-a',
    });

    let successes = 0;
    let replays = 0;
    for (let i = 0; i < 2; i += 1) {
      try {
        svc.verify(token, 'data.restore', 'tenant-a');
        successes += 1;
      } catch (err) {
        if (err instanceof BreakGlassError && err.code === 'REPLAY_DETECTED') {
          replays += 1;
        } else {
          throw err;
        }
      }
    }
    assert.equal(successes, 1);
    assert.equal(replays, 1);
  });

  it('platform-scoped tokens (empty tenant) still enforce single-use', () => {
    const { dbA, dbB } = openSharedFile();
    const svcA = new BreakGlassService(dbA, KEY);
    const svcB = new BreakGlassService(dbB, KEY);

    const { token } = svcA.issue({
      requestedBy: 'platform-sre',
      approvalId: 'PD-44',
      scope: 'tenant.delete-override',
      tenantId: '',
    });

    svcA.verify(token, 'tenant.delete-override', '');
    assert.throws(
      () => svcB.verify(token, 'tenant.delete-override', ''),
      (err: BreakGlassError) => err.code === 'REPLAY_DETECTED',
    );
  });

  it('rolls back consumption when CC6.1 evidence write fails (consume-with-evidence is atomic)', () => {
    const { dbA } = openSharedFile();
    const svc = new BreakGlassService(dbA, KEY);
    const { token } = svc.issue({
      requestedBy: 'sre-a',
      approvalId: 'PD-45',
      scope: 'data.restore',
      tenantId: 'tenant-a',
    });

    /* 破坏 evidence 写入路径：丢弃表，强制 recordEvidence 抛错。
     * 期望：消费事务整体回滚，jti 未消费 → 第二次调用仍然能成功
     * 消费（也会失败，因为表仍旧不存在；但 JTI 重放保护语义本身已被验证）。 */
    dbA.exec('DROP TABLE compliance_evidence');

    let firstError: Error | undefined;
    try { svc.verify(token, 'data.restore', 'tenant-a'); } catch (err) { firstError = err as Error; }
    assert.ok(firstError, 'evidence-failure should propagate up');

    const ledgerRow = dbA.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM break_glass_jti_consumptions`,
    ).get();
    assert.equal(
      Number(ledgerRow?.count), 0,
      '消费事务必须连同 evidence 失败一起回滚，账本应保持空',
    );
  });
});
