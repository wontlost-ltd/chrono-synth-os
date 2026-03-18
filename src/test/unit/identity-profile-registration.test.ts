import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENT_QUERY_BY_USER, IDENT_QUERY_BY_ID, IDENT_QUERY_BY_TENANT,
  IDENT_CMD_CREATE, IDENT_CMD_CREATE_DEFAULT_AVATAR, IDENT_CMD_UPDATE,
  UPROF_QUERY_BY_ID, UPROF_QUERY_BY_EMAIL_EXCLUDE, UPROF_QUERY_FULL_BY_ID,
  UPROF_CMD_UPDATE_EMAIL, UPROF_CMD_UPDATE_PASSWORD,
} from '@chrono/kernel';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveQueryExecutor, resolveCommandExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import { UserProfileService } from '../../identity/user-profile-service.js';
import type { IDatabase } from '../../storage/database.js';
import { hash } from '@node-rs/argon2';

function seedUser(db: IDatabase, userId: string, email: string, passwordHash: string): void {
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, 'member', 'tenant-test', ?, ?)`,
  ).run(userId, email, passwordHash, Date.now(), Date.now());
}

describe('IdentityService 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部 Identity query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(IDENT_QUERY_BY_USER));
    assert.ok(resolveQueryExecutor(IDENT_QUERY_BY_ID));
    assert.ok(resolveQueryExecutor(IDENT_QUERY_BY_TENANT));
    assert.ok(resolveCommandExecutor(IDENT_CMD_CREATE));
    assert.ok(resolveCommandExecutor(IDENT_CMD_CREATE_DEFAULT_AVATAR));
    assert.ok(resolveCommandExecutor(IDENT_CMD_UPDATE));
  });
});

describe('UserProfileService 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部 UserProfile query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();

    assert.ok(resolveQueryExecutor(UPROF_QUERY_BY_ID));
    assert.ok(resolveQueryExecutor(UPROF_QUERY_BY_EMAIL_EXCLUDE));
    assert.ok(resolveQueryExecutor(UPROF_QUERY_FULL_BY_ID));
    assert.ok(resolveCommandExecutor(UPROF_CMD_UPDATE_EMAIL));
    assert.ok(resolveCommandExecutor(UPROF_CMD_UPDATE_PASSWORD));
  });

  it('getProfile 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    seedUser(db, 'user-1', 'test@example.com', 'hash');
    const service = new UserProfileService(db);

    const profile = service.getProfile('user-1');
    assert.equal(profile.userId, 'user-1');
    assert.equal(profile.email, 'test@example.com');
    assert.equal(profile.role, 'member');
  });

  it('updateEmail 通过 data plane 契约工作', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    seedUser(db, 'user-1', 'old@example.com', 'hash');
    const service = new UserProfileService(db);

    const updated = service.updateEmail('user-1', 'new@example.com');
    assert.equal(updated.email, 'new@example.com');
  });

  it('updateEmail 重复邮箱抛出错误', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    seedUser(db, 'user-1', 'a@example.com', 'hash');
    seedUser(db, 'user-2', 'b@example.com', 'hash');
    const service = new UserProfileService(db);

    assert.throws(() => service.updateEmail('user-1', 'b@example.com'), /已被使用/);
  });

  it('changePassword 验证旧密码并更新', async () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const pwHash = await hash('oldPassword123');
    seedUser(db, 'user-1', 'test@example.com', pwHash);
    const service = new UserProfileService(db);

    const result = await service.changePassword('user-1', 'oldPassword123', 'newPassword456');
    assert.deepEqual(result, { success: true });
  });
});
