/**
 * PG bigint → JS string 强转回归测试（审计 #404 / #425）。
 *
 * 缺陷：`COUNT(*)` 在 PostgreSQL 下是 **bigint**，node-pg 把它映射成 **JS string**
 * （避免超 Number.MAX_SAFE_INTEGER 时静默失真）；SQLite 返回 number。
 * 代码把行声明为 `{ count: number }` 直接返回 —— 类型是**谎言**。
 *
 * 后果：
 *   #404 `POST /conflicts/resolve` 在 PG 上 `.parse()` 抛错 → 500，而 UPDATE 已提交；
 *        重试撞 `resolved_at IS NULL` → 409 → 用户**永远拿不到成功响应**。
 *   #425 SOC2 证据 payload 进 SHA-256 防篡改哈希 → 两种后端哈希不同 →
 *        迁移后 verify 把历史证据判为「已篡改」。
 *
 * ⚠️ 为什么不能只靠 SQLite 跑：SQLite 返回 number，缺陷在它上面**天然不可见**
 * （这正是缺陷长期存活的原因 —— 仓库默认测试路径是 SQLite）。
 * 故这里**注入一个返回 string 的假 db**来复刻 PG 的行为契约，
 * 断言「无论驱动返回 string 还是 number，函数都必须返回 number」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { countBlockingConflicts, countPendingConflicts } from '../../privacy/conflict-inbox-store.js';
import type { IDatabase } from '../../storage/database.js';

/** 包一层 db，把 COUNT 查询的结果值改成 string —— 复刻 node-pg 的 bigint 行为。 */
function withPgBigintSemantics(db: IDatabase): IDatabase {
  const realPrepare = db.prepare.bind(db);
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = realPrepare(sql);
          if (!/COUNT\(\*\)/i.test(sql)) return stmt;
          const realGet = stmt.get.bind(stmt);
          return Object.assign(Object.create(Object.getPrototypeOf(stmt) as object), stmt, {
            get: (...args: unknown[]) => {
              const row = realGet(...(args as Parameters<typeof realGet>)) as Record<string, unknown> | undefined;
              if (!row) return row;
              /* 把所有数值字段转成 string，正是 node-pg 对 bigint 的做法。 */
              const out: Record<string, unknown> = { ...row };
              for (const k of Object.keys(out)) {
                if (typeof out[k] === 'number') out[k] = String(out[k]);
              }
              return out;
            },
          }) as typeof stmt;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

describe('PG bigint 计数强转（审计 #404 / #425）', () => {
  function setup(): IDatabase {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const now = Date.now();
    /* 两条 blocking + 一条已解决，确保计数非零（零值会让 string/number 差异被 ?? 掩盖）。 */
    for (const [id, sev, resolved] of [
      ['c1', 'blocking', null], ['c2', 'blocking', null], ['c3', 'blocking', String(now)],
    ] as const) {
      db.prepare<void>(
        `INSERT INTO conflict_inbox
           (conflict_id, conflict_version, tenant_id, entity_type, entity_id, source_runtime,
            detected_at, severity, local_summary_id, local_summary_params,
            server_summary_id, server_summary_params, suggested_actions, resolved_at)
         VALUES (?, 1, ?, ?, ?, 'desktop', ?, ?, 'l', '{}', 's', '{}', '[]', ?)`,
      ).run(id, 't1', 'value', `e-${id}`, now, sev, resolved);
    }
    return db;
  }

  it('SQLite（返回 number）：计数必须是 number', () => {
    const db = setup();
    const blocking = countBlockingConflicts(db, 't1');
    assert.equal(typeof blocking, 'number', `应为 number，实际 ${typeof blocking}`);
    assert.equal(blocking, 2);
  });

  /* ★核心★：这条在修复前会红 —— PG 语义下函数返回 "2" 而非 2。 */
  it('PG 语义（驱动返回 string）：计数仍必须是 number 而非 string', () => {
    const db = withPgBigintSemantics(setup());

    const blocking = countBlockingConflicts(db, 't1');
    assert.equal(
      typeof blocking, 'number',
      `PG 下必须强转为 number，实际 ${typeof blocking} (${JSON.stringify(blocking)})`,
    );
    assert.equal(blocking, 2, '值也必须正确');

    const pending = countPendingConflicts(db, 't1');
    assert.equal(typeof pending, 'number', `PG 下必须强转为 number，实际 ${typeof pending}`);
    assert.equal(pending, 2);
  });

  /* 契约断言：Zod 的 z.number() 会拒 string —— 这正是 #404 的 500 来源。
   * 用它证明「typeof 检查」不是形式主义，而是真实的失败判据。 */
  it('强转后的值能通过 z.number() 契约（#404 的 500 根因）', async () => {
    const { z } = await import('zod');
    const schema = z.object({ remainingBlockingCount: z.number().int().nonnegative() });
    const db = withPgBigintSemantics(setup());
    const count = countBlockingConflicts(db, 't1');
    assert.doesNotThrow(
      () => schema.parse({ remainingBlockingCount: count }),
      'PG 下的计数必须能通过 z.number() 契约，否则路由抛 500 而 UPDATE 已提交',
    );
  });
});
