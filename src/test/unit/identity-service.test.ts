import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { IdentityService } from '../../identity/identity-service.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';

describe('IdentityService', () => {
  let db: IDatabase;
  let svc: IdentityService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    /* 分片 Plan 1b：IdentityService ctor 收 TenantDbResolver（单库 SingleDbResolver 零回归）；
     * 方法首参为 tenantId（tenant-bound writer 内部按 dbForTenant 路由 + SQL tenant predicate）。 */
    svc = new IdentityService(new SingleDbResolver(db));
  });

  it('创建身份并同时生成默认分身', () => {
    const identity = svc.create('tenant_1', 'user_1', '测试用户');
    assert.equal(identity.userId, 'user_1');
    assert.equal(identity.tenantId, 'tenant_1');
    assert.equal(identity.displayName, '测试用户');
    assert.equal(identity.bio, null);

    /* 验证默认分身已创建 */
    const avatar = db.prepare<{ id: string; identity_id: string; is_default: number }>(
      'SELECT id, identity_id, is_default FROM avatars WHERE identity_id = ?',
    ).get(identity.id);
    assert.ok(avatar);
    assert.equal(avatar!.identity_id, identity.id);
    assert.equal(avatar!.is_default, 1);
  });

  it('getByUser 返回正确身份', () => {
    svc.create('tenant_2', 'user_2', '用户二');
    const found = svc.getByUser('tenant_2', 'user_2');
    assert.ok(found);
    assert.equal(found!.userId, 'user_2');
  });

  it('getByUser 查询不存在的用户返回 null', () => {
    const result = svc.getByUser('tenant_2', 'nonexistent');
    assert.equal(result, null);
  });

  it('getByUser 用错租户查已存在用户返回 null（tenant predicate 隔离）', () => {
    svc.create('tenant_2', 'user_2', '用户二');
    assert.equal(svc.getByUser('tenant_other', 'user_2'), null);
  });

  it('listByTenant 返回同租户的多个身份', () => {
    svc.create('tenant_3', 'user_3a', '用户三A');
    svc.create('tenant_3', 'user_3b', '用户三B');
    const found = svc.listByTenant('tenant_3');
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((item) => item.userId), ['user_3a', 'user_3b']);
  });

  it('更新身份元数据', () => {
    const identity = svc.create('tenant_4', 'user_4', '原名');
    const updated = svc.update('tenant_4', identity.id, { displayName: '新名', bio: '简介' });
    assert.ok(updated);
    assert.equal(updated!.displayName, '新名');
    assert.equal(updated!.bio, '简介');
  });

  it('更新不存在的身份返回 null', () => {
    const result = svc.update('tenant_4', 'nonexistent', { displayName: '名字' });
    assert.equal(result, null);
  });

  it('用错租户更新已存在身份返回 null（tenant predicate 隔离）', () => {
    const identity = svc.create('tenant_4', 'user_4', '原名');
    assert.equal(svc.update('tenant_other', identity.id, { displayName: '越权' }), null);
  });

  it('ensureForUser 对已存在用户返回原 identity', () => {
    const created = svc.create('tenant_5', 'user_5', '用户五');
    const ensured = svc.ensureForUser('tenant_5', 'user_5', '不会覆盖');
    assert.equal(ensured.id, created.id);
    assert.equal(ensured.displayName, '用户五');
  });
});
