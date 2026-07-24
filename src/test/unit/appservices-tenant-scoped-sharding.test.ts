/**
 * buildAppServices tenant-scoped 服务多-shard 分片探针（Plan 1b · Task 1 范式）。
 * 用 FakeMultiShardResolver 注多个独立物理内存 db，断言 IdentityService 双重约束：
 * ① dbForTenant 选对 shard（A 的 identity 落 A 的 shard，B 的 shard 查不到）；
 * ② SQL tenant predicate 防同库跨租户读改删（共享物理 db 只种 B 的键、用 A 查返 null）。
 * 「铺路不激活」子片唯一能真正验证正确性的手段：单库下 dbForTenant 与 coordinatorDb 是同一 db，
 * 普通功能测试证不出路由对错；本探针注独立 db，让「数据真落对 shard」可断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityService } from '../../identity/identity-service.js';
import { AvatarService } from '../../identity/avatar-service.js';
import { DeviceAvatarService } from '../../identity/device-avatar-service.js';
import { MobileDeviceService } from '../../identity/mobile-device-service.js';
import { CollaborationService } from '../../identity/collaboration-service.js';
import { OrganizationService } from '../../enterprise/organization-service.js';
import { AdminControlPlaneService } from '../../enterprise/admin-control-plane-service.js';
import { KnowledgeSourceService } from '../../knowledge/knowledge-source-service.js';
import { PushDispatcher, type DeviceLookup, type DeviceLookupResult } from '../../agent/push/dispatcher.js';
import type { PushProvider, PushResult, TokenInvalidationCallback } from '../../types/push.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带 identities/avatars 表的内存 db（迁移入口——runDslSqliteMigrations 建全表）。 */
function idDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 种一条 users 行（persona_core.owner_user_id / org listMembers 的 users JOIN 需要它满足 FK）。 */
function seedUser(db: IDatabase, userId: string, tenantId: string): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, 'hash', 'member', ?, ?, ?)`,
  ).run(userId, `${userId}@example.com`, tenantId, now, now);
}

test('IdentityService per-tenant：A 的 identity 落 A 的 shard，B 的 shard 查不到（选对 shard + tenant predicate）', () => {
  const s0 = idDb(), s1 = idDb(), coord = idDb();
  /* A→s0（home），B→s1（非 home）——刻意让 B 映射到非 home，才能被 mutation① 换 home 揪出。 */
  const resolver = new FakeMultiShardResolver({ coordinator: coord, shards: { s0, s1 }, tenantToShard: { tA: 's0', tB: 's1' } });
  const svc = new IdentityService(resolver);
  svc.create('tA', 'userA', 'Alice');                    // 应落 s0
  assert.ok(svc.getByUser('tA', 'userA'), 'A 在自己 shard 查得到');
  assert.equal(svc.getByUser('tB', 'userA'), null, '用 tB（→s1）查 userA：查不到（不串 shard）');
  /* 对称：B 的 identity 落 s1，s0 查不到（换 home mutation① 的正向锚点）。 */
  svc.create('tB', 'userB', 'Bob');
  assert.ok(svc.getByUser('tB', 'userB'), 'B 在自己 shard（s1）查得到');
  assert.equal(svc.getByUser('tA', 'userB'), null, '用 tA（→s0）查 userB：查不到');
  /* 物理断言：userB 的行只在 s1、s0 无（防「都落 s0」的 shard 路由 bug）。 */
  assert.ok(s1.prepare(`SELECT 1 FROM identities WHERE user_id = 'userB'`).get(), 'userB 行在 s1');
  assert.equal(s0.prepare(`SELECT 1 FROM identities WHERE user_id = 'userB'`).get(), undefined, 's0 无 userB 行');
  s0.close(); s1.close(); coord.close();
});

test('IdentityService tenant predicate：共享物理 db 只种 B 的键、用 A 查/改 返 null（防同库跨租户）', () => {
  /* 单一物理 db，A/B 同库（SingleDbResolver 模拟同 shard 内多租户）。种 B 的 userId=userShared。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const svc = new IdentityService(resolver);
  const created = svc.create('tB', 'userShared', 'BShared');
  /* 用 tA + 同一 userId 查：predicate 生效 → null（不命中 B 的行）。 */
  assert.equal(svc.getByUser('tA', 'userShared'), null, 'tA 查不到 tB 的 userShared（tenant predicate 隔离）');
  assert.ok(svc.getByUser('tB', 'userShared'), 'tB 自己查得到');
  /* 用 tA + B 的 identityId update：predicate 生效 → null（不误改 B 的行）。 */
  assert.equal(svc.update('tA', created.id, { displayName: '越权改名' }), null, 'tA 改不到 tB 的 identity（update tenant predicate 隔离）');
  const stillB = svc.update('tB', created.id, { displayName: 'B 自己改名' });
  assert.ok(stillB && stillB.displayName === 'B 自己改名', 'tB 改自己的 identity 成功');
  db.close();
});

/* ── Avatar 组（Task 2）：avatars/device_avatars 无 tenant_id 列 → 全经 identity 父归属 JOIN/EXISTS ── */

test('AvatarService per-tenant：A 在自己 identity 下建 avatar 落 s0，B 的 shard 查不到（选对 shard + 父归属）', () => {
  const s0 = idDb(), s1 = idDb(), coord = idDb();
  /* A→s0（home），B→s1（非 home）——刻意让 B 映射到非 home，才能被 mutation① 换 home 揪出。 */
  const resolver = new FakeMultiShardResolver({ coordinator: coord, shards: { s0, s1 }, tenantToShard: { tA: 's0', tB: 's1' } });
  const identitySvc = new IdentityService(resolver);
  const avatarSvc = new AvatarService(resolver);
  /* A 在 s0 建 identity（附带默认 avatar），再建自定义 avatar。 */
  const identA = identitySvc.create('tA', 'userA', 'Alice');
  const avA = avatarSvc.create('tA', identA.id, { label: 'A 的工作分身' });
  assert.ok(avatarSvc.getById('tA', avA.id), 'A 在自己 shard 查得到自己的 avatar');
  /* 用 tB（→s1）查 A 的 avatarId：s1 根本没这行 → null（不串 shard）。 */
  assert.equal(avatarSvc.getById('tB', avA.id), null, '用 tB（→s1）查 A 的 avatar：查不到（不串 shard）');
  /* 对称：B 在 s1 建，s0 查不到。 */
  const identB = identitySvc.create('tB', 'userB', 'Bob');
  const avB = avatarSvc.create('tB', identB.id, { label: 'B 的分身' });
  assert.ok(avatarSvc.getById('tB', avB.id), 'B 在自己 shard（s1）查得到');
  assert.equal(avatarSvc.getById('tA', avB.id), null, '用 tA（→s0）查 B 的 avatar：查不到');
  /* 物理断言：B 的 avatar 行只在 s1、s0 无（防「都落 s0」的 shard 路由 bug）。 */
  assert.ok(s1.prepare(`SELECT 1 FROM avatars WHERE id = ?`).get(avB.id), 'B 的 avatar 行在 s1');
  assert.equal(s0.prepare(`SELECT 1 FROM avatars WHERE id = ?`).get(avB.id), undefined, 's0 无 B 的 avatar 行');
  s0.close(); s1.close(); coord.close();
});

test('AvatarService tenant predicate：共享物理 db 只种 B 的 identity+avatar，用 tA 查/改/删 返 null（防同库跨租户）', () => {
  /* 单一物理 db，A/B 同库（SingleDbResolver 模拟同 shard 内多租户）。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const identitySvc = new IdentityService(resolver);
  const avatarSvc = new AvatarService(resolver);
  /* 只种 B 的 identity + 自定义 avatar。 */
  const identB = identitySvc.create('tB', 'userSharedB', 'BShared');
  const avB = avatarSvc.create('tB', identB.id, { label: 'B 的 avatar' });
  /* 用 tA 查 B 的 avatarId：父归属 predicate 生效 → null（不命中 B 的行）。 */
  assert.equal(avatarSvc.getById('tA', avB.id), null, 'tA 查不到 tB 的 avatar（父归属 JOIN identities 隔离）');
  assert.ok(avatarSvc.getById('tB', avB.id), 'tB 自己查得到');
  /* 用 tA listByIdentity B 的 identityId：父归属 predicate 生效 → 空（identity 不属 tA）。 */
  assert.equal(avatarSvc.listByIdentity('tA', identB.id).length, 0, 'tA listByIdentity tB 的 identity → 空');
  assert.ok(avatarSvc.listByIdentity('tB', identB.id).length >= 1, 'tB list 自己的 identity 有 avatar');
  /* 用 tA update B 的 avatarId：父归属 predicate 生效 → null（不误改 B 的行）。 */
  assert.equal(avatarSvc.update('tA', avB.id, { label: '越权改名' }), null, 'tA 改不到 tB 的 avatar（update 父归属隔离）');
  const stillB = avatarSvc.update('tB', avB.id, { label: 'B 自己改名' });
  assert.ok(stillB && stillB.label === 'B 自己改名', 'tB 改自己的 avatar 成功');
  /* 用 tA softDelete B 的 avatarId：父归属 predicate 生效 → false（不误删 B 的行）。 */
  assert.equal(avatarSvc.softDelete('tA', avB.id), false, 'tA 删不掉 tB 的 avatar（softDelete 父归属隔离）');
  assert.ok(avatarSvc.getById('tB', avB.id), 'tA 越权删除失败后 B 的 avatar 仍在');
  db.close();
});

test('AvatarService create：跨租户在别人 identity 下建 avatar 被 EXISTS 父归属拦', () => {
  /* 共享物理 db：B 的 identity。tA create 到 B 的 identityId 应被 EXISTS identities WHERE id=? AND tenant_id=tA 拦。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const identitySvc = new IdentityService(resolver);
  const avatarSvc = new AvatarService(resolver);
  const identB = identitySvc.create('tB', 'userCreateB', 'BCreate');
  const before = avatarSvc.listByIdentity('tB', identB.id).length;
  assert.throws(
    () => avatarSvc.create('tA', identB.id, { label: '越权建的分身' }),
    /identity|不存在|归属|NOT_FOUND/i,
    'tA 在 tB 的 identity 下建 avatar 应被 EXISTS 父归属拦',
  );
  /* 确认没有偷偷落库。 */
  assert.equal(avatarSvc.listByIdentity('tB', identB.id).length, before, '越权 create 未落库');
  db.close();
});

test('DeviceAvatarService install：device 端 + avatar 端两端都验 tenant 归属（防跨租户 link）', () => {
  /* 共享物理 db。B 的 identity+avatar+device；A 的 device。用 A 越权 link B 的 avatar → 两端验拦。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const identitySvc = new IdentityService(resolver);
  const avatarSvc = new AvatarService(resolver);
  const deviceAvatarSvc = new DeviceAvatarService(resolver);
  const now = Date.now();
  /* B 的 identity + 自定义 avatar + 设备。 */
  const identB = identitySvc.create('tB', 'userDaB', 'BDa');
  const avB = avatarSvc.create('tB', identB.id, { label: 'B 的分身' });
  db.prepare<void>(
    `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, last_seen_at, created_at)
     VALUES ('devB', 'tB', 'userDaB', 'duidB', 'web', ?, ?)`,
  ).run(now, now);
  /* A 的设备。 */
  const identA = identitySvc.create('tA', 'userDaA', 'ADa');
  const avA = avatarSvc.create('tA', identA.id, { label: 'A 的分身' });
  db.prepare<void>(
    `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, last_seen_at, created_at)
     VALUES ('devA', 'tA', 'userDaA', 'duidA', 'web', ?, ?)`,
  ).run(now, now);
  /* 合法：A 把自己的 avatar link 到自己的 device。 */
  deviceAvatarSvc.install('tA', 'devA', avA.id);
  assert.ok(deviceAvatarSvc.isInstalled('tA', 'devA', avA.id), 'A link 自己的 avatar 到自己的 device 成功');
  /* 越权 avatar 端：A 把 B 的 avatar link 到自己的 device → avatar 端验拦。 */
  assert.throws(
    () => deviceAvatarSvc.install('tA', 'devA', avB.id),
    /avatar|device|归属|不存在|NOT_FOUND/i,
    'A link B 的 avatar 应被 avatar 端 tenant 验拦',
  );
  /* 越权 device 端：A 把自己的 avatar link 到 B 的 device → device 端验拦。 */
  assert.throws(
    () => deviceAvatarSvc.install('tA', 'devB', avA.id),
    /avatar|device|归属|不存在|NOT_FOUND/i,
    'A link 到 B 的 device 应被 device 端 tenant 验拦',
  );
  db.close();
});

/* ── Mobile 组（Task 3）：devices 表有 tenant_id 列 → 直接 WHERE tenant_id=? AND … predicate ── */

test('MobileDeviceService per-tenant：A register device 落 s0，用 tB findById 该 device 返 null（选对 shard + tenant predicate）', () => {
  const s0 = idDb(), s1 = idDb(), coord = idDb();
  /* A→s0（home），B→s1（非 home）——刻意让 B 映射到非 home，才能被 mutation① 换 home 揪出。 */
  const resolver = new FakeMultiShardResolver({ coordinator: coord, shards: { s0, s1 }, tenantToShard: { tA: 's0', tB: 's1' } });
  const svc = new MobileDeviceService(resolver);
  const reg = svc.register('tA', 'userA', { deviceUid: 'duidA', platform: 'ios', pushToken: 'TOKEN_A' });
  /* A 在自己 shard（s0）用 tA findById 查得到。 */
  assert.ok(svc.findById('tA', reg.id), 'A 在自己 shard 查得到自己的 device');
  /* 用 tB（→s1）查 A 的 deviceId：s1 根本没这行 → null（不串 shard）。 */
  assert.equal(svc.findById('tB', reg.id), null, '用 tB（→s1）查 A 的 device：查不到（不串 shard）');
  /* 对称：B register 落 s1，s0 查不到。 */
  const regB = svc.register('tB', 'userB', { deviceUid: 'duidB', platform: 'android', pushToken: 'TOKEN_B' });
  assert.ok(svc.findById('tB', regB.id), 'B 在自己 shard（s1）查得到');
  assert.equal(svc.findById('tA', regB.id), null, '用 tA（→s0）查 B 的 device：查不到');
  /* 物理断言：B 的 device 行只在 s1、s0 无（防「都落 s0」的 shard 路由 bug）。 */
  assert.ok(s1.prepare(`SELECT 1 FROM devices WHERE id = ?`).get(regB.id), 'B 的 device 行在 s1');
  assert.equal(s0.prepare(`SELECT 1 FROM devices WHERE id = ?`).get(regB.id), undefined, 's0 无 B 的 device 行');
  s0.close(); s1.close(); coord.close();
});

test('MobileDeviceService tenant predicate：共享物理 db 只种 B 的 device，用 tA findById/listByUser/updatePushToken/markTokenInvalid 均不命中（防同库跨租户）', () => {
  /* 单一物理 db，A/B 同库（SingleDbResolver 模拟同 shard 内多租户）。只种 B 的 device。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const svc = new MobileDeviceService(resolver);
  const regB = svc.register('tB', 'userSharedB', { deviceUid: 'duidSharedB', platform: 'ios', pushToken: 'TOKEN_ORIG' });
  /* findById：用 tA 查 B 的 deviceId → null（tenant predicate 隔离）。 */
  assert.equal(svc.findById('tA', regB.id), null, 'tA 查不到 tB 的 device（findById tenant predicate 隔离）');
  assert.ok(svc.findById('tB', regB.id), 'tB 自己查得到');
  /* listByUser：用 tA + B 的 userId → 空（不串租户）。 */
  assert.equal(svc.listByUser('tA', 'userSharedB').length, 0, 'tA listByUser tB 的 userId → 空');
  assert.ok(svc.listByUser('tB', 'userSharedB').length >= 1, 'tB list 自己的 userId 有 device');
  /* updatePushToken：用 tA + B 的 deviceId/userId 改 → 不生效（B 的 token 不变）。 */
  const upd = svc.updatePushToken('tA', regB.id, 'userSharedB', 'TOKEN_HIJACK');
  assert.equal(upd.updated, false, 'tA 改不到 tB 的 push token（updatePushToken tenant predicate 隔离）');
  assert.equal(svc.findById('tB', regB.id)?.push_token, 'TOKEN_ORIG', 'B 的 push token 未被越权改动');
  /* markTokenInvalid：用 tA + B 的 deviceId 标失效 → 不生效（B 的 is_invalid_at 仍 null）。 */
  svc.markTokenInvalid('tA', regB.id, 'cross-tenant');
  assert.equal(svc.findById('tB', regB.id)?.is_invalid_at, null, 'B 的 is_invalid_at 未被越权标位');
  /* tB 自己标位则生效。 */
  svc.markTokenInvalid('tB', regB.id, 'legit');
  assert.notEqual(svc.findById('tB', regB.id)?.is_invalid_at, null, 'tB 自己标位生效');
  db.close();
});

/* ── PushDispatcher 全传播链 (tenantId, deviceId)（Task 3）── */

class RecordingProvider implements PushProvider {
  readonly channel = 'apns' as const;
  readonly sent: string[] = [];
  constructor(private readonly invalidTokens: string[] = []) {}
  async send(pushToken: string): Promise<PushResult> {
    this.sent.push(pushToken);
    const invalidated = this.invalidTokens.includes(pushToken);
    return { deviceId: pushToken, success: !invalidated, tokenInvalidated: invalidated, ...(invalidated ? { error: 'BadDeviceToken' } : {}) };
  }
  async close(): Promise<void> {}
}

test('PushDispatcher.send 把 tenantId 传给 deviceLookup(tenantId, deviceId)（全链带 tenantId 非丢弃 _tenantId）', async () => {
  const seen: Array<{ tenantId: string; deviceId: string }> = [];
  const deviceLookup: DeviceLookup = async (tenantId, deviceId) => {
    seen.push({ tenantId, deviceId });
    const r: DeviceLookupResult = { platform: 'ios', pushToken: 'TOKEN_OK' };
    return r;
  };
  const dispatcher = new PushDispatcher({
    providers: new Map<string, PushProvider>([['apns', new RecordingProvider()]]),
    deviceLookup,
  });
  await dispatcher.send('tenantX', 'devZ', { title: 't', body: 'b' });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { tenantId: 'tenantX', deviceId: 'devZ' }, 'deviceLookup 收到 (tenantId, deviceId)');
});

test('PushDispatcher.sendBatch 逐条把 tenantId 传下去', async () => {
  const seen: Array<{ tenantId: string; deviceId: string }> = [];
  const deviceLookup: DeviceLookup = async (tenantId, deviceId) => {
    seen.push({ tenantId, deviceId });
    return { platform: 'ios', pushToken: `T_${deviceId}` };
  };
  const dispatcher = new PushDispatcher({
    providers: new Map<string, PushProvider>([['apns', new RecordingProvider()]]),
    deviceLookup,
  });
  await dispatcher.sendBatch('tenantY', ['d1', 'd2'], { title: 't', body: 'b' });
  assert.deepEqual(seen, [
    { tenantId: 'tenantY', deviceId: 'd1' },
    { tenantId: 'tenantY', deviceId: 'd2' },
  ], 'sendBatch 每条都带同一 tenantId');
});

test('PushDispatcher tokenInvalidated 回调带 (tenantId, deviceId, reason)（fireAndForgetInvalidation 全链）', async () => {
  const invalidations: Array<{ tenantId: string; deviceId: string; reason: string }> = [];
  const onTokenInvalidated: TokenInvalidationCallback = async (tenantId, deviceId, reason) => {
    invalidations.push({ tenantId, deviceId, reason });
  };
  const dispatcher = new PushDispatcher({
    providers: new Map<string, PushProvider>([['apns', new RecordingProvider(['TOKEN_BAD'])]]),
    deviceLookup: async () => ({ platform: 'ios', pushToken: 'TOKEN_BAD' }),
    onTokenInvalidated,
  });
  const result = await dispatcher.send('tenantW', 'devBad', { title: 't', body: 'b' });
  assert.equal(result.tokenInvalidated, true);
  /* fire-and-forget — 等一个微任务 flush。 */
  await new Promise((r) => setImmediate(r));
  assert.equal(invalidations.length, 1);
  assert.deepEqual(
    { tenantId: invalidations[0]!.tenantId, deviceId: invalidations[0]!.deviceId },
    { tenantId: 'tenantW', deviceId: 'devBad' },
    'tokenInvalidated 回调收到 (tenantId, deviceId)',
  );
});

/* ── Collaboration 组（Task 4）：shared_simulations 无 tenant_id 列（只 simulation_id/owner_user_id/
 *    shared_with_user_id）→ listSharedWithUser 经 life_simulations 父归属 JOIN（WHERE ls.tenant_id=?）。
 *    另 3 方法（share/listSharesForSimulation/unshare）已带 tenantId（服务层查 life_simulations.tenant_id 校验）。 ── */

/** 在指定 db 种一条 life_simulations 行（tenant + owner），供 share 的 owner-only 鉴权用。 */
function seedSimulation(db: IDatabase, id: string, tenantId: string, ownerUserId: string): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO life_simulations (id, tenant_id, task_id, config_json, status, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, '{}', 'completed', ?, ?, ?)`,
  ).run(id, tenantId, `task_${id}`, ownerUserId, now, now);
}

test('CollaborationService per-tenant：B share simulation 经 service 落 s1（非 home），用 tA listSharedWithUser 查不到（选对 shard + 父归属 predicate）', () => {
  const s0 = idDb(), s1 = idDb(), coord = idDb();
  /* A→s0（home），B→s1（非 home）——刻意让 B 映射到非 home，才能被 mutation① 换 home 揪出。 */
  const resolver = new FakeMultiShardResolver({ coordinator: coord, shards: { s0, s1 }, tenantToShard: { tA: 's0', tB: 's1' } });
  const svc = new CollaborationService(resolver);
  /* B（非 home 租户）的 simulation 种在自己 shard s1；share 经 service 写（必须由 txFor 选对 s1）。 */
  seedSimulation(s1, 'simB', 'tB', 'ownerB');
  svc.share('simB', 'ownerB', 'tB', 'targetUser', 'view');
  /* targetUser 在租户 B（s1）里能查到分享给自己的 simulation。 */
  const listedB = svc.listSharedWithUser('tB', 'targetUser', 1, 20);
  assert.equal(listedB.total, 1, 'B 的 targetUser 查到 1 条 share');
  assert.equal(listedB.data[0]?.simulationId, 'simB', 'share 指向 simB');
  /* 用 tA（→s0）以同一 targetUserId 查：s0 根本没这行 → 空（不串 shard）。 */
  const listedA = svc.listSharedWithUser('tA', 'targetUser', 1, 20);
  assert.equal(listedA.total, 0, '用 tA（→s0）查 targetUser 的 share：查不到（不串 shard）');
  assert.equal(listedA.data.length, 0, 'tA 结果集为空');
  /* 物理断言：share 行只在 s1（B 的 shard）、s0 无（防 mutation① 把 B 的写恒路由到 home s0）。 */
  assert.ok(s1.prepare(`SELECT 1 FROM shared_simulations WHERE shared_with_user_id = 'targetUser'`).get(), 'B 的 share 行在 s1');
  assert.equal(s0.prepare(`SELECT 1 FROM shared_simulations WHERE shared_with_user_id = 'targetUser'`).get(), undefined, 's0 无 share 行');
  s0.close(); s1.close(); coord.close();
});

test('CollaborationService listSharedWithUser 父归属 predicate：共享物理 db，A/B 各有 owner 给同一 targetUser 的 share，tA 只看得到属 tA 的 simulation（防同库跨租户）', () => {
  /* 单一物理 db，A/B 同库（SingleDbResolver 模拟同 shard 内多租户）。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const svc = new CollaborationService(resolver);
  /* A 的 simulation share 给 sharedTarget；B 的 simulation 也 share 给同名 sharedTarget。 */
  seedSimulation(db, 'simA', 'tA', 'ownerA');
  seedSimulation(db, 'simB', 'tB', 'ownerB');
  svc.share('simA', 'ownerA', 'tA', 'sharedTarget', 'view');
  svc.share('simB', 'ownerB', 'tB', 'sharedTarget', 'view');
  /* 用 tA 查 sharedTarget：父归属 predicate（JOIN life_simulations WHERE ls.tenant_id='tA'）
   * → 只看到 simA（属 tA），看不到 simB（属 tB）。 */
  const listedA = svc.listSharedWithUser('tA', 'sharedTarget', 1, 20);
  assert.equal(listedA.total, 1, 'tA 只看到属 tA 的 1 条 share（不串 tB 的 share）');
  assert.equal(listedA.data[0]?.simulationId, 'simA', 'tA 看到的是 simA');
  /* 对称：用 tB 查 sharedTarget → 只看到 simB。 */
  const listedB = svc.listSharedWithUser('tB', 'sharedTarget', 1, 20);
  assert.equal(listedB.total, 1, 'tB 只看到属 tB 的 1 条 share');
  assert.equal(listedB.data[0]?.simulationId, 'simB', 'tB 看到的是 simB');
  db.close();
});

/* ── Organization 组（Task 5）：organizations/workspaces/organization_memberships/organization_role_bindings
 *    全有 tenant_id 列 → 每 query WHERE tenant_id=? predicate（executor 已含）。方法已带 tenantId，
 *    仅 ctor (tx)→(resolver) + 每方法 dbForTenant(tenantId)。 ── */

test('OrganizationService per-tenant：B create org 经 service 落 s1（非 home），用 tA listByUser 查不到（选对 shard + tenant predicate）', () => {
  const s0 = idDb(), s1 = idDb(), coord = idDb();
  /* A→s0（home），B→s1（非 home）——刻意让 B 映射到非 home，才能被 mutation① 换 home 揪出。 */
  const resolver = new FakeMultiShardResolver({ coordinator: coord, shards: { s0, s1 }, tenantToShard: { tA: 's0', tB: 's1' } });
  const svc = new OrganizationService(resolver);
  /* B（非 home 租户）的 org 经 service 建（必须由 dbForTenant 选对 s1）；先种 users 满足 membership JOIN。 */
  seedUser(s1, 'userB', 'tB');
  const createdB = svc.create('tB', 'userB', { name: 'B 公司', defaultWorkspaceName: 'B 默认空间' });
  /* B（userB）在自己 shard（s1）listByUser 查得到自己的 org。 */
  const listedB = svc.listByUser('tB', 'userB');
  assert.equal(listedB.length, 1, 'B 的 userB 查到 1 个 org');
  assert.equal(listedB[0]?.organizationId, createdB.organization.organizationId, 'org id 匹配');
  /* 用 tA（→s0）以同一 userId 查：s0 根本没这行 → 空（不串 shard）。 */
  assert.equal(svc.listByUser('tA', 'userB').length, 0, '用 tA（→s0）查 userB 的 org：查不到（不串 shard）');
  /* 物理断言：org 行只在 s1（B 的 shard）、s0 无（防「都落 s0」的 shard 路由 bug）。 */
  assert.ok(s1.prepare(`SELECT 1 FROM organizations WHERE id = ?`).get(createdB.organization.organizationId), 'B 的 org 行在 s1');
  assert.equal(s0.prepare(`SELECT 1 FROM organizations WHERE id = ?`).get(createdB.organization.organizationId), undefined, 's0 无 B 的 org 行');
  s0.close(); s1.close(); coord.close();
});

test('OrganizationService tenant predicate：共享物理 db 只种 B 的 org，用 tA listByUser/listMembers 均不命中（防同库跨租户）', () => {
  /* 单一物理 db，A/B 同库（SingleDbResolver 模拟同 shard 内多租户）。只种 B 的 org。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const svc = new OrganizationService(resolver);
  seedUser(db, 'userSharedB', 'tB');
  const createdB = svc.create('tB', 'userSharedB', { name: 'B 独占公司', defaultWorkspaceName: 'B 空间' });
  const orgId = createdB.organization.organizationId;
  /* listByUser：用 tA + B 的 userId → 空（membership.tenant_id=? predicate 隔离）。 */
  assert.equal(svc.listByUser('tA', 'userSharedB').length, 0, 'tA listByUser tB 的 userId → 空（tenant predicate 隔离）');
  assert.ok(svc.listByUser('tB', 'userSharedB').length >= 1, 'tB 自己查得到');
  /* listMembers：用 tA + B 的 orgId → 空（memberships.tenant_id=? predicate 隔离）。 */
  assert.equal(svc.listMembers('tA', orgId).length, 0, 'tA listMembers tB 的 org → 空（tenant predicate 隔离）');
  assert.ok(svc.listMembers('tB', orgId).length >= 1, 'tB 自己 listMembers 有成员');
  db.close();
});

/* ── AdminControlPlane 组（Task 5）：persona_core/marketplace_tasks/persona_wallets/governance_cases
 *    全有 tenant_id 列 → 每 count/list/summary query WHERE tenant_id=? predicate（executor 已含）。
 *    方法已带 tenantId，仅 ctor (tx)→(resolver) + 每方法 dbForTenant(tenantId)。 ── */

/** 在指定 db 种一条 persona_core 行（tenant + owner），供 listPersonas 断言用。 */
function seedPersona(db: IDatabase, id: string, tenantId: string, ownerUserId: string): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO persona_core (
      id, tenant_id, owner_user_id, display_name, profile_json, status, visibility,
      growth_index, reputation, training_investment, created_at, updated_at, deceased_at, transferred_at, lifecycle_status
    ) VALUES (?, ?, ?, ?, '{}', 'active', 'private', 0, 0, 0, ?, ?, NULL, NULL, 'active')`,
  ).run(id, tenantId, ownerUserId, `persona_${id}`, now, now);
}

test('AdminControlPlaneService per-tenant：B 的 persona 落 s1（非 home），用 tA listPersonas 数不到（选对 shard + tenant predicate）', () => {
  const s0 = idDb(), s1 = idDb(), coord = idDb();
  /* A→s0（home），B→s1（非 home）——刻意让 B 映射到非 home，才能被 mutation① 换 home 揪出。 */
  const resolver = new FakeMultiShardResolver({ coordinator: coord, shards: { s0, s1 }, tenantToShard: { tA: 's0', tB: 's1' } });
  const svc = new AdminControlPlaneService(resolver);
  /* B（非 home 租户）的 persona 直接种在自己 shard s1（owner_user_id 有 FK → 先种 users）。 */
  seedUser(s1, 'ownerB', 'tB');
  seedPersona(s1, 'persB', 'tB', 'ownerB');
  /* 用 tB（→s1）listPersonas 数得到。 */
  const listedB = svc.listPersonas('tB', { page: 1, pageSize: 20 });
  assert.equal(listedB.pagination.total, 1, 'B 在自己 shard（s1）数到 1 个 persona');
  assert.equal(listedB.data[0]?.personaId, 'persB', 'persona id 匹配');
  /* 用 tA（→s0）listPersonas：s0 根本没这行 → 0（不串 shard）。 */
  const listedA = svc.listPersonas('tA', { page: 1, pageSize: 20 });
  assert.equal(listedA.pagination.total, 0, '用 tA（→s0）listPersonas：数不到（不串 shard）');
  assert.equal(listedA.data.length, 0, 'tA 结果集为空');
  s0.close(); s1.close(); coord.close();
});

test('AdminControlPlaneService tenant predicate：共享物理 db，A/B 各种 persona，tA listPersonas 只数得到属 tA 的（防同库跨租户）', () => {
  /* 单一物理 db，A/B 同库（SingleDbResolver 模拟同 shard 内多租户）。A/B 各种一个 persona。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const svc = new AdminControlPlaneService(resolver);
  seedUser(db, 'ownerA', 'tA');
  seedUser(db, 'ownerB', 'tB');
  seedPersona(db, 'persA', 'tA', 'ownerA');
  seedPersona(db, 'persB', 'tB', 'ownerB');
  /* 用 tA listPersonas：tenant predicate（WHERE pc.tenant_id='tA'）→ 只数到 persA。 */
  const listedA = svc.listPersonas('tA', { page: 1, pageSize: 20 });
  assert.equal(listedA.pagination.total, 1, 'tA 只数到属 tA 的 1 个 persona（不串 tB）');
  assert.equal(listedA.data[0]?.personaId, 'persA', 'tA 数到的是 persA');
  assert.equal(listedA.summary.total, 1, 'tA summary total=1（tenant predicate 隔离）');
  /* 对称：用 tB listPersonas → 只数到 persB。 */
  const listedB = svc.listPersonas('tB', { page: 1, pageSize: 20 });
  assert.equal(listedB.pagination.total, 1, 'tB 只数到属 tB 的 1 个 persona');
  assert.equal(listedB.data[0]?.personaId, 'persB', 'tB 数到的是 persB');
  db.close();
});

/* ── KnowledgeSource 组（Task 5）：knowledge_sources 表有 tenant_id 列 → 每 query WHERE tenant_id=? predicate
 *    （executor 已含）。方法已带 tenantId，仅 ctor (tx)→(resolver) + 每方法经 dbForTenant(tenantId) 造 store。 ── */

test('KnowledgeSourceService per-tenant：B create 知识源经 service 落 s1（非 home），用 tA list/getById 查不到（选对 shard + tenant predicate）', () => {
  const s0 = idDb(), s1 = idDb(), coord = idDb();
  /* A→s0（home），B→s1（非 home）——刻意让 B 映射到非 home，才能被 mutation① 换 home 揪出。 */
  const resolver = new FakeMultiShardResolver({ coordinator: coord, shards: { s0, s1 }, tenantToShard: { tA: 's0', tB: 's1' } });
  const svc = new KnowledgeSourceService(resolver);
  /* B（非 home 租户）的知识源经 service 建（必须由 dbForTenant 选对 s1）。 */
  const createdB = svc.create('tB', { type: 'rss', name: 'B 的 RSS 源', config: { url: 'https://b.example/feed' } });
  /* B 在自己 shard（s1）list/getById 查得到。 */
  assert.equal(svc.list('tB', 1, 20).pagination.total, 1, 'B 在自己 shard（s1）list 到 1 条');
  assert.ok(svc.getById('tB', createdB.id), 'B getById 查得到自己的知识源');
  /* 用 tA（→s0）list：s0 根本没这行 → 0（不串 shard）。 */
  assert.equal(svc.list('tA', 1, 20).pagination.total, 0, '用 tA（→s0）list：查不到（不串 shard）');
  /* 物理断言：知识源行只在 s1（B 的 shard）、s0 无（防「都落 s0」的 shard 路由 bug）。 */
  assert.ok(s1.prepare(`SELECT 1 FROM knowledge_sources WHERE id = ?`).get(createdB.id), 'B 的知识源行在 s1');
  assert.equal(s0.prepare(`SELECT 1 FROM knowledge_sources WHERE id = ?`).get(createdB.id), undefined, 's0 无 B 的知识源行');
  s0.close(); s1.close(); coord.close();
});

test('KnowledgeSourceService tenant predicate：共享物理 db 只种 B 的知识源，用 tA getById/update/delete 均不命中（防同库跨租户）', () => {
  /* 单一物理 db，A/B 同库（SingleDbResolver 模拟同 shard 内多租户）。只种 B 的知识源。 */
  const db = idDb();
  const resolver = new SingleDbResolver(db);
  const svc = new KnowledgeSourceService(resolver);
  const createdB = svc.create('tB', { type: 'rss', name: 'B 独占源', config: { url: 'https://b.example/feed' } });
  /* getById：用 tA 查 B 的 sourceId → 抛 NotFound（tenant predicate 隔离）。 */
  assert.throws(
    () => svc.getById('tA', createdB.id),
    /不存在|NOT_FOUND/i,
    'tA getById tB 的知识源 → NotFound（tenant predicate 隔离）',
  );
  assert.ok(svc.getById('tB', createdB.id), 'tB 自己查得到');
  /* update：用 tA 改 B 的 sourceId → 抛 NotFound（不误改 B 的行）。 */
  assert.throws(
    () => svc.update('tA', createdB.id, { name: '越权改名' }),
    /不存在|NOT_FOUND/i,
    'tA update tB 的知识源 → NotFound（tenant predicate 隔离）',
  );
  assert.equal(svc.getById('tB', createdB.id).name, 'B 独占源', 'B 的知识源名未被越权改动');
  /* delete：用 tA 删 B 的 sourceId → 抛 NotFound（不误删 B 的行）。 */
  assert.throws(
    () => svc.delete('tA', createdB.id),
    /不存在|NOT_FOUND/i,
    'tA delete tB 的知识源 → NotFound（tenant predicate 隔离）',
  );
  assert.ok(svc.getById('tB', createdB.id), 'tA 越权删除失败后 B 的知识源仍在');
  db.close();
});
