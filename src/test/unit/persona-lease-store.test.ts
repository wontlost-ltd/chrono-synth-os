/**
 * ADR-0047 + ADR-0048：per-persona 并发锁（PersonaLeaseStore）。
 * 用真实 better-sqlite3 + 全量 DSL 迁移（含 v081 persona_leases）验证 CAS 语义：
 *   - 互斥：同 persona+purpose 第二次 acquire 在未过期时失败
 *   - 过期抢占：到期后可被另一持有者抢占
 *   - 持有者隔离：release/refresh 必须 holder_token 匹配（防 A 释放 B 的锁）
 *   - 维度独立：不同 persona / 不同 purpose 互不阻塞
 *   - withLease：拿到锁执行并 finally 释放；异常也释放；拿不到返回 undefined
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaLeaseStore } from '../../storage/persona-lease-store.js';

const TENANT = 'default';
const P1 = 'persona_1';
const P2 = 'persona_2';

describe('PersonaLeaseStore (ADR-0047/0048 per-persona concurrency lease)', () => {
  let db: IDatabase;
  let store: PersonaLeaseStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new PersonaLeaseStore(db, TENANT);
  });

  /* ⚠️ issue #395 起 `expires_at` 由**数据库**盖戳、抢占判定也用 DB 时钟
   * （租约是跨副本互斥原语，抢占者钟快就能抢走仍有效的租约——见
   * persona-lease-types.ts 的说明）。
   *
   * 代价是**不能再靠传 `now + 11_000` 做时间旅行**：那个参数已不参与判定。
   * 要模拟"过期"只能把行里的 `expires_at` 直接改老，这也更贴近真实——
   * 真实里租约就是靠挂钟走到而过期的，没人能把时钟推快。 */
  function ageLeaseBy(personaId: string, purpose: string, ms: number): void {
    db.prepare<void>(
      `UPDATE persona_leases SET expires_at = expires_at - ?
       WHERE tenant_id = ? AND persona_id = ? AND purpose = ?`,
    ).run(ms, TENANT, personaId, purpose);
  }

  it('首次 acquire 成功并写入租约', () => {
    const before = Date.now();
    const handle = store.acquire(P1, 'earning', before, 60_000);
    assert.ok(handle, 'first acquire should succeed');
    assert.equal(handle!.purpose, 'earning');
    /* expiresAt 由 DB 算：只能断言它落在合理区间，且**回读自库里**。
     * SQLite 的 strftime('%s') 只有秒级精度，故下界放宽 1s。 */
    const lease = store.get(P1, 'earning');
    assert.equal(handle!.expiresAt, lease?.expiresAt, '句柄里的到期时刻必须是库里实际的值');
    assert.ok(handle!.expiresAt >= before + 60_000 - 1_000, `到期时刻过早：${handle!.expiresAt}`);
    assert.ok(handle!.expiresAt <= Date.now() + 60_000 + 1_000, `到期时刻过晚：${handle!.expiresAt}`);
    assert.equal(lease?.holderToken, handle!.holderToken);
  });

  it('互斥：未过期时第二次 acquire 失败（拿不到锁）', () => {
    const now = 1_000_000;
    const first = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(first);
    /* 1 秒后另一实例尝试获取同 persona+purpose */
    const second = store.acquire(P1, 'earning', now + 1_000, 60_000);
    assert.equal(second, null, 'second acquire must fail while lease is held & unexpired');
    /* 原持有者未变 */
    assert.equal(store.get(P1, 'earning')?.holderToken, first!.holderToken);
  });

  it('过期抢占：到期后另一持有者可抢占', () => {
    const now = Date.now();
    const first = store.acquire(P1, 'earning', now, 10_000);
    assert.ok(first);
    /* 把到期时刻挪早 11 秒，等价于「11 秒后」——DB 时钟不能被调用方推快。 */
    ageLeaseBy(P1, 'earning', 11_000);
    const taken = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(taken, 'expired lease should be takeable');
    assert.notEqual(taken!.holderToken, first!.holderToken);
    assert.equal(store.get(P1, 'earning')?.holderToken, taken!.holderToken);
  });

  it('边界语义：expires_at <= DB now 即视为过期可抢占', () => {
    const now = Date.now();
    const first = store.acquire(P1, 'earning', now, 10_000);
    assert.ok(first);
    /* 把 expires_at 精确挪到「现在」：与 SQL 的 `expires_at <= dbNow` 判据同界。
     * 用 DB 时钟自己写，避免应用侧 Date.now() 与 DB 秒级时钟错位造成 flake。 */
    db.prepare<void>(
      `UPDATE persona_leases SET expires_at = (CAST(strftime('%s','now') AS INTEGER) * 1000)
       WHERE tenant_id = ? AND persona_id = ? AND purpose = ?`,
    ).run(TENANT, P1, 'earning');
    const atBoundary = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(atBoundary, 'at exact expiry the lease is expired and takeable');
    assert.notEqual(atBoundary!.holderToken, first!.holderToken);

    /* 未过期时抢不到（这条才是互斥的核心保证）。 */
    db.prepare<void>('DELETE FROM persona_leases').run();
    const again = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(again);
    assert.equal(store.acquire(P1, 'earning', now, 60_000), null, 'unexpired lease must not be takeable');
  });

  it('持有者隔离：release 必须 holder_token 匹配', () => {
    const now = 1_000_000;
    const owner = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(owner);
    /* 伪造一个不同 token 的句柄尝试释放 */
    const forged = { ...owner!, holderToken: 'forged-token' };
    assert.equal(store.release(forged), false, 'release with wrong token must fail');
    assert.ok(store.get(P1, 'earning'), 'lease should still exist');
    /* 真正持有者可释放 */
    assert.equal(store.release(owner!), true);
    assert.equal(store.get(P1, 'earning'), undefined);
  });

  it('release 后可立即重新 acquire（锁已让出）', () => {
    const now = 1_000_000;
    const first = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(store.release(first!));
    const second = store.acquire(P1, 'earning', now + 1, 60_000);
    assert.ok(second, 'after release the lease is immediately re-acquirable even before TTL');
  });

  it('refresh：持有者续租延长 expiresAt；非持有者续租失败', () => {
    const now = Date.now();
    const owner = store.acquire(P1, 'earning', now, 30_000);
    assert.ok(owner);

    /* 先把租约"变旧"10 秒（仍未过期），这样续租后的到期时刻必然比原来晚。
     * 不能再传 `now + 10_000` —— 那个参数已不参与 DB 侧的判定与盖戳。 */
    ageLeaseBy(P1, 'earning', 10_000);
    const agedExpiry = store.get(P1, 'earning')!.expiresAt;

    const refreshed = store.refresh(owner!, now, 30_000);
    assert.ok(refreshed, 'owner can refresh');
    assert.ok(refreshed!.expiresAt > agedExpiry, '续租必须把到期时刻推后');
    assert.equal(store.get(P1, 'earning')?.expiresAt, refreshed!.expiresAt,
      '句柄里的到期时刻必须是库里实际的值');

    /* 非持有者续租失败 */
    const forged = { ...owner!, holderToken: 'other' };
    assert.equal(store.refresh(forged, now, 30_000), null);
  });

  it('refresh：已过期的锁不能续租（须重新 acquire）', () => {
    const now = Date.now();
    const owner = store.acquire(P1, 'earning', now, 10_000);
    assert.ok(owner);
    /* 把到期时刻挪早 11 秒 → 已过期；`expires_at > dbNow` 不满足，续租须失败。 */
    ageLeaseBy(P1, 'earning', 11_000);
    const refreshed = store.refresh(owner!, now, 30_000);
    assert.equal(refreshed, null, 'expired lease cannot be refreshed');
  });

  it('维度独立：不同 persona 互不阻塞', () => {
    const now = 1_000_000;
    assert.ok(store.acquire(P1, 'earning', now, 60_000));
    assert.ok(store.acquire(P2, 'earning', now, 60_000), 'different persona, same purpose: independent');
  });

  it('维度独立：同 persona 不同 purpose 互不阻塞', () => {
    const now = 1_000_000;
    assert.ok(store.acquire(P1, 'earning', now, 60_000));
    assert.ok(store.acquire(P1, 'compile', now, 60_000), 'same persona, different purpose: independent');
  });

  it('非法输入：acquire ttlMs<=0 抛错（kernel 校验）', () => {
    assert.throws(() => store.acquire(P1, 'earning', 1_000_000, 0), /非法输入|ttlMs/);
  });

  it('非法输入：refresh ttlMs<=0 抛错（kernel 校验，防把租约写到过去）', () => {
    const now = 1_000_000;
    const h = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(h);
    assert.throws(() => store.refresh(h!, now + 1_000, 0), /非法输入|ttlMs/);
    assert.throws(() => store.refresh(h!, -1, 60_000), /非法输入|now/);
  });

  it('withLease：拿到锁执行 fn 并在 finally 释放', async () => {
    const now = 1_000_000;
    let ran = false;
    const out = await store.withLease(P1, 'compile', now, 60_000, async () => {
      ran = true;
      /* 持锁期间另一实例抢不到 */
      assert.equal(store.acquire(P1, 'compile', now + 1, 60_000), null);
      return 'done';
    });
    assert.equal(ran, true);
    assert.equal(out, 'done');
    /* 退出后锁已释放 */
    assert.ok(store.acquire(P1, 'compile', now + 2, 60_000));
  });

  it('withLease：fn 抛异常时锁仍被释放', async () => {
    const now = 1_000_000;
    await assert.rejects(
      store.withLease(P1, 'compile', now, 60_000, async () => { throw new Error('boom'); }),
      /boom/,
    );
    /* 异常后锁不应悬挂 */
    assert.ok(store.acquire(P1, 'compile', now + 1, 60_000), 'lease released even when fn throws');
  });

  it('withLease：拿不到锁返回 undefined（不执行 fn）', async () => {
    const now = 1_000_000;
    const held = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(held);
    let ran = false;
    const out = await store.withLease(P1, 'earning', now + 1, 60_000, async () => { ran = true; return 'x'; });
    assert.equal(out, undefined);
    assert.equal(ran, false, 'fn must not run when lease unavailable');
  });

  /* ── issue #395 条目 3：租约的到期与抢占判定须由数据库单一时钟裁决 ──
   *
   * 这张表最反直觉：租约**就是**跨副本互斥原语——持有者在副本 A、抢占者在
   * 副本 B，「写读同源」按定义不可能靠调用方保证。原实现里 expires_at 由
   * 持有者的 Date.now() 算、抢占判定用抢占者的 Date.now() 比：**抢占者钟快
   * 就能抢走仍然有效的租约**，互斥当场失效——而互斥正是这张表存在的唯一理由。
   *
   * 判据是结构性的：SQL 里不得出现应用侧算好的时刻。 */
  it('审计 #395：acquire 的 SQL 不接受应用侧时刻（到期与判定都由 DB 算）', () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const st = orig(sql);
      const origRun = st.run.bind(st);
      st.run = ((...params: unknown[]) => { seen.push({ sql, params }); return origRun(...params as never[]); }) as typeof st.run;
      return st;
    }) as typeof db.prepare;

    store.acquire(P1, 'earning', Date.now(), 60_000);
    (db as unknown as { prepare: typeof db.prepare }).prepare = orig;

    const acq = seen.find((e) => /INSERT INTO persona_leases/.test(e.sql));
    assert.ok(acq, '必须执行了 acquire（否则下面断言是空转）');

    /* 变异实测：写回 `VALUES (…, ?)` + 应用侧 expiresAt、判定用 `<= ?` + now
     * → 参数里出现两个 1.7e12 量级的 epoch 时刻，下面两行转红。
     *
     * 注意 acquired_at 仍是应用侧时刻：它是**记录**（诊断用），不参与任何
     * 跨副本判定，故只钉 expires_at 与抢占谓词这两处。 */
    assert.ok(/\+ \?/.test(acq.sql), 'expires_at 必须写成「DB 时钟 + 时长」表达式');
    assert.ok(/expires_at <= \(/.test(acq.sql), '抢占判定必须用 SQL 内的 DB 时钟');

    const epochish = acq.params.filter((v) => typeof v === 'number' && v > 1e11);
    assert.equal(epochish.length, 1,
      `除 acquired_at 外不得再传 epoch 时刻（实际：${JSON.stringify(acq.params)}）`);
  });

  it('审计 #395：refresh 的 SQL 同样不接受应用侧时刻', () => {
    const owner = store.acquire(P1, 'earning', Date.now(), 60_000);
    assert.ok(owner);

    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const st = orig(sql);
      const origRun = st.run.bind(st);
      st.run = ((...params: unknown[]) => { seen.push({ sql, params }); return origRun(...params as never[]); }) as typeof st.run;
      return st;
    }) as typeof db.prepare;

    store.refresh(owner!, Date.now(), 30_000);
    (db as unknown as { prepare: typeof db.prepare }).prepare = orig;

    const ref = seen.find((e) => /UPDATE persona_leases/.test(e.sql) && /expires_at/.test(e.sql));
    assert.ok(ref, '必须执行了 refresh');

    for (const v of ref.params) {
      if (typeof v !== 'number') continue;
      assert.ok(v < 1e11, `refresh 不得把 epoch 时刻当参数传（发现 ${v}）`);
    }
    assert.ok(/expires_at > \(/.test(ref.sql), '「仍未过期」判定必须用 DB 时钟');
  });
});
