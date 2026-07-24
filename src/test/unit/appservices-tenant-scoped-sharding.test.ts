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
