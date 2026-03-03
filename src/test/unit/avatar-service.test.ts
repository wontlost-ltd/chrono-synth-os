import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { IdentityService } from '../../identity/identity-service.js';
import { AvatarService } from '../../identity/avatar-service.js';

describe('AvatarService', () => {
  let db: IDatabase;
  let identityService: IdentityService;
  let avatarService: AvatarService;
  let identityId: string;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    identityService = new IdentityService(db);
    avatarService = new AvatarService(db);
    const identity = identityService.create('user_1', 'tenant_1', '测试用户');
    identityId = identity.id;
  });

  it('创建分身', () => {
    const avatar = avatarService.create(identityId, { label: '工作模式', kind: 'work' });
    assert.equal(avatar.label, '工作模式');
    assert.equal(avatar.kind, 'work');
    assert.equal(avatar.isDefault, false);
    assert.equal(avatar.isActive, true);
  });

  it('listByIdentity 包含默认分身和自定义分身', () => {
    avatarService.create(identityId, { label: '社交模式', kind: 'social' });
    const avatars = avatarService.listByIdentity(identityId);
    assert.equal(avatars.length, 2);
    assert.ok(avatars.some(a => a.isDefault));
    assert.ok(avatars.some(a => a.label === '社交模式'));
  });

  it('getById 返回正确分身', () => {
    const created = avatarService.create(identityId, { label: '创意模式' });
    const found = avatarService.getById(created.id);
    assert.ok(found);
    assert.equal(found!.label, '创意模式');
  });

  it('getById 不存在时返回 null', () => {
    assert.equal(avatarService.getById('nonexistent'), null);
  });

  it('更新分身', () => {
    const avatar = avatarService.create(identityId, { label: '旧名' });
    const updated = avatarService.update(avatar.id, { label: '新名', kind: 'family' });
    assert.ok(updated);
    assert.equal(updated!.label, '新名');
    assert.equal(updated!.kind, 'family');
  });

  it('更新分身行为覆盖', () => {
    const avatar = avatarService.create(identityId, { label: '测试' });
    const updated = avatarService.update(avatar.id, {
      behaviorOverrides: { valueWeightAdjustments: { v1: 0.1 } },
    });
    assert.ok(updated);
    assert.deepEqual(updated!.behaviorOverrides?.valueWeightAdjustments, { v1: 0.1 });
  });

  it('软删除分身', () => {
    const avatar = avatarService.create(identityId, { label: '临时' });
    assert.ok(avatarService.softDelete(avatar.id));
    assert.equal(avatarService.getById(avatar.id), null);
  });

  it('不允许删除默认分身', () => {
    const defaultAvatar = avatarService.getDefault(identityId);
    assert.ok(defaultAvatar);
    assert.equal(avatarService.softDelete(defaultAvatar!.id), false);
  });

  it('countActive 正确计数', () => {
    assert.equal(avatarService.countActive(identityId), 1); /* 默认分身 */
    avatarService.create(identityId, { label: '额外1' });
    avatarService.create(identityId, { label: '额外2' });
    assert.equal(avatarService.countActive(identityId), 3);
  });

  it('getDefault 返回默认分身', () => {
    const def = avatarService.getDefault(identityId);
    assert.ok(def);
    assert.equal(def!.isDefault, true);
    assert.equal(def!.label, '默认');
  });
});
