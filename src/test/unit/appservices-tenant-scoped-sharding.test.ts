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
