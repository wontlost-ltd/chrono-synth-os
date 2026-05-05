import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AVT_QUERY_BY_ID, AVT_QUERY_BY_ID_IDENTITY, AVT_QUERY_BY_IDENTITY,
  AVT_QUERY_DEFAULT, AVT_QUERY_COUNT_ACTIVE,
  AVT_CMD_CREATE, AVT_CMD_UPDATE, AVT_CMD_UPDATE_FOR_IDENTITY,
  AVT_CMD_SOFT_DELETE, AVT_CMD_SOFT_DELETE_FOR_IDENTITY,
  QUOTA_QUERY_LIMIT, QUOTA_QUERY_USAGE,
  QUOTA_CMD_SET_LIMIT, QUOTA_CMD_CLEAR_LIMIT,
  QUOTA_CMD_CONSUME, QUOTA_CMD_RECORD_USAGE,
} from '@chrono/kernel';
import { AvatarService } from '../../identity/avatar-service.js';
import { QuotaManager } from '../../multi-tenant/quota-manager.js';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveQueryExecutor, resolveCommandExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

function seedIdentity(db: IDatabase, identityId: string): void {
  db.prepare<void>(
    `INSERT OR IGNORE INTO identities (id, user_id, tenant_id, display_name, created_at, updated_at)
     VALUES (?, ?, 'tenant-test', 'Test', ?, ?)`,
  ).run(identityId, `user-${identityId}`, Date.now(), Date.now());
}

describe('AvatarService 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部 AvatarService query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(AVT_QUERY_BY_ID));
    assert.ok(resolveQueryExecutor(AVT_QUERY_BY_ID_IDENTITY));
    assert.ok(resolveQueryExecutor(AVT_QUERY_BY_IDENTITY));
    assert.ok(resolveQueryExecutor(AVT_QUERY_DEFAULT));
    assert.ok(resolveQueryExecutor(AVT_QUERY_COUNT_ACTIVE));
    assert.ok(resolveCommandExecutor(AVT_CMD_CREATE));
    assert.ok(resolveCommandExecutor(AVT_CMD_UPDATE));
    assert.ok(resolveCommandExecutor(AVT_CMD_UPDATE_FOR_IDENTITY));
    assert.ok(resolveCommandExecutor(AVT_CMD_SOFT_DELETE));
    assert.ok(resolveCommandExecutor(AVT_CMD_SOFT_DELETE_FOR_IDENTITY));
  });

  it('create 和 getById 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    seedIdentity(db, 'identity-1');
    const service = new AvatarService(db);

    const avatar = service.create('identity-1', { label: '测试分身' });
    assert.equal(avatar.identityId, 'identity-1');
    assert.equal(avatar.label, '测试分身');
    assert.equal(avatar.kind, 'general');
    assert.equal(avatar.isActive, true);

    const fetched = service.getById(avatar.id);
    assert.ok(fetched);
    assert.equal(fetched.label, '测试分身');
  });

  it('update 和 softDelete 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    seedIdentity(db, 'identity-1');
    const service = new AvatarService(db);

    const avatar = service.create('identity-1', { label: '原始' });
    const updated = service.update(avatar.id, { label: '更新后' });
    assert.ok(updated);
    assert.equal(updated.label, '更新后');

    const deleted = service.softDelete(avatar.id);
    assert.equal(deleted, true);

    const gone = service.getById(avatar.id);
    assert.equal(gone, null);
  });

  it('listByIdentity 和 countActive 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    seedIdentity(db, 'identity-1');
    seedIdentity(db, 'identity-2');
    const service = new AvatarService(db);

    service.create('identity-1', { label: '分身A' });
    service.create('identity-1', { label: '分身B' });
    service.create('identity-2', { label: '其他租户' });

    const list = service.listByIdentity('identity-1');
    assert.equal(list.length, 2);

    const count = service.countActive('identity-1');
    assert.equal(count, 2);
  });
});

describe('QuotaManager 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部 QuotaManager query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(QUOTA_QUERY_LIMIT));
    assert.ok(resolveQueryExecutor(QUOTA_QUERY_USAGE));
    assert.ok(resolveCommandExecutor(QUOTA_CMD_SET_LIMIT));
    assert.ok(resolveCommandExecutor(QUOTA_CMD_CLEAR_LIMIT));
    assert.ok(resolveCommandExecutor(QUOTA_CMD_CONSUME));
    assert.ok(resolveCommandExecutor(QUOTA_CMD_RECORD_USAGE));
  });

  it('setLimit 和 checkQuota 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const quota = new QuotaManager(db);

    quota.setLimit('tenant-a', 'api_calls', 100, 60_000);
    assert.equal(quota.checkQuota('tenant-a', 'api_calls', 1), true);
    assert.equal(quota.checkQuota('tenant-a', 'api_calls', 101), false);
  });

  it('consumeQuota 原子消费与上限检查', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const quota = new QuotaManager(db);
    const now = 120_000;

    quota.setLimit('tenant-a', 'tokens', 10, 60_000);

    assert.equal(quota.consumeQuota('tenant-a', 'tokens', 5, now), true);
    assert.equal(quota.consumeQuota('tenant-a', 'tokens', 5, now), true);
    assert.equal(quota.consumeQuota('tenant-a', 'tokens', 1, now), false);
  });

  it('窗口滚动后配额重置', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const quota = new QuotaManager(db);
    const windowMs = 60_000;

    quota.setLimit('tenant-a', 'tokens', 5, windowMs);

    const window1Start = 120_000;
    assert.equal(quota.consumeQuota('tenant-a', 'tokens', 5, window1Start), true);
    assert.equal(quota.checkQuota('tenant-a', 'tokens', 1, window1Start), false);

    const window2Start = window1Start + windowMs;
    assert.equal(quota.checkQuota('tenant-a', 'tokens', 1, window2Start), true);
    assert.equal(quota.consumeQuota('tenant-a', 'tokens', 3, window2Start), true);
    assert.equal(quota.checkQuota('tenant-a', 'tokens', 3, window2Start), false);
  });

  it('clearLimit 允许无限消费', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const quota = new QuotaManager(db);

    quota.setLimit('tenant-a', 'api_calls', 1, 60_000);
    quota.clearLimit('tenant-a', 'api_calls');
    assert.equal(quota.checkQuota('tenant-a', 'api_calls', 9999), true);
  });
});
