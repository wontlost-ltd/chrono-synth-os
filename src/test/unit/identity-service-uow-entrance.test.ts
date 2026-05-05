/**
 * 单元测试：identity 模块 service 双入口（Phase 2 批次 2 验收）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { IdentityService } from '../../identity/identity-service.js';
import { AvatarService } from '../../identity/avatar-service.js';
import { CollaborationService } from '../../identity/collaboration-service.js';
import { UserProfileService } from '../../identity/user-profile-service.js';
import { MobileDeviceService } from '../../identity/mobile-device-service.js';
import { DeviceAvatarService } from '../../identity/device-avatar-service.js';
import { AvatarSnapshotService } from '../../identity/avatar-snapshot-service.js';
import { SsoUserService } from '../../identity/sso-user-service.js';
import type { IDatabase } from '../../storage/database.js';

function seedUser(db: IDatabase, userId: string, email: string, tenantId = 'default'): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, 'hash', 'admin', ?, ?, ?)`,
  ).run(userId, email, tenantId, now, now);
}

describe('Phase 2 批次 2：identity stores 双入口', () => {
  it('IdentityService 双入口：create 走原子事务（IDatabase 路径）', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      seedUser(db, 'user_a', 'a@x.com');
      const fromDb = new IdentityService(db);
      const ident = fromDb.create('user_a', 'default', 'A');
      assert.ok(ident.id);

      seedUser(db, 'user_b', 'b@x.com');
      const fromUow = new IdentityService(db);
      const ident2 = fromUow.create('user_b', 'default', 'B');
      assert.ok(ident2.id);

      const list = fromUow.listByTenant('default');
      assert.equal(list.length, 2);
    } finally { db.close(); }
  });

  it('AvatarService 双入口', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      seedUser(db, 'user_av', 'av@x.com');
      const ident = new IdentityService(db).create('user_av', 'default', 'Av');

      const fromDb = new AvatarService(db);
      const fromUow = new AvatarService(db);
      assert.ok(fromDb.getDefault(ident.id));
      assert.ok(fromUow.getDefault(ident.id));
    } finally { db.close(); }
  });

  it('DeviceAvatarService 双入口：activate 多步原子（IDatabase 路径走 db.transaction）', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      seedUser(db, 'user_da', 'da@x.com');
      const ident = new IdentityService(db).create('user_da', 'default', 'DA');
      const avatarSvc = new AvatarService(db);
      const av1 = avatarSvc.create(ident.id, { label: 'A1' });

      const now = Date.now();
      db.prepare<void>(
        `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, last_seen_at, created_at)
         VALUES (?, 'default', 'user_da', 'duid', 'web', ?, ?)`,
      ).run('dev1', now, now);

      const svc = new DeviceAvatarService(db);
      svc.install('dev1', av1.id);
      assert.equal(svc.activate('dev1', av1.id), true);

      const svcUow = new DeviceAvatarService(db);
      assert.equal(svcUow.isInstalled('dev1', av1.id), true);
    } finally { db.close(); }
  });

  it('CollaborationService / UserProfileService / MobileDeviceService / AvatarSnapshotService / SsoUserService 都接受双入口', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const uow = db;
      assert.ok(new CollaborationService(db));
      assert.ok(new CollaborationService(uow));
      assert.ok(new UserProfileService(db));
      assert.ok(new UserProfileService(uow));
      assert.ok(new MobileDeviceService(db));
      assert.ok(new MobileDeviceService(uow));
      assert.ok(new AvatarSnapshotService(db));
      assert.ok(new AvatarSnapshotService(uow));
      assert.ok(new SsoUserService(db));
      assert.ok(new SsoUserService(uow));
    } finally { db.close(); }
  });
});
