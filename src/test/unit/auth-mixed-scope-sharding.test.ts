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
import { createHash } from 'node:crypto';
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
import { SsoUserService } from '../../identity/sso-user-service.js';
import type { IdGenerator as SsoIdGenerator } from '../../identity/sso-user-service.js';
import { ScimProvisioningService } from '../../enterprise/scim-provisioning-service.js';
import { ApiKeyService } from '../../billing/api-key-service.js';
import { TenantIdentityDirectory } from '../../identity/tenant-identity-directory.js';
import { UserEmailDirectoryService } from '../../identity/user-email-directory-service.js';
import { TenantReservationRecovery } from '../../identity/tenant-reservation-recovery.js';
import { SilentLogger } from '../../utils/logger.js';
import { registerAuth } from '../../server/plugins/auth.js';
import { canonicalizeEmail } from '../../identity/email-canonical.js';
import { loadConfig } from '../../config/schema.js';
import { dirCmdReserve, DIR_CMD_DELETE_BY_LOOKUP } from '@chrono/kernel';
import { ErrorCode } from '../../errors/index.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

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

  it('⑥c 密码 register 撞遗留 passwordless PENDING（pending_password_hash=NULL）→ AUTH_REGISTRATION_IN_PROGRESS(409) 而非 500/内部消息', async () => {
    /* 崩溃遗留：SSO/SCIM 的 reservePasswordlessTenant 写过一条 PENDING（pending_password_hash=NULL），
     * shard 提交前崩溃。此后一个**密码 register**（不同 operationId）撞同 email。 */
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_sso', userId: 'user_sso', operationId: 'reg:sso_leftover',
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: 'collide@example.com', status: 'PENDING', now: NOW,
    }));

    const svc = new AuthService(resolverFor({ tenant_me: 'A' }), config, fixedIdGen('tenant_me', 'user_me'));
    let threw: unknown;
    try {
      await svc.register(fakeApp(), 'collide@example.com', 'password123', { idempotencyKey: 'reg:mine' });
      assert.fail('撞 passwordless 遗留 PENDING → 必须抛 AUTH_REGISTRATION_IN_PROGRESS，不得 500');
    } catch (e) { threw = e; }
    /* 修前：reserveTenant 的 requireHash(NULL) 抛 StorageError(STORAGE_READ,500,泄露 email 的内部消息)；
     * 修后：reservedByUs:false 分支提前 return → AUTH_REGISTRATION_IN_PROGRESS(409)。 */
    assert.equal((threw as { code?: string }).code, ErrorCode.AUTH_REGISTRATION_IN_PROGRESS, '409 而非 STORAGE_READ');
    assert.equal((threw as { statusCode?: number }).statusCode, 409, 'HTTP 409（非 500）');
    assert.equal(
      /pending_password_hash|目录项缺少/.test((threw as { message?: string }).message ?? ''),
      false,
      '不泄露内部 requireHash 错误消息',
    );
    /* fail-closed：未接管遗留 tenant、未在本 shard 建 user、未签 token。 */
    assert.equal(shardUser(shardA, 'user_me'), undefined, '不建本次候选 user');
    assert.equal(dirRow('collide@example.com')!.tenant_id, 'tenant_sso', '遗留 tenant 未被接管/覆盖');
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

/**
 * 租户分片 Phase 0 · Plan 1c Task 6 —— SSO/OIDC + SCIM createUser 经协调库目录定位 email→tenant。
 *
 * 用 FakeMultiShardResolver（独立 coordinator + 2 独立 shard db）钉死：
 *   - findOrCreateForSso（自生成 tenant）：走 reservePasswordlessTenant → coordinator email ACTIVE +
 *     正确 shard 有 user；注确定性 idGen 验 canonical 身份落对 shard；
 *   - findOrCreateForOidc(email, expectedTenantId)：目录 email 已属**其他** tenant → 抛 AUTH_SSO_FAILED
 *     （从协调库目录判定，非某 shard users 查）；一致则 dbForTenant(expectedTenantId) 建/取；
 *   - SCIM createUser(tenantId, {email})：email 属其他 tenant → 抛「已存在于其他 tenant」；新 email →
 *     coordinator ACTIVE + tenantId 对应 shard 有 user；
 *   - 大小写归一化（回归 v124 锁死类）：SSO/SCIM 用大小写混合 email → canonicalize 后正确定位。
 */
describe('SSO/OIDC + SCIM createUser 混合 scope 分片（经协调库目录定位）', () => {
  let coordinator: IDatabase;
  let shardA: IDatabase;
  let shardB: IDatabase;

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

  function resolverFor(tenantToShard: Record<string, string>): FakeMultiShardResolver {
    return new FakeMultiShardResolver({
      coordinator,
      shards: { A: shardA, B: shardB },
      tenantToShard,
    });
  }

  /** 确定性 idGen（SSO seam）：按预设序列吐 tenant/user id。 */
  function ssoIdGen(tenantId: string, userId: string): SsoIdGenerator {
    return { tenantId: () => tenantId, userId: () => userId };
  }

  function dirRow(email: string): { tenant_id: string; status: string } | undefined {
    return coordinator.prepare<{ tenant_id: string; status: string }>(
      'SELECT tenant_id, status FROM tenant_identity_directory WHERE lookup_kind = ? AND lookup_value = ?',
    ).get('email', canonicalizeEmail(email));
  }

  function shardUser(db: IDatabase, userId: string): { id: string; email: string; tenant_id: string; role: string } | undefined {
    return db.prepare<{ id: string; email: string; tenant_id: string; role: string }>(
      'SELECT id, email, tenant_id, role FROM users WHERE id = ?',
    ).get(userId);
  }

  it('findOrCreateForSso（自生成 tenant）→ reservePasswordlessTenant → coordinator ACTIVE + 正确 shard 有 user；确定性 idGen 落对 shard', () => {
    const svc = new SsoUserService(resolverFor({ tenant_sso: 'A' }), ssoIdGen('tenant_sso', 'user_sso'));
    const res = svc.findOrCreateForSso('SsoNew@Example.com');

    assert.equal(res.isNew, true);
    assert.equal(res.tenantId, 'tenant_sso');
    assert.equal(res.userId, 'user_sso');
    assert.equal(res.role, 'admin', '自生成 tenant 首用户为 admin');

    /* coordinator email 目录 ACTIVE（归一化小写）。 */
    assert.equal(dirRow('ssonew@example.com')!.status, 'ACTIVE');
    /* shard A 有 user（email 归一化小写、tenant 绑定）。 */
    const u = shardUser(shardA, 'user_sso');
    assert.ok(u, 'shard A 有 user 行');
    assert.equal(u!.email, 'ssonew@example.com', 'shard user email 归一化小写');
    assert.equal(u!.tenant_id, 'tenant_sso');
    /* shard B 无该 user。 */
    assert.equal(shardUser(shardB, 'user_sso'), undefined, '他 shard 无 user 行');
    /* 订阅落 shard A。 */
    assert.ok(shardA.prepare('SELECT 1 FROM subscriptions WHERE tenant_id = ?').get('tenant_sso'), '订阅落用户所在 shard');
  });

  it('findOrCreateForSso 已 ACTIVE email → 走既有用户路径（isNew=false，同 tenant/user，不重建第二租户）', () => {
    const resolver = resolverFor({ tenant_ret: 'A' });
    const svc = new SsoUserService(resolver, ssoIdGen('tenant_ret', 'user_ret'));
    const first = svc.findOrCreateForSso('returning@example.com');
    assert.equal(first.isNew, true);

    /* 再调（若 idGen 换值，canonical 仍以目录既存为准 → 复用第一次身份）。 */
    const svc2 = new SsoUserService(resolver, ssoIdGen('tenant_other', 'user_other'));
    const second = svc2.findOrCreateForSso('Returning@Example.com');
    assert.equal(second.isNew, false, '已 ACTIVE → 既有用户路径');
    assert.equal(second.userId, 'user_ret');
    assert.equal(second.tenantId, 'tenant_ret');
    assert.equal(shardUser(shardA, 'user_other'), undefined, '不重建第二租户/用户');
  });

  it('findOrCreateForOidc(email, expectedTenantId)：目录 email 已属其他 tenant → 抛 AUTH_SSO_FAILED（从协调库目录判定）', () => {
    /* 先用 SSO 让 cross@ 落 tenant_a（目录 ACTIVE，绑 tenant_a）。 */
    const svcA = new SsoUserService(resolverFor({ tenant_a: 'A' }), ssoIdGen('tenant_a', 'user_a'));
    svcA.findOrCreateForSso('cross@example.com');
    assert.equal(dirRow('cross@example.com')!.tenant_id, 'tenant_a');

    /* OIDC 以 expectedTenantId=tenant_b 尝试同 email → 目录判定属 tenant_a → 抛 AUTH_SSO_FAILED。 */
    const svcOidc = new SsoUserService(resolverFor({ tenant_a: 'A', tenant_b: 'B' }), ssoIdGen('tenant_b', 'user_b'));
    let threw: unknown;
    try {
      svcOidc.findOrCreateForOidc('cross@example.com', 'tenant_b');
      assert.fail('email 属其他 tenant 必须抛 AUTH_SSO_FAILED');
    } catch (e) { threw = e; }
    assert.equal((threw as { code?: string }).code, ErrorCode.AUTH_SSO_FAILED);
    /* 不在 tenant_b 的 shard B 建 user（跨租户拒后无落地）。 */
    assert.equal(shardUser(shardB, 'user_b'), undefined, '跨租户拒 → 不建 user');
  });

  it('findOrCreateForOidc 一致 tenant → dbForTenant(expectedTenantId) 建/取（新建 admin，已存在 isNew=false）', () => {
    const resolver = resolverFor({ tenant_oidc: 'A' });
    const svc1 = new SsoUserService(resolver, ssoIdGen('tenant_oidc', 'user_oidc1'));
    /* 首次 OIDC：expectedTenantId=tenant_oidc，全新 email → 建 admin + 落 shard A。 */
    const r1 = svc1.findOrCreateForOidc('oidc-first@example.com', 'tenant_oidc', 'First');
    assert.equal(r1.isNew, true);
    assert.equal(r1.role, 'admin');
    assert.equal(r1.tenantId, 'tenant_oidc');
    assert.equal(dirRow('oidc-first@example.com')!.status, 'ACTIVE');
    const u = shardUser(shardA, 'user_oidc1')!;
    assert.equal(u.tenant_id, 'tenant_oidc');
    /* displayName 落 identity。 */
    const ident = shardA.prepare<{ display_name: string }>(
      'SELECT display_name FROM identities WHERE user_id = ?',
    ).get('user_oidc1');
    assert.equal(ident?.display_name, 'First');

    /* 再次 OIDC 同 email 同 tenant → isNew=false，复用既有 user。 */
    const svc2 = new SsoUserService(resolver, ssoIdGen('tenant_oidc', 'user_oidc2'));
    const r2 = svc2.findOrCreateForOidc('oidc-first@example.com', 'tenant_oidc');
    assert.equal(r2.isNew, false);
    assert.equal(r2.userId, 'user_oidc1');
    assert.equal(shardUser(shardA, 'user_oidc2'), undefined, '不重建第二 user');
  });

  it('SCIM createUser(tenantId, {email})：email 属其他 tenant → 抛「已存在于其他 tenant」', () => {
    /* 先让 taken@ 落 tenant_x（经 SSO）。 */
    const svcSso = new SsoUserService(resolverFor({ tenant_x: 'A' }), ssoIdGen('tenant_x', 'user_x'));
    svcSso.findOrCreateForSso('taken@example.com');

    const scim = new ScimProvisioningService(resolverFor({ tenant_x: 'A', tenant_y: 'B' }));
    let threw: unknown;
    try {
      scim.createUser('tenant_y', { email: 'taken@example.com', displayName: 'Taken' });
      assert.fail('email 属其他 tenant 必须抛');
    } catch (e) { threw = e; }
    assert.ok(String((threw as Error).message).includes('已存在于其他 tenant'), '抛跨租户冲突错误');
    assert.equal(shardUser(shardB, 'user_x'), undefined, '不在 tenant_y shard 建 user');
  });

  it('SCIM createUser 新 email → coordinator ACTIVE + tenantId 对应 shard 有 user（isNew=true）', () => {
    const scim = new ScimProvisioningService(resolverFor({ tenant_scim: 'A' }));
    const res = scim.createUser('tenant_scim', { email: 'ScimUser@Example.com', displayName: 'Scim User' });

    assert.equal(res.isNew, true);
    assert.equal(res.user.userName, 'scimuser@example.com', 'SCIM userName=归一化 email');

    /* coordinator email 目录 ACTIVE。 */
    assert.equal(dirRow('scimuser@example.com')!.status, 'ACTIVE');
    /* tenant_scim 映射的 shard A 有 user（email 归一化小写）。 */
    const rows = shardA.prepare<{ id: string; email: string; tenant_id: string }>(
      'SELECT id, email, tenant_id FROM users WHERE tenant_id = ?',
    ).all('tenant_scim');
    assert.equal(rows.length, 1, 'shard A 有 1 个 user');
    assert.equal(rows[0].email, 'scimuser@example.com');
    /* shard B 无。 */
    assert.equal(
      shardB.prepare('SELECT 1 FROM users WHERE tenant_id = ?').get('tenant_scim'),
      undefined,
      '他 shard 无 user',
    );
    /* identity 落 shard A。 */
    assert.ok(
      shardA.prepare('SELECT 1 FROM identities WHERE user_id = ?').get(rows[0].id),
      'identity 落用户所在 shard',
    );
  });

  it('SCIM createUser 幂等：同 email 再导入 → isNew=false，复用既有 user（不重建）', () => {
    const scim = new ScimProvisioningService(resolverFor({ tenant_idem: 'A' }));
    const r1 = scim.createUser('tenant_idem', { email: 'idem@example.com', displayName: 'Idem' });
    const r2 = scim.createUser('tenant_idem', { email: 'IDEM@example.com', displayName: 'Idem2' });
    assert.equal(r2.isNew, false, '既有 email → isNew=false');
    assert.equal(r2.user.id, r1.user.id, '复用既有 user id');
    const cnt = shardA.prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?',
    ).get('tenant_idem');
    assert.equal(Number(cnt!.c), 1, '不重建 user');
  });

  it('PENDING 目录项（崩溃窗口：shard 无 user）→ findOrCreateForOidc / findOrCreateForSso 均抛 AUTH_SSO_FAILED、不返回 {userId,role}、不签 token（防幽灵用户越权）', () => {
    /* 模拟 SSO 崩在 reservePasswordlessTenant(PENDING) 之后、shard 写 user 提交之前：目录留 PENDING，
     * shard 无 user 行。手插一个 PENDING email 目录项（无对应 shard user）。 */
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_ghost', userId: 'user_ghost', operationId: 'reg:ghost',
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: 'ghost@example.com', status: 'PENDING', now: NOW,
    }));
    /* 前置断言：shard 确无 user（崩溃窗口）。 */
    assert.equal(shardUser(shardA, 'user_ghost'), undefined, '崩溃窗口：shard 无 user 行');

    /* OIDC：进 if(entry) 既有用户分支前须被 ACTIVE 门拒——绝不落到 existingUserRole 兜底 member + 签 token。 */
    const svcOidc = new SsoUserService(resolverFor({ tenant_ghost: 'A' }), ssoIdGen('tenant_ghost', 'user_ghost'));
    let oidcThrew: unknown;
    try {
      const r = svcOidc.findOrCreateForOidc('ghost@example.com', 'tenant_ghost');
      assert.fail(`PENDING 项 OIDC 必须抛错，绝不返回 ${JSON.stringify(r)} + 签 token`);
    } catch (e) { oidcThrew = e; }
    assert.equal((oidcThrew as { code?: string }).code, ErrorCode.AUTH_SSO_FAILED, 'OIDC PENDING → AUTH_SSO_FAILED');

    /* SSO：同样被 ACTIVE 门拒。 */
    const svcSso = new SsoUserService(resolverFor({ tenant_ghost: 'A' }), ssoIdGen('tenant_ghost', 'user_ghost'));
    let ssoThrew: unknown;
    try {
      const r = svcSso.findOrCreateForSso('ghost@example.com');
      assert.fail(`PENDING 项 SSO 必须抛错，绝不返回 ${JSON.stringify(r)} + 签 token`);
    } catch (e) { ssoThrew = e; }
    assert.equal((ssoThrew as { code?: string }).code, ErrorCode.AUTH_SSO_FAILED, 'SSO PENDING → AUTH_SSO_FAILED');

    /* 目录仍 PENDING、shard 仍无 user（拒后无任何落地——交由 Task 8 恢复 worker 收敛）。 */
    assert.equal(dirRow('ghost@example.com')!.status, 'PENDING', '拒后目录仍 PENDING');
    assert.equal(shardUser(shardA, 'user_ghost'), undefined, '拒后 shard 仍无 user');
  });

  it('纵深防御：ACTIVE 目录项但 shard user 意外缺失（目录/shard 漂移）→ existingUserRole fail-closed 抛 AUTH_SSO_FAILED（不兜底 member 签幽灵）', () => {
    /* 目录项 ACTIVE 且绑 user_drift，但 shard 无对应 user 行（数据完整性违规 / 漂移）。 */
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_drift', userId: 'user_drift', operationId: 'reg:drift',
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: 'drift@example.com', status: 'ACTIVE', now: NOW,
    }));
    assert.equal(shardUser(shardA, 'user_drift'), undefined, '漂移：ACTIVE 目录但 shard 无 user');

    /* OIDC 既有用户路径：ensureSubscription / ensureForUser 会先跑（幂等），但 existingUserRole 查不到
     * shard user → fail-closed 抛错，绝不返回 role='member'。 */
    const svcOidc = new SsoUserService(resolverFor({ tenant_drift: 'A' }), ssoIdGen('tenant_drift', 'user_drift'));
    let oidcThrew: unknown;
    try {
      svcOidc.findOrCreateForOidc('drift@example.com', 'tenant_drift');
      assert.fail('漂移（ACTIVE 目录 + shard 无 user）OIDC 必须 fail-closed 抛错');
    } catch (e) { oidcThrew = e; }
    assert.equal((oidcThrew as { code?: string }).code, ErrorCode.AUTH_SSO_FAILED, 'OIDC 漂移 → AUTH_SSO_FAILED');

    /* SSO 亦然。 */
    const svcSso = new SsoUserService(resolverFor({ tenant_drift: 'A' }), ssoIdGen('tenant_drift', 'user_drift'));
    let ssoThrew: unknown;
    try {
      svcSso.findOrCreateForSso('drift@example.com');
      assert.fail('漂移 SSO 必须 fail-closed 抛错');
    } catch (e) { ssoThrew = e; }
    assert.equal((ssoThrew as { code?: string }).code, ErrorCode.AUTH_SSO_FAILED, 'SSO 漂移 → AUTH_SSO_FAILED');
  });

  it('大小写归一化（回归 v124 锁死类）：老用户回填 ACTIVE 目录项（归一化）+ shard user → SSO 原大小写 email 正确定位', () => {
    /* 模拟 Task 2 回填：目录项 email 归一化小写，shard user 存归一化 email。 */
    const canon = canonicalizeEmail('Legacy.SSO@Example.COM');
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_legacy_sso', userId: 'user_legacy_sso', operationId: 'reg:backfill-sso',
      operationKind: 'REGISTER', previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: canon, status: 'ACTIVE', now: NOW,
    }));
    shardA.prepare<void>(
      'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('user_legacy_sso', canon, 'sso-managed', 'admin', 'tenant_legacy_sso', NOW, NOW);

    /* SSO 用**原大小写** email → 归一化后命中目录 ACTIVE → 既有用户路径（不锁死、不重建）。 */
    const svc = new SsoUserService(resolverFor({ tenant_legacy_sso: 'A' }), ssoIdGen('unused', 'unused'));
    const res = svc.findOrCreateForSso('Legacy.SSO@Example.COM');
    assert.equal(res.isNew, false, '大小写混合 email 归一化后命中既有 → 不重建');
    assert.equal(res.userId, 'user_legacy_sso');
    assert.equal(res.tenantId, 'tenant_legacy_sso');

    /* SCIM 亦然：同 tenant 用原大小写导入 → isNew=false（归一化定位既有）。 */
    const scim = new ScimProvisioningService(resolverFor({ tenant_legacy_sso: 'A' }));
    const scimRes = scim.createUser('tenant_legacy_sso', { email: 'LEGACY.sso@example.com', displayName: 'Legacy' });
    assert.equal(scimRes.isNew, false, 'SCIM 大小写混合 email 归一化后命中既有 → 不重建');
    assert.equal(scimRes.user.id, 'user_legacy_sso');
  });
});

/**
 * 租户分片 Phase 0 · Plan 1c Task 7 —— refresh_token + api_key hash → tenant **目录反查**
 * （目录=定位器，shard is_revoked=权威）的混合 scope 分片行为验证。
 *
 * 核心不变式：目录项只回答「token/key hash 属哪个 tenant」；有效性（is_revoked）永远以 shard 内行为
 * 权威真源。目录多余/过期项只导致「定位到 shard 后被拒」（安全），绝不越权。
 *
 * 用 FakeMultiShardResolver（独立 coordinator + 2 独立 shard db）钉死：
 *   R1 refresh 跨 shard：签发 refresh token → 目录有 token_hash→tenant ACTIVE → refresh 经
 *      resolveByRefreshTokenHash 得 tenantId → dbForTenant 查 token（token 属 s1，从 coordinator
 *      反查得 s1 不误查 s0）→ is_revoked=0 → 发新（且新 token 目录 ACTIVE、旧 token shard revoked + 目录清）。
 *   R2 目录=定位器权威在 shard：手动留目录项但 shard 内 is_revoked=1 → refresh 拒（证 shard 权威，
 *      目录多余项不越权）。
 *   R3 目录无该 hash → refresh 拒（INVALID，不静默兜底其他库）。
 *   R4 logout：清 shard token（revoked）+ 清目录项 → 后续 refresh 拒。
 *   K1 api-key create → 目录 ACTIVE → preHandler resolveByApiKeyHash → dbForTenant 验 is_revoked=0；
 *      跨 shard（key 属 s1，coordinator 反查得 s1）。
 *   K2 revoke(id, tenantId)：先取 hash → shard is_revoked=1 → 目录 removeLookup → 后续 resolve 返 null
 *      且 preHandler 认证失败（静默 401/403，不 500）。
 *   K3 api-key create 时 recordActiveLookup 写失败（他租户已占同 hash）→ 抛错、不吞、不返回 key。
 */
describe('AuthService/ApiKey 混合 scope 分片（Task 7：refresh + api_key hash→tenant 目录定位/shard 权威）', () => {
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

  function resolverFor(tenantToShard: Record<string, string>): FakeMultiShardResolver {
    return new FakeMultiShardResolver({
      coordinator,
      shards: { A: shardA, B: shardB },
      tenantToShard,
    });
  }

  /** sha256(token) —— 与 auth-service / plugins/auth 存储格式一致。 */
  function sha256(v: string): string {
    return createHash('sha256').update(v).digest('hex');
  }

  /** 直查协调库某 lookup_kind 的目录项。 */
  function lookupRow(lookupKind: string, lookupValue: string): { tenant_id: string; status: string } | undefined {
    return coordinator.prepare<{ tenant_id: string; status: string }>(
      'SELECT tenant_id, status FROM tenant_identity_directory WHERE lookup_kind = ? AND lookup_value = ?',
    ).get(lookupKind, lookupValue);
  }

  /** 直查某 shard 的 refresh_token 行（含 is_revoked）。 */
  function tokenRow(db: IDatabase, tokenHash: string): { user_id: string; is_revoked: number } | undefined {
    return db.prepare<{ user_id: string; is_revoked: number }>(
      'SELECT user_id, is_revoked FROM refresh_tokens WHERE token_hash = ?',
    ).get(tokenHash);
  }

  /**
   * 捕获 registerAuth 注册的 onRequest hook，返回可驱动的 preHandler。
   * fake app 只实现 addHook；请求驱动器返回 { user, statusCode, sent }。
   */
  function captureAuthHook(resolver: FakeMultiShardResolver): (apiKey: string) => {
    user?: { tenantId: string; planId: string; sub: string };
    statusCode?: number;
  } {
    let hook: ((req: FastifyRequest, reply: FastifyReply, done: () => void) => unknown) | undefined;
    const fakeApp = {
      addHook: (_name: string, fn: unknown) => { hook = fn as typeof hook; },
      log: { warn: () => { /* noop */ } },
    } as unknown as Parameters<typeof registerAuth>[0];
    /* auth.enabled 须显式开（loadConfig 默认 false 会 early-return 不注册 hook）；无静态 key，仅 DB Key 路径。 */
    const authOnConfig = loadConfig({ auth: { enabled: true, apiKeys: [], metricsApiKeys: [], requireDbKeys: false } });
    registerAuth(fakeApp, authOnConfig, resolver);
    if (!hook) throw new Error('registerAuth 未注册 onRequest hook');

    return (apiKey: string) => {
      let statusCode: number | undefined;
      const req = {
        url: '/api/v1/personas',
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        query: {},
      } as unknown as FastifyRequest & { user?: { tenantId: string; planId: string; sub: string } };
      const reply = {
        status: (code: number) => { statusCode = code; return { send: () => reply }; },
      } as unknown as FastifyReply;
      let doneCalled = false;
      hook!(req, reply, () => { doneCalled = true; });
      return { user: req.user, statusCode: doneCalled ? statusCode : statusCode };
    };
  }

  it('R1 refresh 跨 shard：token 属 s(A)，经 resolveByRefreshTokenHash 反查得 tenant→dbForTenant 查 s(A) 验 is_revoked=0→发新（新 token 目录 ACTIVE、旧 token shard revoked+目录清）', async () => {
    const resolver = resolverFor({ tenant_1: 'A', tenant_other: 'B' });
    const svc = new AuthService(resolver, config, fixedIdGen('tenant_1', 'user_1'));
    const reg = await svc.register(fakeApp(), 'r1@example.com', 'password123', { idempotencyKey: 'reg:r1' });
    const oldHash = sha256(reg.refreshToken);

    /* 签发后：目录有该 refresh_token_hash→tenant_1 ACTIVE；token 行落 shard A（用户 shard）。 */
    assert.equal(lookupRow('refresh_token_hash', oldHash)!.tenant_id, 'tenant_1', '目录记录 token_hash→tenant_1');
    assert.equal(lookupRow('refresh_token_hash', oldHash)!.status, 'ACTIVE');
    assert.ok(tokenRow(shardA, oldHash), 'refresh token 落 shard A');
    assert.equal(tokenRow(shardB, oldHash), undefined, 'token 不在 shard B');

    /* refresh：经目录反查得 tenant_1 → dbForTenant(A) → 验 is_revoked=0 → 发新。 */
    const refreshed = await svc.refresh(fakeApp(), reg.refreshToken);
    assert.ok(refreshed.accessToken && refreshed.refreshToken, '发新 token 对');
    assert.notEqual(refreshed.refreshToken, reg.refreshToken, '轮转出新 refresh token');

    /* 旧 token：shard A 内 is_revoked=1（轮转标撤销）+ 目录项已清。 */
    assert.equal(tokenRow(shardA, oldHash)!.is_revoked, 1, '旧 token shard 内 revoked');
    assert.equal(lookupRow('refresh_token_hash', oldHash), undefined, '旧 token 目录项已清');

    /* 新 token：目录 ACTIVE→tenant_1 + 落 shard A。 */
    const newHash = sha256(refreshed.refreshToken);
    assert.equal(lookupRow('refresh_token_hash', newHash)!.tenant_id, 'tenant_1', '新 token 目录 ACTIVE→tenant_1');
    assert.ok(tokenRow(shardA, newHash), '新 token 落 shard A');
  });

  it('R2 目录=定位器权威在 shard：手留目录项但 shard 内 is_revoked=1 → refresh 拒（shard 权威，目录多余项不越权）', async () => {
    const resolver = resolverFor({ tenant_2: 'A' });
    const svc = new AuthService(resolver, config, fixedIdGen('tenant_2', 'user_2'));
    const reg = await svc.register(fakeApp(), 'r2@example.com', 'password123', { idempotencyKey: 'reg:r2' });
    const h = sha256(reg.refreshToken);

    /* 手动在 shard A 把 token 标 revoked（模拟 logout/轮转已撤销），但目录项**仍留着**（多余项）。 */
    shardA.prepare<void>('UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?').run(h);
    assert.equal(lookupRow('refresh_token_hash', h)!.status, 'ACTIVE', '目录项仍留着（多余）');

    /* refresh：目录定位到 tenant_2，但 shard 内 is_revoked=1 → 拒（证 shard 权威）。 */
    await assert.rejects(
      () => svc.refresh(fakeApp(), reg.refreshToken),
      (e: unknown) => (e as { code?: string }).code === ErrorCode.AUTH_EXPIRED
        || (e as { code?: string }).code === ErrorCode.AUTH_INVALID_TOKEN,
      '目录留项但 shard revoked → refresh 拒（shard 权威）',
    );
  });

  it('R3 目录无该 hash → refresh 拒（INVALID，不静默兜底其他库）', async () => {
    const resolver = resolverFor({ tenant_3: 'A' });
    const svc = new AuthService(resolver, config, fixedIdGen('tenant_3', 'user_3'));
    await assert.rejects(
      () => svc.refresh(fakeApp(), 'never-issued-token'),
      (e: unknown) => (e as { code?: string }).code === ErrorCode.AUTH_EXPIRED
        || (e as { code?: string }).code === ErrorCode.AUTH_INVALID_TOKEN,
      '目录无该 token_hash → 拒',
    );
  });

  it('R4 logout：清 shard token（revoked）+ 清目录项 → 后续 refresh 拒', async () => {
    const resolver = resolverFor({ tenant_4: 'A' });
    const svc = new AuthService(resolver, config, fixedIdGen('tenant_4', 'user_4'));
    const reg = await svc.register(fakeApp(), 'r4@example.com', 'password123', { idempotencyKey: 'reg:r4' });
    const h = sha256(reg.refreshToken);

    svc.logout(reg.refreshToken, undefined);

    assert.equal(tokenRow(shardA, h)!.is_revoked, 1, 'logout 标 shard token revoked');
    assert.equal(lookupRow('refresh_token_hash', h), undefined, 'logout 清目录项');
    await assert.rejects(() => svc.refresh(fakeApp(), reg.refreshToken), 'logout 后 refresh 拒');
  });

  it('K1 api-key create → 目录 ACTIVE → preHandler resolveByApiKeyHash → dbForTenant 验 is_revoked=0（跨 shard：key 属 A）', async () => {
    const resolver = resolverFor({ tenant_k1: 'A', tenant_kb: 'B' });
    /* 先给 tenant_k1 建 subscription（free），再 create key。 */
    shardA.prepare<void>(
      `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, NULL, 'free', 'active', ?, ?, ?, ?)`,
    ).run('sub_k1', 'tenant_k1', NOW, NOW + 1, NOW, NOW);
    const svc = new ApiKeyService(resolver);
    const outcome = svc.create('tenant_k1', 'free');
    assert.ok(outcome.ok, 'create key 成功');
    const apiKey = outcome.ok ? outcome.data.apiKey : '';
    const keyHash = sha256(apiKey);

    /* 目录记录 api_key_hash→tenant_k1 ACTIVE；key 行落 shard A（不在 B）。 */
    assert.equal(lookupRow('api_key_hash', keyHash)!.tenant_id, 'tenant_k1', '目录记录 key_hash→tenant_k1');
    assert.ok(shardA.prepare('SELECT 1 FROM api_keys WHERE key_hash = ?').get(keyHash), 'key 落 shard A');
    assert.equal(shardB.prepare('SELECT 1 FROM api_keys WHERE key_hash = ?').get(keyHash), undefined, 'key 不在 shard B');

    /* preHandler：resolveByApiKeyHash 得 tenant_k1 → dbForTenant(A) 验 is_revoked=0 → 注入 user（tenantId=tenant_k1）。 */
    const drive = captureAuthHook(resolver);
    const res = drive(apiKey);
    assert.equal(res.statusCode, undefined, 'valid key 认证通过（不拒）');
    assert.equal(res.user?.tenantId, 'tenant_k1', 'preHandler 注入正确 tenant（经目录跨 shard 定位）');
  });

  it('K2 revoke(id, tenantId)：先取 hash→shard is_revoked=1→removeLookup 清目录→后续 preHandler 认证失败（静默，不 500）', async () => {
    const resolver = resolverFor({ tenant_k2: 'A' });
    shardA.prepare<void>(
      `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, NULL, 'free', 'active', ?, ?, ?, ?)`,
    ).run('sub_k2', 'tenant_k2', NOW, NOW + 1, NOW, NOW);
    const svc = new ApiKeyService(resolver);
    const outcome = svc.create('tenant_k2', 'free');
    assert.ok(outcome.ok);
    const { apiKey, id } = outcome.ok ? outcome.data : { apiKey: '', id: '' };
    const keyHash = sha256(apiKey);

    /* revoke：先取 hash → shard is_revoked=1 → 目录 removeLookup。 */
    assert.equal(svc.revoke(id, 'tenant_k2'), true, 'revoke 生效');
    assert.equal(
      shardA.prepare<{ is_revoked: number }>('SELECT is_revoked FROM api_keys WHERE id = ?').get(id)!.is_revoked,
      1,
      'shard is_revoked=1',
    );
    assert.equal(lookupRow('api_key_hash', keyHash), undefined, 'revoke 清目录项（removeLookup）');

    /* 后续 preHandler：resolve 返 null（目录已清）→ 认证失败（静默 401/403，绝不 500）。 */
    const drive = captureAuthHook(resolver);
    const res = drive(apiKey);
    assert.equal(res.user, undefined, 'revoked key 不注入 user');
    assert.ok(res.statusCode === 401 || res.statusCode === 403, 'revoked key 静默认证失败（非 500）');
  });

  it('K2b 目录=定位器权威在 shard（api-key）：手留目录项但 shard is_revoked=1 → preHandler 认证失败（shard 权威）', async () => {
    const resolver = resolverFor({ tenant_k2b: 'A' });
    shardA.prepare<void>(
      `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, NULL, 'free', 'active', ?, ?, ?, ?)`,
    ).run('sub_k2b', 'tenant_k2b', NOW, NOW + 1, NOW, NOW);
    const svc = new ApiKeyService(resolver);
    const outcome = svc.create('tenant_k2b', 'free');
    assert.ok(outcome.ok);
    const { apiKey, id } = outcome.ok ? outcome.data : { apiKey: '', id: '' };
    const keyHash = sha256(apiKey);

    /* 手动只在 shard 标 revoked，目录项仍留（多余项）。 */
    shardA.prepare<void>('UPDATE api_keys SET is_revoked = 1 WHERE id = ?').run(id);
    assert.ok(lookupRow('api_key_hash', keyHash), '目录项仍留（多余）');

    const drive = captureAuthHook(resolver);
    const res = drive(apiKey);
    assert.equal(res.user, undefined, '目录留项但 shard revoked → 不注入 user（shard 权威）');
    assert.ok(res.statusCode === 401 || res.statusCode === 403, '认证失败（shard 权威，目录多余不越权）');
  });

  it('K3 create 时 recordActiveLookup 写失败（他租户已占同 hash）→ 抛错、不吞（recordActiveLookup 保证目录 locator 写成功才发凭据）', async () => {
    /* 构造：先让 tenant_occupied 占据某 api_key_hash 的目录项。因 apiKey 随机，直接测门面语义：
     * 手动占位一个 api_key_hash → 其他租户 recordActiveLookup 同 hash 必抛。 */
    const resolver = resolverFor({ tenant_a: 'A', tenant_b: 'B' });
    const dir = new TenantIdentityDirectory(resolver);
    const stolenHash = sha256('shared-key-material');
    dir.recordActiveLookup({ tenantId: 'tenant_a', lookupKind: 'api_key_hash', lookupValue: stolenHash });

    /* tenant_b 尝试记录同 hash → 读回校验属 tenant_a → 抛（拒发凭据，不越权）。 */
    assert.throws(
      () => dir.recordActiveLookup({ tenantId: 'tenant_b', lookupKind: 'api_key_hash', lookupValue: stolenHash }),
      (e: unknown) => (e as { code?: string }).code === ErrorCode.STATE_ALREADY_EXISTS,
      '目录键已映射他租户 → recordActiveLookup 抛（不吞，签发失败）',
    );
    /* 目录仍属 tenant_a（未被 b 覆盖）。 */
    assert.equal(lookupRow('api_key_hash', stolenHash)!.tenant_id, 'tenant_a', '目录未被越权覆盖');
  });
});

/**
 * 租户分片 Phase 0 · Plan 1c Task 9 —— `UserEmailDirectoryService.updateEmail` 跨库可恢复状态机
 * （coordinator 目录 changeEmail trio + shard users.email 写，非原子）的**混合 scope 分片**行为验证。
 *
 * updateEmail(tenantId, userId, newEmail) 走 Task 4 的 reserveEmailChange → shard UPDATE →
 * completeEmailChange 三方法状态机；oldEmail 从 shard user（权威）读，operationId 确定性派生（同参重试
 * 幂等复用同一 reservation）。用 `FakeMultiShardResolver`（独立 coordinator + 2 独立 shard）钉死：
 *
 *   ① 改 email 成功：新 email login 通、旧 email 拒；shard users.email 已改；coordinator 新 ACTIVE、旧删。
 *   ② **跨库崩溃窗口不锁死（Codex #3.1，最重要）**：步骤 3 后步骤 4 前崩（shard 已改、coordinator 旧仍
 *      ACTIVE 新仍 PENDING）→ login(旧) 仍通（旧 ACTIVE alias 定位到 userId，shard 按 userId 取到已改名
 *      user，密码对即通）；login(新) 暂拒（新仍 PENDING）——**无「两 email 都登不上」**；Task 8 恢复 worker
 *      凭 shard 权威 email 收敛到新（不依赖用户再调 updateEmail）→ 恢复后 login(新) 通、login(旧) 拒。
 *   ③ 跨租户唯一性：目标 email 已被**他租户** ACTIVE 占用 → 抛 AUTH_EMAIL_EXISTS，不改 shard、不留 PENDING。
 *   ④ per-tenant 定位：user 不在 tenantId 对应 shard（错 tenant）→ 拒，绝不改他 shard。
 */
describe('UserEmailDirectoryService 混合 scope 分片（updateEmail 跨库可恢复状态机）', () => {
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

  function resolverFor(tenantToShard: Record<string, string>): FakeMultiShardResolver {
    return new FakeMultiShardResolver({
      coordinator,
      shards: { A: shardA, B: shardB },
      tenantToShard,
    });
  }

  /** 直查协调库 email 目录项。 */
  function dirRow(email: string): { tenant_id: string; status: string; operation_kind: string } | undefined {
    return coordinator.prepare<{ tenant_id: string; status: string; operation_kind: string }>(
      'SELECT tenant_id, status, operation_kind FROM tenant_identity_directory WHERE lookup_kind = ? AND lookup_value = ?',
    ).get('email', canonicalizeEmail(email));
  }

  /** 直查某 shard 的 user 行 email。 */
  function shardEmail(db: IDatabase, userId: string): string | undefined {
    return db.prepare<{ email: string }>('SELECT email FROM users WHERE id = ?').get(userId)?.email;
  }

  /**
   * 用 AuthService.register 建一个 ACTIVE 用户（coordinator email ACTIVE + shard user + bootstrap），
   * 返回其 tenantId/userId（updateEmail 状态机的起点：旧 email 已 ACTIVE、shard user 权威）。
   */
  async function seedRegistered(email: string, password: string, tenantId: string, userId: string, shardId: 'A' | 'B'): Promise<void> {
    const svc = new AuthService(resolverFor({ [tenantId]: shardId }), config, fixedIdGen(tenantId, userId));
    await svc.register(fakeApp(), email, password, { idempotencyKey: `reg:${userId}` });
  }

  it('① 改 email 成功：新 email login 通、旧 email 拒；shard users.email 已改、coordinator 新 ACTIVE+旧删', async () => {
    await seedRegistered('old@example.com', 'password123', 'tenant_1', 'user_1', 'A');
    assert.equal(dirRow('old@example.com')!.status, 'ACTIVE');

    const dirSvc = new UserEmailDirectoryService(resolverFor({ tenant_1: 'A' }));
    const updated = dirSvc.updateEmail('tenant_1', 'user_1', 'New@Example.com');
    assert.equal(updated.email, 'new@example.com', 'updateEmail 返回归一化后的新 email');
    assert.equal(updated.tenantId, 'tenant_1');

    /* shard users.email 已改到归一化新 email。 */
    assert.equal(shardEmail(shardA, 'user_1'), 'new@example.com', 'shard user.email 已改');
    /* coordinator：新 email ACTIVE、旧 email 目录项已删。 */
    assert.equal(dirRow('new@example.com')!.status, 'ACTIVE', '新 email 目录 ACTIVE');
    assert.equal(dirRow('old@example.com'), undefined, '旧 email 目录项已删');

    /* 新 email login 通、旧 email login 拒。 */
    const authSvc = new AuthService(resolverFor({ tenant_1: 'A' }), config, fixedIdGen('unused', 'unused'));
    const ok = await authSvc.login(fakeApp(), 'new@example.com', 'password123');
    assert.equal(ok.userId, 'user_1');
    await assert.rejects(() => authSvc.login(fakeApp(), 'old@example.com', 'password123'), /邮箱或密码错误/, '旧 email 改名后 login 拒');
  });

  it('②【跨库崩溃窗口不锁死·最重要】步骤3后步骤4前崩 → login(旧)仍通、login(新)暂拒（无两 email 都登不上）；Task8 恢复收敛到新', async () => {
    await seedRegistered('crash-old@example.com', 'password123', 'tenant_c', 'user_c', 'A');

    /* 用 stub 让 completeEmailChange 抛错（模拟 shard UPDATE 成功后、coordinator activate 前崩）。 */
    const svc = new UserEmailDirectoryService(resolverFor({ tenant_c: 'A' }));
    const dir = (svc as unknown as { directory: { completeEmailChange: (i: unknown) => void } }).directory;
    dir.completeEmailChange = () => { throw new Error('步骤4前崩'); };

    let threw = false;
    try {
      svc.updateEmail('tenant_c', 'user_c', 'crash-new@example.com');
    } catch { threw = true; }
    assert.equal(threw, true, 'complete 崩 → updateEmail 抛错');

    /* 崩溃窗口态：shard 已改到新、coordinator 旧仍 ACTIVE、新仍 PENDING（EMAIL_CHANGE）。 */
    assert.equal(shardEmail(shardA, 'user_c'), 'crash-new@example.com', 'shard 已改到新 email');
    assert.equal(dirRow('crash-old@example.com')!.status, 'ACTIVE', '旧 email 目录仍 ACTIVE（未删）');
    assert.equal(dirRow('crash-new@example.com')!.status, 'PENDING', '新 email 仍 PENDING');
    assert.equal(dirRow('crash-new@example.com')!.operation_kind, 'EMAIL_CHANGE');

    /* 崩溃窗口内 login：旧 email 仍通（旧 ACTIVE alias 定位到 user_c，shard 按 userId 取到已改名 user，密码对即通）。 */
    const authSvc = new AuthService(resolverFor({ tenant_c: 'A' }), config, fixedIdGen('unused', 'unused'));
    const oldOk = await authSvc.login(fakeApp(), 'crash-old@example.com', 'password123');
    assert.equal(oldOk.userId, 'user_c', '崩溃窗口内旧 email 仍能 login（不锁死）');
    /* 新 email 暂拒（仍 PENDING，非 ACTIVE）——不是「两 email 都登不上」，旧 email 始终可登录。 */
    await assert.rejects(() => authSvc.login(fakeApp(), 'crash-new@example.com', 'password123'), /邮箱或密码错误/, '新 email PENDING → 暂拒');

    /* Task 8 恢复 worker：凭 shard 权威 email（==新）收敛 → completeEmailChange（新 ACTIVE + 旧删）。 */
    const recovery = new TenantReservationRecovery(resolverFor({ tenant_c: 'A' }), new SilentLogger(), { graceMs: 0 });
    const run = recovery.reconcile(Date.now() + 1);
    assert.equal(run.changesCompleted, 1, '恢复 worker 收敛改名到新（不依赖用户再调）');
    assert.equal(dirRow('crash-new@example.com')!.status, 'ACTIVE', '恢复后新 email ACTIVE');
    assert.equal(dirRow('crash-old@example.com'), undefined, '恢复后旧 email 目录项已删');

    /* 恢复后：新 email login 通、旧 email login 拒。 */
    const newOk = await authSvc.login(fakeApp(), 'crash-new@example.com', 'password123');
    assert.equal(newOk.userId, 'user_c', '恢复后新 email login 通');
    await assert.rejects(() => authSvc.login(fakeApp(), 'crash-old@example.com', 'password123'), /邮箱或密码错误/, '恢复后旧 email login 拒');
  });

  it('②b 崩溃窗口·shard 未改（reserve 后 shard UPDATE 前崩）→ login(旧)通、login(新)拒；Task8 rollback 删新 PENDING、旧仍权威', async () => {
    await seedRegistered('r-old@example.com', 'password123', 'tenant_rb', 'user_rb', 'A');

    /* stub：reserveEmailChange 成功后、shard UPDATE 前崩（此处让 shard UPDATE 抛错模拟）。
     * 更直接：手插 EMAIL_CHANGE PENDING（新 email），shard 保持旧 email 不改（模拟 reserve 后即崩）。 */
    const dir = new TenantIdentityDirectory(resolverFor({ tenant_rb: 'A' }));
    dir.reserveEmailChange({
      tenantId: 'tenant_rb', userId: 'user_rb',
      oldEmail: 'r-old@example.com', newEmail: 'r-new@example.com', operationId: 'chg:rb',
    });
    /* shard 仍是旧 email（未执行步骤 3）。 */
    assert.equal(shardEmail(shardA, 'user_rb'), 'r-old@example.com', 'shard 仍旧 email');
    assert.equal(dirRow('r-new@example.com')!.status, 'PENDING');

    /* 窗口内 login：旧通、新拒。 */
    const authSvc = new AuthService(resolverFor({ tenant_rb: 'A' }), config, fixedIdGen('unused', 'unused'));
    assert.equal((await authSvc.login(fakeApp(), 'r-old@example.com', 'password123')).userId, 'user_rb', '旧 email 仍通');
    await assert.rejects(() => authSvc.login(fakeApp(), 'r-new@example.com', 'password123'), /邮箱或密码错误/);

    /* Task 8 恢复：shard email==旧 → rollbackEmailChange（删新 PENDING，旧仍权威 ACTIVE）。 */
    const recovery = new TenantReservationRecovery(resolverFor({ tenant_rb: 'A' }), new SilentLogger(), { graceMs: 0 });
    const run = recovery.reconcile(Date.now() + 1);
    assert.equal(run.changesRolledBack, 1, '恢复回滚未竟改名');
    assert.equal(dirRow('r-new@example.com'), undefined, '新 PENDING 已删');
    assert.equal(dirRow('r-old@example.com')!.status, 'ACTIVE', '旧 email 仍权威 ACTIVE');
    assert.equal((await authSvc.login(fakeApp(), 'r-old@example.com', 'password123')).userId, 'user_rb', '回滚后旧 email 仍可登录');
  });

  it('③ 跨租户唯一性：目标 email 已被他租户 ACTIVE 占用 → 抛 AUTH_EMAIL_EXISTS、不改 shard、不留 PENDING', async () => {
    await seedRegistered('me@example.com', 'password123', 'tenant_me', 'user_me', 'A');
    await seedRegistered('taken@example.com', 'password123', 'tenant_them', 'user_them', 'B');

    const svc = new UserEmailDirectoryService(resolverFor({ tenant_me: 'A', tenant_them: 'B' }));
    let threw: unknown;
    try {
      svc.updateEmail('tenant_me', 'user_me', 'Taken@Example.com');
      assert.fail('目标 email 属他租户 → 必须抛 AUTH_EMAIL_EXISTS');
    } catch (e) { threw = e; }
    assert.equal((threw as { code?: string }).code, ErrorCode.AUTH_EMAIL_EXISTS);

    /* 未改 shard、未留 PENDING（跨租户 email 目录仍属 tenant_them）。 */
    assert.equal(shardEmail(shardA, 'user_me'), 'me@example.com', 'shard 未改');
    assert.equal(dirRow('taken@example.com')!.tenant_id, 'tenant_them', '目标 email 仍属他租户');
    assert.equal(dirRow('taken@example.com')!.status, 'ACTIVE', '未被降级为 PENDING');
  });

  it('④ per-tenant 定位：user 不在 tenantId 对应 shard（错 tenant）→ 拒，绝不改他 shard', async () => {
    await seedRegistered('perT@example.com', 'password123', 'tenant_pt', 'user_pt', 'A');

    /* 用错误 tenantId（tenant_wrong 映射到 shard B，其上无 user_pt）→ 找不到 user → 拒。 */
    const svc = new UserEmailDirectoryService(resolverFor({ tenant_pt: 'A', tenant_wrong: 'B' }));
    let threw = false;
    try {
      svc.updateEmail('tenant_wrong', 'user_pt', 'moved@example.com');
      assert.fail('错 tenant 定位不到 user → 必须拒');
    } catch { threw = true; }
    assert.equal(threw, true, '错 tenant → 拒');

    /* shard A 上真正的 user 未被改、shard B 未被写入。 */
    assert.equal(shardEmail(shardA, 'user_pt'), 'pert@example.com', 'shard A 真 user 未改');
    assert.equal(shardEmail(shardB, 'user_pt'), undefined, 'shard B 未被误写');
    assert.equal(dirRow('moved@example.com'), undefined, '未留新 email 目录项');
  });

  it('⑤ 幂等重试：同参 updateEmail 二次调用（模拟步骤4后重复）→ 幂等收敛，不抛、不产生第二个 PENDING', async () => {
    await seedRegistered('idem-old@example.com', 'password123', 'tenant_id', 'user_id', 'A');

    const svc = new UserEmailDirectoryService(resolverFor({ tenant_id: 'A' }));
    const r1 = svc.updateEmail('tenant_id', 'user_id', 'idem-new@example.com');
    assert.equal(r1.email, 'idem-new@example.com');
    /* 二次同参：shard 已是新 email（oldEmail 读为新）→ email 未变 → 幂等 no-op 返回当前 profile。 */
    const r2 = svc.updateEmail('tenant_id', 'user_id', 'idem-new@example.com');
    assert.equal(r2.email, 'idem-new@example.com', '幂等：二次同参返回新 email');
    assert.equal(dirRow('idem-new@example.com')!.status, 'ACTIVE');
    assert.equal(dirRow('idem-old@example.com'), undefined, '旧 email 目录项已删（未复活）');
  });

  it('⑥【Codex #2 主动收敛】步骤3后步骤4前崩 → 同参重试主动完成未竟 PENDING（不只依赖 Task8 worker）', async () => {
    await seedRegistered('ac-old@example.com', 'password123', 'tenant_ac', 'user_ac', 'A');

    /* 首次 updateEmail 崩在步骤 4（completeEmailChange 抛）：shard 已改新、coordinator 旧 ACTIVE + 新 PENDING。 */
    const svc1 = new UserEmailDirectoryService(resolverFor({ tenant_ac: 'A' }));
    const dir1 = (svc1 as unknown as { directory: { completeEmailChange: (i: unknown) => void } }).directory;
    const realComplete = dir1.completeEmailChange.bind(dir1);
    dir1.completeEmailChange = () => { throw new Error('步骤4崩'); };
    let firstThrew = false;
    try { svc1.updateEmail('tenant_ac', 'user_ac', 'ac-new@example.com'); } catch { firstThrew = true; }
    assert.equal(firstThrew, true);
    assert.equal(dirRow('ac-new@example.com')!.status, 'PENDING', '崩后新 email 仍 PENDING');
    assert.equal(shardEmail(shardA, 'user_ac'), 'ac-new@example.com', 'shard 已改新');
    void realComplete;

    /* 同参重试（新 svc，completeEmailChange 正常）：canonOld===canonNew（shard 已新）→ 走主动收敛分支
     * 完成 opId 匹配的 PENDING（非纯 no-op、非等 Task8）。 */
    const svc2 = new UserEmailDirectoryService(resolverFor({ tenant_ac: 'A' }));
    const r = svc2.updateEmail('tenant_ac', 'user_ac', 'ac-new@example.com');
    assert.equal(r.email, 'ac-new@example.com');
    assert.equal(dirRow('ac-new@example.com')!.status, 'ACTIVE', '重试主动完成 → 新 email ACTIVE');
    assert.equal(dirRow('ac-old@example.com'), undefined, '重试主动完成 → 旧 email 删');

    /* 收敛后新 email login 通、旧 email 拒（无需 Task8 介入）。 */
    const authSvc = new AuthService(resolverFor({ tenant_ac: 'A' }), config, fixedIdGen('unused', 'unused'));
    assert.equal((await authSvc.login(fakeApp(), 'ac-new@example.com', 'password123')).userId, 'user_ac');
    await assert.rejects(() => authSvc.login(fakeApp(), 'ac-old@example.com', 'password123'), /邮箱或密码错误/);
  });

  it('⑦【Codex #1 原子提交】completeEmailChange CAS 未命中 → 事务回滚：新未 ACTIVE、旧未删（无双 ACTIVE 永久态）', () => {
    /* 直接测门面：手插 EMAIL_CHANGE PENDING（新 email）+ 旧 email ACTIVE，用**错 operationId** 调
     * completeEmailChange → CAS 未命中 → 抛错回滚 → 新仍 PENDING、旧仍 ACTIVE（非「新 ACTIVE 旧 ACTIVE」）。 */
    const dir = new TenantIdentityDirectory(resolverFor({ tenant_atomic: 'A' }));
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_atomic', userId: 'user_atomic', operationId: 'chg:right', operationKind: 'EMAIL_CHANGE',
      previousLookupValue: canonicalizeEmail('atomic-old@example.com'), pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: canonicalizeEmail('atomic-new@example.com'), status: 'PENDING', now: NOW,
    }));
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_atomic', userId: 'user_atomic', operationId: 'reg:atomic', operationKind: 'REGISTER',
      previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: canonicalizeEmail('atomic-old@example.com'), status: 'ACTIVE', now: NOW,
    }));

    assert.throws(
      () => dir.completeEmailChange({ oldEmail: 'atomic-old@example.com', newEmail: 'atomic-new@example.com', operationId: 'chg:WRONG' }),
      /改名提交失败/,
      'CAS 未命中（错 opId）→ 抛错',
    );
    /* 事务回滚保证：新仍 PENDING（未被激活）、旧仍 ACTIVE（未被删）。 */
    assert.equal(dirRow('atomic-new@example.com')!.status, 'PENDING', '回滚：新仍 PENDING');
    assert.equal(dirRow('atomic-old@example.com')!.status, 'ACTIVE', '回滚：旧仍 ACTIVE（未删）');
  });

  it('⑦b【Codex 复审故障注入】CAS 已命中后 delete 旧 email 抛错 → 整事务回滚：新激活被撤销（仍 PENDING）、旧未删', () => {
    const dir = new TenantIdentityDirectory(resolverFor({ tenant_fi: 'A' }));
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_fi', userId: 'user_fi', operationId: 'chg:fi', operationKind: 'EMAIL_CHANGE',
      previousLookupValue: canonicalizeEmail('fi-old@example.com'), pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: canonicalizeEmail('fi-new@example.com'), status: 'PENDING', now: NOW,
    }));
    coordinator.execute(dirCmdReserve({
      tenantId: 'tenant_fi', userId: 'user_fi', operationId: 'reg:fi', operationKind: 'REGISTER',
      previousLookupValue: null, pendingPasswordHash: null,
      lookupKind: 'email', lookupValue: canonicalizeEmail('fi-old@example.com'), status: 'ACTIVE', now: NOW,
    }));

    /* 故障注入：CAS 命中（正确 opId）后，删旧 email 时抛错——拦截 coordinator.execute 的 deleteByLookup
     * 命令使其抛错。事务内异常须整体回滚（包括同事务内已执行的 activate CAS），证明「CAS 后删旧前崩」
     * 不留半提交态。 */
    const realExecute = coordinator.execute.bind(coordinator);
    coordinator.execute = ((cmd: { kind?: string }) => {
      if (cmd?.kind === DIR_CMD_DELETE_BY_LOOKUP) throw new Error('删旧 email 故障注入');
      return realExecute(cmd as Parameters<typeof realExecute>[0]);
    }) as typeof coordinator.execute;
    try {
      assert.throws(
        () => dir.completeEmailChange({ oldEmail: 'fi-old@example.com', newEmail: 'fi-new@example.com', operationId: 'chg:fi' }),
        /删旧 email 故障注入/,
        'delete 抛错传播出事务边界',
      );
    } finally {
      coordinator.execute = realExecute;
    }
    /* 关键断言：activate CAS 虽已在事务内命中，但因 delete 抛错整事务回滚 → 新仍 PENDING（非 ACTIVE）、旧未删。 */
    assert.equal(dirRow('fi-new@example.com')!.status, 'PENDING', '回滚：activate 被撤销，新仍 PENDING（非双 ACTIVE）');
    assert.equal(dirRow('fi-old@example.com')!.status, 'ACTIVE', '回滚：旧未删仍 ACTIVE');
  });
});
