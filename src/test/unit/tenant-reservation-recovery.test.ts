/**
 * 租户分片 Phase 0 · Plan 1c Task 8 —— `TenantReservationRecovery` 恢复 worker 行为验证。
 *
 * 恢复 worker 扫协调库过期 PENDING（仅 lookup_kind='email'），按 `operation_kind` 分两支收敛
 * （spec §4.1.6「绝不取消 PENDING」）：
 *
 *   - **REGISTER**：查该租户 shard 的 `tenant_bootstrap`（按 operationId per-op 匹配）——status=COMPLETE
 *     才 CAS 补 ACTIVE（activated++）；否则保留 + warn（retained++），**绝不取消**。per-op 锚：shard
 *     有 user 行但无匹配 bootstrap → retained；shard 有**别 operationId** 的旧 COMPLETE（SCIM/OIDC 复用
 *     已存在 tenant）→ 仍 retained。
 *   - **EMAIL_CHANGE**：读 shard user（按 userId）的 canonical email——== newEmail(lookup_value) →
 *     completeEmailChange（新 ACTIVE + 旧删，changesCompleted++）；== oldEmail(previous_lookup_value) →
 *     rollbackEmailChange（删新 PENDING、旧仍 ACTIVE 权威，changesRolledBack++）；其他值 → 保留 + warn。
 *     两窗口（shard 改了 / shard 未改）reconcile 后都不「新旧都登不上」。
 *
 * 用 `FakeMultiShardResolver`（coordinator 独立 db、shard 另一独立 db）钉死路由分流。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, renderAllForTarget } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import {
  registerCoreSelfExecutors, resetCoreSelfExecutors,
} from '../../storage/executors/index.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { TenantIdentityDirectory } from '../../identity/tenant-identity-directory.js';
import { TenantReservationRecovery } from '../../identity/tenant-reservation-recovery.js';
import { SilentLogger } from '../../utils/logger.js';
import { dirCmdReserve, bootCmdMarkComplete } from '@chrono/kernel';
import { canonicalizeEmail } from '../../identity/email-canonical.js';

/** v124 在 sqlite 侧的 alias。 */
const V124_SQLITE = 'v124';

/** 把 sqlite 迁移逐条应用直到（含）v124，为 directory / bootstrap / users 表建好结构。 */
function migrateToV124(db: IDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  for (const migration of renderAllForTarget('sqlite-sql')) {
    for (const sql of migration.sql) db.exec(sql);
    db.prepare<void>(
      'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
    ).run(migration.version, migration.description, Date.now());
    if (migration.version === V124_SQLITE) return;
  }
  throw new Error(`目标迁移版本 ${V124_SQLITE} 未在 renderAllForTarget('sqlite-sql') 中找到`);
}

/** reserve 时刻（远早于 cutoff，保证被 listPending 扫到）。 */
const RESERVED_AT = 1_700_000_000_000;
/* ⚠️ issue #395：reconcile 不再收 now——过期判定的截止点由数据库算。
 * RESERVED_AT 是 2023 年的时刻，相对真实 DB 时钟早已超出任何 grace，
 * 故被 listPending 扫到。 */

describe('TenantReservationRecovery 恢复 worker', () => {
  let coordinator: IDatabase;
  let shard: IDatabase;
  let dir: TenantIdentityDirectory;
  let recovery: TenantReservationRecovery;

  beforeEach(() => {
    resetCoreSelfExecutors();
    registerCoreSelfExecutors();
    coordinator = createMemoryDatabase();
    shard = createMemoryDatabase();
    migrateToV124(coordinator);
    migrateToV124(shard);
    const resolver = new FakeMultiShardResolver({
      coordinator,
      shards: { s0: shard },
      tenantToShard: { tenant_a: 's0', tenant_b: 's0', tenant_c: 's0', tenant_d: 's0' },
    });
    dir = new TenantIdentityDirectory(resolver);
    /* graceMs=0：本测直接控制 reserve/now 时间戳，无需额外宽限窗口。 */
    recovery = new TenantReservationRecovery(resolver, new SilentLogger(), { graceMs: 0 });
  });

  /** 手插一条 email PENDING 目录项到 coordinator（模拟 reserve 后 shard 未确认即崩）。 */
  function insertPending(input: {
    tenantId: string; userId: string; operationId: string; operationKind: string;
    previousLookupValue: string | null; email: string;
  }): void {
    coordinator.execute(dirCmdReserve({
      tenantId: input.tenantId, userId: input.userId, operationId: input.operationId,
      operationKind: input.operationKind, previousLookupValue: input.previousLookupValue,
      pendingPasswordHash: null, lookupKind: 'email', lookupValue: canonicalizeEmail(input.email),
      status: 'PENDING', now: RESERVED_AT,
    }));
    /* ⚠️ issue #395 起 `updated_at` 由**数据库**盖戳，`now: RESERVED_AT`
     * 只写 created_at。要让这条 PENDING 看起来"已过期"，必须把 updated_at
     * 直接改老——调用方已无法通过传 now 把时钟推快，这正是本次修复的要点。 */
    coordinator.prepare<void>(
      `UPDATE tenant_identity_directory SET updated_at = ?
       WHERE lookup_kind = 'email' AND lookup_value = ?`,
    ).run(RESERVED_AT, canonicalizeEmail(input.email));
  }

  /** 手插一条 shard 用户行（供 EMAIL_CHANGE 读 canonical email / REGISTER per-op 锚的 user 行）。 */
  function insertShardUser(input: { userId: string; email: string; tenantId: string }): void {
    shard.prepare<void>(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'member', ?, ?, ?)`,
    ).run(input.userId, canonicalizeEmail(input.email), 'h', input.tenantId, RESERVED_AT, RESERVED_AT);
  }

  describe('REGISTER 支（凭 bootstrap COMPLETE per-op 补 ACTIVE，未完成保留绝不取消）', () => {
    it('A shard 有匹配 operationId 的 COMPLETE → CAS 补 ACTIVE；B 无匹配 → 仍 PENDING 未删', () => {
      /* A：shard 写成功（bootstrap COMPLETE 匹配 opId）、但 coordinator activate 前崩 → 仍 PENDING。 */
      insertPending({ tenantId: 'tenant_a', userId: 'u_a', operationId: 'reg:A',
        operationKind: 'REGISTER', previousLookupValue: null, email: 'a@example.com' });
      shard.execute(bootCmdMarkComplete({ tenantId: 'tenant_a', operationId: 'reg:A', now: RESERVED_AT }));

      /* B：shard 有 user 行（半写）但无匹配 bootstrap → per-op 锚要求 retained（非「user 行存在即证」）。 */
      insertPending({ tenantId: 'tenant_b', userId: 'u_b', operationId: 'reg:B',
        operationKind: 'REGISTER', previousLookupValue: null, email: 'b@example.com' });
      insertShardUser({ userId: 'u_b', email: 'b@example.com', tenantId: 'tenant_b' });

      const out = recovery.reconcile();

      assert.equal(out.activated, 1, 'A 补 ACTIVE');
      assert.equal(out.retained, 1, 'B 保留');
      assert.equal(out.changesCompleted, 0);
      assert.equal(out.changesRolledBack, 0);

      /* A → ACTIVE。 */
      assert.equal(dir.resolveByEmail('a@example.com')!.status, 'ACTIVE', 'A 已激活');
      /* B 目录项仍在且仍 PENDING（未删、未取消）。 */
      const bEntry = dir.resolveByEmail('b@example.com');
      assert.ok(bEntry, 'B 目录项仍在（绝不取消/删）');
      assert.equal(bEntry!.status, 'PENDING', 'B 仍 PENDING');
    });

    /* 审计 Warning B1-3 的配套证明：activateTenantOrThrow 在 CAS 失败时抛错，
     * 会留下「shard 已落地 + 目录仍 PENDING」的状态。该状态**必须可由清扫器收敛**——
     * 否则修掉「签出登不进去的账号」反而换来「账号永久卡住」。
     * SSO/SCIM 的 reservePasswordlessTenant 同样写 operationKind='REGISTER'，
     * 故走同一分支。 */
    it('SSO/SCIM 抛错后的滞留项（shard COMPLETE + 目录 PENDING）可被清扫器收敛', () => {
      insertPending({ tenantId: 'tenant_a', userId: 'u_sso', operationId: 'sso:X',
        operationKind: 'REGISTER', previousLookupValue: null, email: 'sso@example.com' });
      shard.execute(bootCmdMarkComplete({ tenantId: 'tenant_a', operationId: 'sso:X', now: RESERVED_AT }));

      const out = recovery.reconcile();

      assert.equal(out.activated, 1, '清扫器补 ACTIVE');
      assert.equal(dir.resolveByEmail('sso@example.com')!.status, 'ACTIVE', '账号可用，未永久卡死');
    });

    it('per-op 锚：tenant 有别 operationId 的旧 COMPLETE（SCIM/OIDC 复用已存在 tenant）→ 仍 retained', () => {
      insertPending({ tenantId: 'tenant_a', userId: 'u_new', operationId: 'reg:NEW',
        operationKind: 'REGISTER', previousLookupValue: null, email: 'reuse@example.com' });
      /* 同租户存在**别 operationId** 的旧 COMPLETE（旧 register），本次 operationId 无标记。 */
      shard.execute(bootCmdMarkComplete({ tenantId: 'tenant_a', operationId: 'reg:OLD', now: RESERVED_AT }));

      const out = recovery.reconcile();

      assert.equal(out.activated, 0, '别 operationId 的旧 COMPLETE 不误证本次 operation');
      assert.equal(out.retained, 1, '按 opId 匹配 → 未命中 → retained');
      assert.equal(dir.resolveByEmail('reuse@example.com')!.status, 'PENDING', '仍 PENDING（未激活）');
    });
  });

  describe('EMAIL_CHANGE 支（凭 shard canonical email 收敛，两窗口都不锁死账号）', () => {
    /** 建旧 email 的 ACTIVE 目录项（老用户在用）。 */
    function seedActiveOld(tenantId: string, userId: string, oldEmail: string): void {
      insertPending({ tenantId, userId, operationId: `reg:${userId}`,
        operationKind: 'REGISTER', previousLookupValue: null, email: oldEmail });
      const ok = dir.activateTenant({ email: oldEmail, operationId: `reg:${userId}` });
      assert.equal(ok, true, '旧 email 预置 ACTIVE');
    }

    it('C shard.email 已== new（改了 complete 前崩）→ completeEmailChange：新 ACTIVE + 旧删，login(new) 通', () => {
      seedActiveOld('tenant_c', 'u_c', 'c-old@example.com');
      insertPending({ tenantId: 'tenant_c', userId: 'u_c', operationId: 'ec:C',
        operationKind: 'EMAIL_CHANGE', previousLookupValue: canonicalizeEmail('c-old@example.com'),
        email: 'c-new@example.com' });
      /* shard 权威 email 已改到 new（应用改了 shard，coordinator complete 前崩）。 */
      insertShardUser({ userId: 'u_c', email: 'c-new@example.com', tenantId: 'tenant_c' });

      const out = recovery.reconcile();

      assert.equal(out.changesCompleted, 1, 'C 完成改名');
      assert.equal(out.changesRolledBack, 0);
      assert.equal(out.activated, 0);
      assert.equal(out.retained, 0);

      /* 新 email ACTIVE（login by new 通）、旧 email 删。 */
      assert.equal(dir.resolveByEmail('c-new@example.com')!.status, 'ACTIVE', '新 email ACTIVE');
      assert.equal(dir.resolveByEmail('c-old@example.com'), null, '旧 email 已删');
      /* 窗口不锁死：至少有一个 ACTIVE 可 login（此处是 new）。 */
      assert.ok(dir.resolveByEmail('c-new@example.com'), '不「新旧都登不上」');
    });

    it('D shard.email 仍== old（reserve 后 shard 改前崩）→ rollbackEmailChange：删新 PENDING、旧仍 ACTIVE，login(old) 通', () => {
      seedActiveOld('tenant_d', 'u_d', 'd-old@example.com');
      insertPending({ tenantId: 'tenant_d', userId: 'u_d', operationId: 'ec:D',
        operationKind: 'EMAIL_CHANGE', previousLookupValue: canonicalizeEmail('d-old@example.com'),
        email: 'd-new@example.com' });
      /* shard 权威 email 仍是 old（reserve 了新 PENDING，但 shard 改 email 前崩）。 */
      insertShardUser({ userId: 'u_d', email: 'd-old@example.com', tenantId: 'tenant_d' });

      const out = recovery.reconcile();

      assert.equal(out.changesRolledBack, 1, 'D 回滚改名');
      assert.equal(out.changesCompleted, 0);
      assert.equal(out.activated, 0);
      assert.equal(out.retained, 0);

      /* 新 PENDING 删、旧 email 仍权威 ACTIVE（login by old 通）。 */
      assert.equal(dir.resolveByEmail('d-new@example.com'), null, '未竟新 PENDING 已删');
      assert.equal(dir.resolveByEmail('d-old@example.com')!.status, 'ACTIVE', '旧 email 仍 ACTIVE');
      /* 窗口不锁死：至少有一个 ACTIVE 可 login（此处是 old）。 */
      assert.ok(dir.resolveByEmail('d-old@example.com'), '不「新旧都登不上」');
    });

    it('shard.email 既非 new 也非 old（无法判定）→ 保留 + warn，绝不猜测', () => {
      seedActiveOld('tenant_c', 'u_c', 'e-old@example.com');
      insertPending({ tenantId: 'tenant_c', userId: 'u_c', operationId: 'ec:E',
        operationKind: 'EMAIL_CHANGE', previousLookupValue: canonicalizeEmail('e-old@example.com'),
        email: 'e-new@example.com' });
      /* shard email 是第三个值（诡异态）→ 不猜测。 */
      insertShardUser({ userId: 'u_c', email: 'e-weird@example.com', tenantId: 'tenant_c' });

      const out = recovery.reconcile();

      assert.equal(out.retained, 1, '无法判定 → retained');
      assert.equal(out.changesCompleted, 0);
      assert.equal(out.changesRolledBack, 0);
      /* 新 PENDING 仍在（不删）、旧仍 ACTIVE（不破坏用户空间）。 */
      assert.equal(dir.resolveByEmail('e-new@example.com')!.status, 'PENDING', '新 PENDING 保留');
      assert.equal(dir.resolveByEmail('e-old@example.com')!.status, 'ACTIVE', '旧仍 ACTIVE');
    });
  });

  describe('鲁棒性：单项失败不阻塞其他项', () => {
    it('一个项处理抛错（shard 无映射）→ 记 retained，其余项仍处理', () => {
      /* F：REGISTER，但 tenantId 无 shard 映射 → dbForTenant 抛错 → 该项计入 retained，不崩整个循环。 */
      insertPending({ tenantId: 'tenant_unmapped', userId: 'u_f', operationId: 'reg:F',
        operationKind: 'REGISTER', previousLookupValue: null, email: 'f@example.com' });

      /* A：正常 REGISTER 可激活（验证 F 抛错不影响 A）。 */
      insertPending({ tenantId: 'tenant_a', userId: 'u_a', operationId: 'reg:A2',
        operationKind: 'REGISTER', previousLookupValue: null, email: 'a2@example.com' });
      shard.execute(bootCmdMarkComplete({ tenantId: 'tenant_a', operationId: 'reg:A2', now: RESERVED_AT }));

      const out = recovery.reconcile();

      assert.equal(out.activated, 1, 'A 仍被激活（F 抛错未阻塞）');
      assert.equal(out.retained, 1, 'F 项因抛错记 retained');
      assert.equal(dir.resolveByEmail('a2@example.com')!.status, 'ACTIVE');
      /* F 的 PENDING 未删（处理失败保留）。 */
      assert.equal(dir.resolveByEmail('f@example.com')!.status, 'PENDING', 'F PENDING 保留');
    });
  });

  /* ── issue #395 条目 4：PENDING 过期判定须由数据库单一时钟裁决 ──
   *
   * 缺陷：`updated_at` 由发起预留的副本写，而过期判定跑在恢复 worker 副本上
   * 并传自己算的 `now - graceMs`。两端不同源，worker 钟快就会把**刚发起**的
   * 预留当成过期工单去回滚（EMAIL_CHANGE 会删掉用户刚申请的新 email 目录项）。
   *
   * 判据是结构性的：SQL 里不得把截止时刻当参数传。 */
  it('审计 #395：过期扫描只传宽限时长，不传截止时刻', () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const orig = coordinator.prepare.bind(coordinator);
    (coordinator as unknown as { prepare: typeof coordinator.prepare }).prepare = ((sql: string) => {
      const st = orig(sql);
      const origAll = st.all.bind(st);
      st.all = ((...params: unknown[]) => { seen.push({ sql, params }); return origAll(...params as never[]); }) as typeof st.all;
      return st;
    }) as typeof coordinator.prepare;

    dir.listPending(60_000);
    (coordinator as unknown as { prepare: typeof coordinator.prepare }).prepare = orig;

    const scan = seen.find((e) => /FROM tenant_identity_directory/.test(e.sql) && /PENDING/.test(e.sql));
    assert.ok(scan, '必须执行了过期扫描（否则本用例是空转）');

    /* 变异实测：判据改回 `updated_at < ?` + 调用方算的 cutoff →
     * 参数变成 1.7e12 量级的 epoch 时刻，下面转红。 */
    assert.deepEqual(scan.params, [60_000],
      `扫描只应传宽限时长（实际参数：${JSON.stringify(scan.params)}）`);
    assert.ok(/updated_at <= \(/.test(scan.sql), '截止点必须由 SQL 内的 DB 时钟算出');
  });
});
