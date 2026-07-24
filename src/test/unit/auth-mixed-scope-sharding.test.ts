/**
 * 租户分片 Phase 0 · Plan 1c Task 5 —— AuthService register 状态机 + login 经目录 + 老用户兼容
 * 的**混合 scope 分片**行为验证。
 *
 * 用 `FakeMultiShardResolver`（独立 coordinator + 2 独立 shard db）钉死 register 的安全铁律（Codex 8 轮
 * 复审逼出，逐条锚测）：
 *   ① register 落点：coordinator email ACTIVE + 对应 shard 有 user 行 + tenant_bootstrap COMPLETE + 他 shard 无；
 *   ② **账号接管回归（最重要）**：已 ACTIVE 的 email 再 register（无/不同 key）→ 抛 AUTH_EMAIL_EXISTS(409)，
 *      绝不签 token、绝不返回 victim userId；
 *   ③ CAS 前崩：shard 写成功但 activate 抛错 → shard 有 user+COMPLETE，coordinator 留 PENDING，未签 token；
 *   ④ CAS 失败续做（同 key 重试、shard 已 COMPLETE、目录已被前次激活 ACTIVE）→ activate 返 false 但收敛
 *      为本 tenant ACTIVE → 正常签发（幂等收敛，非接管）；
 *   ⑤ 确定性重试 canonical 身份：同 key 但不同 idGen 重试 → 复用第一次 tenant/user 签发（不用第二次随机）；
 *   ⑥ PENDING 他人占：另一 opId 的 PENDING → 无匹配 key register → AUTH_REGISTRATION_IN_PROGRESS、不签 token；
 *   ⑥b **PENDING 续做密码所有权**：首次中途崩（PENDING、shard 未 COMPLETE、存首次 hash），攻击者拿泄露 key
 *      用**不同密码** → argon2.verify 失败 → 拒、不续做、不签；原客户端同 key 同密码 → verify 成功 → 续做、
 *      shard user 复用 pending hash；
 *   ⑦ login 经目录：register 后 login ACTIVE→dbForTenant 验密码成功；PENDING 项 login→拒；
 *   ⑧ 老用户兼容：手插「回填」ACTIVE 目录项（大小写混合 email 归一化）+ 对应 shard user → 原大小写 login 成功；
 *   ⑨ Stripe 事务外幂等：spy createCustomer；首次调一次带 idempotencyKey=operationId（调用时 tx 未开）；
 *      同 key 重试（shard COMPLETE）→ 不再调 Stripe。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { hash as argon2Hash } from '@node-rs/argon2';
import { createMemoryDatabase, renderAllForTarget } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import {
  registerCoreSelfExecutors, resetCoreSelfExecutors,
} from '../../storage/executors/index.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { AuthService } from '../../identity/auth-service.js';
import type { IdGenerator, StripeCustomerCreator } from '../../identity/auth-service.js';
import { canonicalizeEmail } from '../../identity/email-canonical.js';
import { loadConfig } from '../../config/schema.js';
import { dirCmdReserve } from '@chrono/kernel';
import { ErrorCode } from '../../errors/index.js';

const V124_SQLITE = 'v124';

/** 逐条应用 sqlite 迁移直到（含）v124，为 directory / bootstrap / users / subscriptions 建表。 */
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

/** 最小 Fastify 桩：generateTokenPair 只用 app.jwtSign（回退 app.jwt.sign）+ app.log.warn。 */
function fakeApp(): FastifyInstance {
  let seq = 0;
  return {
    jwtSign: (payload: unknown) => `hdr.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig${seq++}`,
    jwt: { sign: (payload: unknown) => `hdr.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig${seq++}` },
    log: { warn: () => { /* noop */ } },
  } as unknown as FastifyInstance;
}

/** 确定性 idGen：按预设序列吐 tenant/user id（验 canonical 身份重入不用第二次随机）。 */
function fixedIdGen(tenantId: string, userId: string): IdGenerator {
  return { tenantId: () => tenantId, userId: () => userId };
}

const NOW = 1_700_000_000_000;

describe('AuthService 混合 scope 分片（register 状态机 + login 经目录）', () => {
  let coordinator: IDatabase;
  let shardA: IDatabase;
  let shardB: IDatabase;
  const config = loadConfig({});

  beforeEach(() => {
    resetCoreSelfExecutors();
    registerCoreSelfExecutors();
    coordinator = createMemoryDatabase();
    shardA = createMemoryDatabase();
    shardB = createMemoryDatabase();
    migrateToV124(coordinator);
    migrateToV124(shardA);
    migrateToV124(shardB);
  });

  /** 建一个把候选 tenantId 预映射到指定 shard 的 resolver（fake 要求 tenantToShard 显式声明）。 */
  function resolverFor(tenantToShard: Record<string, string>): FakeMultiShardResolver {
    return new FakeMultiShardResolver({
      coordinator,
      shards: { A: shardA, B: shardB },
      tenantToShard,
    });
  }

  /** 直查协调库 email 目录项。 */
  function dirRow(email: string): { tenant_id: string; status: string; pending_password_hash: string | null } | undefined {
    return coordinator.prepare<{ tenant_id: string; status: string; pending_password_hash: string | null }>(
      'SELECT tenant_id, status, pending_password_hash FROM tenant_identity_directory WHERE lookup_kind = ? AND lookup_value = ?',
    ).get('email', canonicalizeEmail(email));
  }

  /** 直查某 shard 的 user 行。 */
  function shardUser(db: IDatabase, userId: string): { id: string; email: string; tenant_id: string; password_hash: string } | undefined {
    return db.prepare<{ id: string; email: string; tenant_id: string; password_hash: string }>(
      'SELECT id, email, tenant_id, password_hash FROM users WHERE id = ?',
    ).get(userId);
  }

  /** 直查某 shard 的 bootstrap COMPLETE 标记。 */
  function bootRow(db: IDatabase, tenantId: string, operationId: string): { status: string } | undefined {
    return db.prepare<{ status: string }>(
      'SELECT status FROM tenant_bootstrap WHERE tenant_id = ? AND operation_id = ?',
    ).get(tenantId, operationId);
  }

  it('① register 落点：coordinator ACTIVE + 对应 shard 有 user + bootstrap COMPLETE + 他 shard 无', async () => {
    const svc = new AuthService(
      resolverFor({ tenant_1: 'A' }), config, fixedIdGen('tenant_1', 'user_1'),
    );
    const res = await svc.register(fakeApp(), 'Alice@Example.com', 'password123', { idempotencyKey: 'reg:k1' });

    assert.equal(res.tenantId, 'tenant_1');
    assert.equal(res.userId, 'user_1');
    assert.equal(res.email, 'alice@example.com');
    assert.ok(res.accessToken && res.refreshToken);

    /* coordinator email 目录 ACTIVE。 */
    assert.equal(dirRow('alice@example.com')!.status, 'ACTIVE');
    /* shard A 有 user + bootstrap COMPLETE。 */
    const u = shardUser(shardA, 'user_1');
    assert.ok(u, 'shard A 有 user 行');
    assert.equal(u!.email, 'alice@example.com');
    assert.equal(u!.tenant_id, 'tenant_1');
    assert.equal(bootRow(shardA, 'tenant_1', 'reg:k1')!.status, 'COMPLETE');
    /* shard B 无该 user。 */
    assert.equal(shardUser(shardB, 'user_1'), undefined, '他 shard 无 user 行');
    /* refresh token 落 shard A（用户所在 shard）。 */
    const rtA = shardA.prepare('SELECT 1 FROM refresh_tokens WHERE user_id = ?').get('user_1');
    assert.ok(rtA, 'refresh token 落用户所在 shard');
  });

  it('②【账号接管回归·最重要】已 ACTIVE 的 email 再 register（无/不同 key）→ 抛 AUTH_EMAIL_EXISTS(409)、绝不签 token、绝不返回 victim userId', async () => {
    const svc = new AuthService(
      resolverFor({ tenant_v: 'A' }), config, fixedIdGen('tenant_v', 'user_victim'),
    );
    const first = await svc.register(fakeApp(), 'victim@x.com', 'pw1-strongpass', { idempotencyKey: 'reg:victim' });
    assert.equal(first.userId, 'user_victim');

    /* 再 register：不同密码、**不同 key**（攻击者试图重复 register 登入既有账号）。 */
    let threw: unknown;
    try {
      await svc.register(fakeApp(), 'Victim@X.com', 'pw2-attacker', { idempotencyKey: 'reg:attacker' });
      assert.fail('已 ACTIVE 的 email 再 register 必须抛错，绝不签 token');
    } catch (e) { threw = e; }
    assert.equal((threw as { code?: string }).code, ErrorCode.AUTH_EMAIL_EXISTS, '抛 AUTH_EMAIL_EXISTS');
    assert.equal((threw as { statusCode?: number }).statusCode, 409, 'HTTP 409');

    /* 无 key 重复 register 同样抛 409（不接管）。 */
    let threw2: unknown;
    try {
      await svc.register(fakeApp(), 'victim@x.com', 'pw3');
      assert.fail('无 key 重复 register 必须抛错');
    } catch (e) { threw2 = e; }
    assert.equal((threw2 as { statusCode?: number }).statusCode, 409, '无 key 也 409');

    /* victim 的 shard user 仍是原密码（未被攻击者密码覆盖）。 */
    const u = shardUser(shardA, 'user_victim')!;
    const { verify } = await import('@node-rs/argon2');
    assert.equal(await verify(u.password_hash, 'pw1-strongpass'), true, 'victim 原密码未被篡改');
    assert.equal(await verify(u.password_hash, 'pw2-attacker'), false, '攻击者密码未生效');
  });

  it('③ CAS 前崩（activate 抛错）：shard 有 user+COMPLETE，coordinator 留 PENDING，未签 token', async () => {
    const resolver = resolverFor({ tenant_c: 'A' });
    const svc = new AuthService(resolver, config, fixedIdGen('tenant_c', 'user_c'));
    /* stub activateTenant 抛错（模拟激活阶段崩溃）。 */
    const dir = (svc as unknown as { directory: { activateTenant: (i: unknown) => boolean } }).directory;
    dir.activateTenant = () => { throw new Error('CAS 崩'); };

    let threw = false;
    try {
      await svc.register(fakeApp(), 'crash@example.com', 'password123', { idempotencyKey: 'reg:crash' });
    } catch { threw = true; }
    assert.equal(threw, true, 'activate 崩 → register 抛错');

    /* shard 已落地（user + COMPLETE）——bootstrap COMPLETE 是权威标记。 */
    assert.ok(shardUser(shardA, 'user_c'), 'shard 有 user 行（崩在 CAS 前）');
    assert.equal(bootRow(shardA, 'tenant_c', 'reg:crash')!.status, 'COMPLETE');
    /* coordinator 留 PENDING（未激活）。 */
    assert.equal(dirRow('crash@example.com')!.status, 'PENDING', 'coordinator 留 PENDING');
    /* 未签 token：无 refresh_tokens 行。 */
    assert.equal(shardA.prepare('SELECT 1 FROM refresh_tokens WHERE user_id = ?').get('user_c'), undefined, '未签 token');
  });

  it('④ CAS 失败续做（同 key 重试、shard 已 COMPLETE、目录已 ACTIVE）→ activate 返 false 但收敛 ACTIVE → 正常签发（幂等收敛非接管）', async () => {
    const resolver = resolverFor({ tenant_r: 'A' });
    /* 首次 register 成功（目录 ACTIVE + shard COMPLETE）。 */
    const svc1 = new AuthService(resolver, config, fixedIdGen('tenant_r', 'user_r'));
    await svc1.register(fakeApp(), 'retry@example.com', 'password123', { idempotencyKey: 'reg:conv' });
    assert.equal(dirRow('retry@example.com')!.status, 'ACTIVE');

    /* 同 key 重试：ACTIVE 前置门（①）会先抛 AUTH_EMAIL_EXISTS——但那是「已 ACTIVE」路径。
     * 为验④「CAS 返 false 但收敛」这一分支，需在 ACTIVE 门之后、activate 之前进入。
     * 手法：新建一个 svc（同 resolver），先把目录改回 PENDING 以越过①门，再让 activate 因并发已被激活而返 false。
     * 更真实的做法是并发：另一路已激活。这里通过 stub 让 resolveByEmail 首查返 PENDING（越过①）、
     * activateTenant 返 false（已被并发激活）、再查返 ACTIVE 本 tenant（收敛）。 */
    const svc2 = new AuthService(resolver, config, fixedIdGen('tenant_r', 'user_r'));
    const dir = (svc2 as unknown as {
      directory: {
        resolveByEmail: (e: string) => { tenantId: string; status: string; userId: string | null } | null;
        activateTenant: (i: unknown) => boolean;
        reserveTenant: (i: unknown) => unknown;
      };
    }).directory;
    const realReserve = dir.reserveTenant.bind(dir);
    let resolveCall = 0;
    dir.resolveByEmail = (_e: string) => {
      resolveCall++;
      /* 第 1 次（①门）：返 PENDING 越过 ACTIVE 门；后续（⑥门校验）：返本 tenant ACTIVE（收敛）。 */
      return resolveCall === 1
        ? { tenantId: 'tenant_r', status: 'PENDING', userId: 'user_r' }
        : { tenantId: 'tenant_r', status: 'ACTIVE', userId: 'user_r' };
    };
    dir.reserveTenant = realReserve; /* 真 reserve：同 key 读回既存行 → reservedByUs:true + canonical=tenant_r。 */
    dir.activateTenant = () => false; /* 模拟并发已激活 → 本次 CAS 未命中。 */

    const res = await svc2.register(fakeApp(), 'retry@example.com', 'password123', { idempotencyKey: 'reg:conv' });
    assert.equal(res.tenantId, 'tenant_r', '收敛为本 tenant');
    assert.equal(res.userId, 'user_r');
    assert.ok(res.accessToken, 'CAS 返 false 但收敛 ACTIVE → 正常签发');
  });

  it('⑤ 确定性重试 canonical 身份：同 key 但不同 idGen 重试 → 复用第一次 tenant/user 签发（不用第二次随机）', async () => {
    const resolver = resolverFor({ tenant_A: 'A', tenant_B: 'B' });
    /* 首次 register：idGen 吐 tenant_A/u_A。中途崩在 CAS 前（activate 抛错），留 PENDING + shard COMPLETE。 */
    const svc1 = new AuthService(resolver, config, fixedIdGen('tenant_A', 'u_A'));
    const dir1 = (svc1 as unknown as { directory: { activateTenant: (i: unknown) => boolean } }).directory;
    dir1.activateTenant = () => { throw new Error('崩在 CAS 前'); };
    let firstThrew = false;
    try {
      await svc1.register(fakeApp(), 'reuse@example.com', 'password123', { idempotencyKey: 'reg:K' });
    } catch { firstThrew = true; }
    assert.equal(firstThrew, true);
    assert.ok(shardUser(shardA, 'u_A'), '首次已落 shard A（tenant_A）');

    /* 同 key=reg:K 重试，但注不同 idGen（tenant_B/u_B）。canonical 以 reserve 读回为准 → 仍 tenant_A/u_A。 */
    const svc2 = new AuthService(resolver, config, fixedIdGen('tenant_B', 'u_B'));
    const res = await svc2.register(fakeApp(), 'reuse@example.com', 'password123', { idempotencyKey: 'reg:K' });

    assert.equal(res.tenantId, 'tenant_A', 'canonical 复用第一次 tenant_A，不用第二次随机 tenant_B');
    assert.equal(res.userId, 'u_A', 'canonicalUserId 复用第一次 u_A');
    /* 不在 shard B 重建 user。 */
    assert.equal(shardUser(shardB, 'u_B'), undefined, '不在第二次随机 shard 建 user');
    /* email 目录已收敛 ACTIVE 且指向 tenant_A。 */
    const row = dirRow('reuse@example.com')!;
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.tenant_id, 'tenant_A');
  });

  it('⑤b 不同 key 重试（非同一 key）→ 走用例②：ACTIVE 后 409，不接管', async () => {
    const resolver = resolverFor({ tenant_x: 'A' });
    const svc = new AuthService(resolver, config, fixedIdGen('tenant_x', 'user_x'));
    await svc.register(fakeApp(), 'diffkey@example.com', 'password123', { idempotencyKey: 'reg:first' });

    let threw: unknown;
    try {
      await svc.register(fakeApp(), 'diffkey@example.com', 'password123', { idempotencyKey: 'reg:different' });
      assert.fail('不同 key 重复 register 已 ACTIVE → 必须 409');
    } catch (e) { threw = e; }
    assert.equal((threw as { code?: string }).code, ErrorCode.AUTH_EMAIL_EXISTS);
    assert.equal((threw as { statusCode?: number }).statusCode, 409);
  });

  it('⑥ PENDING 他人占（另一 opId）：无匹配 key register → AUTH_REGISTRATION_IN_PROGRESS、不签 token', async () => {
    /* 手插另一 opId 的 PENDING（他人注册进行中）。 */
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_other', userId: 'user_other', operationId: 'reg:other',
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: 'hash_other',
      lookupKind: 'email', lookupValue: 'occupied@example.com', status: 'PENDING', now: NOW,
    }));

    const svc = new AuthService(resolverFor({ tenant_me: 'A' }), config, fixedIdGen('tenant_me', 'user_me'));
    let threw: unknown;
    try {
      await svc.register(fakeApp(), 'occupied@example.com', 'password123', { idempotencyKey: 'reg:mine' });
      assert.fail('他人 PENDING 占位 → 必须抛 AUTH_REGISTRATION_IN_PROGRESS');
    } catch (e) { threw = e; }
    assert.equal((threw as { code?: string }).code, ErrorCode.AUTH_REGISTRATION_IN_PROGRESS);
    assert.equal((threw as { statusCode?: number }).statusCode, 409, 'HTTP 409');
    /* 未在本 shard 建 user、未签 token。 */
    assert.equal(shardUser(shardA, 'user_me'), undefined, '不建本次候选 user');
  });

  it('⑥b PENDING 续做密码所有权：异密码→argon2.verify 失败→拒；同密码→verify 成功→续做、shard user 复用 pending hash', async () => {
    /* 首次 register 中途崩（PENDING、shard 未 COMPLETE、reservation 存首次 argon2 hash）。 */
    const firstHash = await argon2Hash('owner-real-pass');
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_own', userId: 'user_own', operationId: 'reg:leaked',
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: firstHash,
      lookupKind: 'email', lookupValue: 'owner@example.com', status: 'PENDING', now: NOW,
    }));

    /* 攻击者拿泄露的 key=reg:leaked 用**不同密码** → reservedByUs:true（同 opId）但 argon2.verify 失败 → 拒。 */
    const svcAtk = new AuthService(resolverFor({ tenant_own: 'A' }), config, fixedIdGen('tenant_own', 'user_own'));
    let atkThrew: unknown;
    try {
      await svcAtk.register(fakeApp(), 'owner@example.com', 'attacker-guess', { idempotencyKey: 'reg:leaked' });
      assert.fail('异密码续做必须被 argon2.verify 拒');
    } catch (e) { atkThrew = e; }
    assert.equal((atkThrew as { code?: string }).code, ErrorCode.AUTH_REGISTRATION_IN_PROGRESS, '异密码→AUTH_REGISTRATION_IN_PROGRESS');
    assert.equal(shardUser(shardA, 'user_own'), undefined, '异密码续做不建 shard user、不签 token');
    assert.equal(dirRow('owner@example.com')!.status, 'PENDING', '仍 PENDING（未续做）');

    /* 原客户端同 key 同密码重试 → argon2.verify 成功 → 续做、shard user 复用 pending hash（同一稳定值）。 */
    const svcOwner = new AuthService(resolverFor({ tenant_own: 'A' }), config, fixedIdGen('tenant_own', 'user_own'));
    const res = await svcOwner.register(fakeApp(), 'owner@example.com', 'owner-real-pass', { idempotencyKey: 'reg:leaked' });
    assert.equal(res.tenantId, 'tenant_own');
    assert.equal(res.userId, 'user_own');
    assert.ok(res.accessToken, '同密码续做 → 签发');
    const u = shardUser(shardA, 'user_own')!;
    assert.equal(u.password_hash, firstHash, 'shard user 复用 reservation 的 pending hash（同一值，不重算）');
    assert.equal(dirRow('owner@example.com')!.status, 'ACTIVE', '续做后 ACTIVE');
  });

  it('⑦ login 经目录：register 后 login ACTIVE→验密码成功；PENDING 项 login→拒', async () => {
    const resolver = resolverFor({ tenant_l: 'A' });
    const svc = new AuthService(resolver, config, fixedIdGen('tenant_l', 'user_l'));
    await svc.register(fakeApp(), 'login@example.com', 'password123', { idempotencyKey: 'reg:login' });

    const ok = await svc.login(fakeApp(), 'Login@Example.com', 'password123');
    assert.equal(ok.userId, 'user_l');
    assert.equal(ok.tenantId, 'tenant_l');
    assert.ok(ok.accessToken);

    /* 错密码拒。 */
    await assert.rejects(() => svc.login(fakeApp(), 'login@example.com', 'wrong'), /邮箱或密码错误/);

    /* PENDING 项 login → 拒（手插 PENDING email）。 */
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_p', userId: 'user_p', operationId: 'reg:pend',
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: 'h',
      lookupKind: 'email', lookupValue: 'pending@example.com', status: 'PENDING', now: NOW,
    }));
    await assert.rejects(() => svc.login(fakeApp(), 'pending@example.com', 'whatever'), /邮箱或密码错误/, 'PENDING 项 login 拒');
  });

  it('⑧ 老用户兼容：回填 ACTIVE 目录项（大小写混合归一化）+ 对应 shard user → 原大小写 login 成功', async () => {
    /* 模拟 Task 2 回填：目录项 email 归一化小写、user_id=users.id，shard user 存归一化 email。 */
    const legacyHash = await argon2Hash('legacy-pass-123');
    const canon = canonicalizeEmail('OldUser@Example.COM');
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_legacy', userId: 'user_legacy', operationId: 'reg:backfill',
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: canon, status: 'ACTIVE', now: NOW,
    }));
    shardA.prepare<void>(
      'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('user_legacy', canon, legacyHash, 'admin', 'tenant_legacy', NOW, NOW);
    /* 老用户须有 subscription 以供 generateTokenPair 的 subqQueryActivePlan（可无，走 free 默认）。 */

    const svc = new AuthService(resolverFor({ tenant_legacy: 'A' }), config, fixedIdGen('unused', 'unused'));
    /* 用**原大小写** email login → 归一化后命中目录 ACTIVE → 按 entry.userId 取 shard user → 验密码成功。 */
    const res = await svc.login(fakeApp(), 'OldUser@Example.COM', 'legacy-pass-123');
    assert.equal(res.userId, 'user_legacy');
    assert.equal(res.tenantId, 'tenant_legacy');
    assert.ok(res.accessToken, '老用户原大小写 login 成功（不锁死）');
  });

  it('⑨ Stripe 事务外幂等：首次调一次带 idempotencyKey=operationId（tx 未开）；同 key 重试（COMPLETE）→ 不再调', async () => {
    /* stripe.enabled=true 需 secretKey/webhookSecret + server.publicUrl（本测注入 spy，绝不触真 Stripe SDK）。 */
    const stripeCfg = loadConfig({
      server: { publicUrl: 'https://test.example.com' },
      stripe: { enabled: true, secretKey: 'sk_test_dummy', webhookSecret: 'whsec_dummy' },
    });
    const resolver = resolverFor({ tenant_s: 'A' });

    /* spy：记录调用参数 + 调用时 shard 事务是否已开（探针：若 tx 已开，则此刻在 shard 上再 BEGIN 会抛）。 */
    const calls: Array<{ email: string; tenantId: string; idempotencyKey?: string; txWasClosed: boolean }> = [];
    const spy: StripeCustomerCreator = async (_c, email, tenantId, idempotencyKey) => {
      /* 事务外探针：能成功开合一个新事务 ⇒ 调用发生在 shard 事务之外（node:sqlite 平坦 BEGIN 不可嵌套）。 */
      let txWasClosed = true;
      try {
        shardA.transaction(() => { /* 空事务：若外层已 BEGIN 则此处抛 */ });
      } catch { txWasClosed = false; }
      calls.push({ email, tenantId, idempotencyKey, txWasClosed });
      return `cus_${idempotencyKey}`;
    };

    const svc1 = new AuthService(resolver, stripeCfg, fixedIdGen('tenant_s', 'user_s'), { stripeCreateCustomer: spy });
    await svc1.register(fakeApp(), 'stripe@example.com', 'password123', { idempotencyKey: 'reg:stripe' });

    assert.equal(calls.length, 1, '首次 register 调一次 createCustomer');
    assert.equal(calls[0].idempotencyKey, 'reg:stripe', 'idempotencyKey === operationId');
    assert.equal(calls[0].tenantId, 'tenant_s', 'tenantId === canonicalTenantId');
    assert.equal(calls[0].txWasClosed, true, 'createCustomer 在 shard 事务外调用');
    /* subscription 存了 spy 返的 customerId。 */
    const sub = shardA.prepare<{ stripe_customer_id: string }>(
      'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = ?',
    ).get('tenant_s');
    assert.equal(sub!.stripe_customer_id, 'cus_reg:stripe');

    /* 同 key 重试（shard 已 COMPLETE）：ACTIVE 门会先抛 409——但为验「重试不再调 Stripe」，
     * 用一个越过 ACTIVE 门的 svc：先把目录改回 PENDING（模拟并发窗口），reserve 读回同 opId → reservedByUs:true，
     * boot 已 COMPLETE → 跳过 Stripe。 */
    const svc2 = new AuthService(resolver, stripeCfg, fixedIdGen('tenant_s', 'user_s'), { stripeCreateCustomer: spy });
    const dir = (svc2 as unknown as {
      directory: { resolveByEmail: (e: string) => { tenantId: string; status: string; userId: string | null } | null };
    }).directory;
    let rc = 0;
    dir.resolveByEmail = () => {
      rc++;
      return rc === 1
        ? { tenantId: 'tenant_s', status: 'PENDING', userId: 'user_s' }  /* 越过①门 */
        : { tenantId: 'tenant_s', status: 'ACTIVE', userId: 'user_s' };  /* ⑥门收敛 */
    };
    await svc2.register(fakeApp(), 'stripe@example.com', 'password123', { idempotencyKey: 'reg:stripe' });
    assert.equal(calls.length, 1, '同 key 重试（shard COMPLETE）→ 不再调 Stripe');
  });
});
