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

  it('首次 acquire 成功并写入租约', () => {
    const now = 1_000_000;
    const handle = store.acquire(P1, 'earning', now, 60_000);
    assert.ok(handle, 'first acquire should succeed');
    assert.equal(handle!.purpose, 'earning');
    assert.equal(handle!.expiresAt, now + 60_000);
    const lease = store.get(P1, 'earning');
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
    const now = 1_000_000;
    const first = store.acquire(P1, 'earning', now, 10_000);
    assert.ok(first);
    /* 11 秒后（已过 10s TTL）抢占 */
    const taken = store.acquire(P1, 'earning', now + 11_000, 60_000);
    assert.ok(taken, 'expired lease should be takeable');
    assert.notEqual(taken!.holderToken, first!.holderToken);
    assert.equal(store.get(P1, 'earning')?.holderToken, taken!.holderToken);
  });

  it('边界语义：恰好等于 expiresAt 即视为过期可抢占（now >= expiresAt）', () => {
    const now = 1_000_000;
    const first = store.acquire(P1, 'earning', now, 10_000); /* expiresAt = now+10_000 */
    assert.ok(first);
    /* 正好在 expiresAt 时刻：TTL 耗尽，可被抢占（与 SQL expires_at <= now 一致） */
    const atBoundary = store.acquire(P1, 'earning', now + 10_000, 60_000);
    assert.ok(atBoundary, 'at exact expiry the lease is expired and takeable');
    assert.notEqual(atBoundary!.holderToken, first!.holderToken);
    /* 但过期前一刻（now+9_999）仍持有，抢不到 */
    db.prepare<void>('DELETE FROM persona_leases').run();
    const again = store.acquire(P1, 'earning', now, 10_000);
    assert.ok(again);
    assert.equal(store.acquire(P1, 'earning', now + 9_999, 60_000), null, 'just before expiry the lease is still held');
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
    const now = 1_000_000;
    const owner = store.acquire(P1, 'earning', now, 30_000);
    assert.ok(owner);
    const refreshed = store.refresh(owner!, now + 10_000, 30_000);
    assert.ok(refreshed, 'owner can refresh');
    assert.equal(refreshed!.expiresAt, now + 10_000 + 30_000);
    assert.equal(store.get(P1, 'earning')?.expiresAt, now + 40_000);
    /* 非持有者续租失败 */
    const forged = { ...owner!, holderToken: 'other' };
    assert.equal(store.refresh(forged, now + 11_000, 30_000), null);
  });

  it('refresh：已过期的锁不能续租（须重新 acquire）', () => {
    const now = 1_000_000;
    const owner = store.acquire(P1, 'earning', now, 10_000);
    assert.ok(owner);
    /* 过期后续租失败（expires_at > now 条件不满足） */
    const refreshed = store.refresh(owner!, now + 11_000, 30_000);
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
});
