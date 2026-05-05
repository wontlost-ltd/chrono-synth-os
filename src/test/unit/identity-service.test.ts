import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { IdentityService } from '../../identity/identity-service.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';

describe('IdentityService', () => {
  let db: IDatabase;
  let svc: IdentityService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    svc = new IdentityService(directUnitOfWork(db));
  });

  it('创建身份并同时生成默认分身', () => {
    const identity = svc.create('user_1', 'tenant_1', '测试用户');
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
    svc.create('user_2', 'tenant_2', '用户二');
    const found = svc.getByUser('user_2');
    assert.ok(found);
    assert.equal(found!.userId, 'user_2');
  });

  it('getByUser 查询不存在的用户返回 null', () => {
    const result = svc.getByUser('nonexistent');
    assert.equal(result, null);
  });

  it('listByTenant 返回同租户的多个身份', () => {
    svc.create('user_3a', 'tenant_3', '用户三A');
    svc.create('user_3b', 'tenant_3', '用户三B');
    const found = svc.listByTenant('tenant_3');
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((item) => item.userId), ['user_3a', 'user_3b']);
  });

  it('更新身份元数据', () => {
    const identity = svc.create('user_4', 'tenant_4', '原名');
    const updated = svc.update(identity.id, { displayName: '新名', bio: '简介' });
    assert.ok(updated);
    assert.equal(updated!.displayName, '新名');
    assert.equal(updated!.bio, '简介');
  });

  it('更新不存在的身份返回 null', () => {
    const result = svc.update('nonexistent', { displayName: '名字' });
    assert.equal(result, null);
  });

  it('ensureForUser 对已存在用户返回原 identity', () => {
    const created = svc.create('user_5', 'tenant_5', '用户五');
    const ensured = svc.ensureForUser('user_5', 'tenant_5', '不会覆盖');
    assert.equal(ensured.id, created.id);
    assert.equal(ensured.displayName, '用户五');
  });
});
