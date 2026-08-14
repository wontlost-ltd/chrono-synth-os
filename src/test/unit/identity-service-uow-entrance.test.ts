/**
 * 单元测试：identity 模块 service 双入口（Phase 2 批次 2 验收）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { IdentityService } from '../../identity/identity-service.js';
import { AvatarService } from '../../identity/avatar-service.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
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
    runDslSqliteMigrations(db);
    try {
      seedUser(db, 'user_a', 'a@x.com');
      const fromDb = new IdentityService(new SingleDbResolver(db));
      const ident = fromDb.create('default', 'user_a', 'A');
      assert.ok(ident.id);

      seedUser(db, 'user_b', 'b@x.com');
      const fromUow = new IdentityService(new SingleDbResolver(db));
      const ident2 = fromUow.create('default', 'user_b', 'B');
      assert.ok(ident2.id);

      const list = fromUow.listByTenant('default');
      assert.equal(list.length, 2);
    } finally { db.close(); }
  });

  it('AvatarService 双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      seedUser(db, 'user_av', 'av@x.com');
      const ident = new IdentityService(new SingleDbResolver(db)).create('default', 'user_av', 'Av');

      /* 分片 Plan 1b（Task 2）：AvatarService ctor 收 resolver，方法首参加 tenantId。 */
      const fromDb = new AvatarService(new SingleDbResolver(db));
      const fromUow = new AvatarService(new SingleDbResolver(db));
      assert.ok(fromDb.getDefault('default', ident.id));
      assert.ok(fromUow.getDefault('default', ident.id));
    } finally { db.close(); }
  });

  it('DeviceAvatarService 双入口：activate 多步原子（IDatabase 路径走 db.transaction）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      seedUser(db, 'user_da', 'da@x.com');
      const ident = new IdentityService(new SingleDbResolver(db)).create('default', 'user_da', 'DA');
      const avatarSvc = new AvatarService(new SingleDbResolver(db));
      const av1 = avatarSvc.create('default', ident.id, { label: 'A1' });

      const now = Date.now();
      db.prepare<void>(
        `INSERT INTO devices (id, tenant_id, user_id, device_uid, platform, last_seen_at, created_at)
         VALUES (?, 'default', 'user_da', 'duid', 'web', ?, ?)`,
      ).run('dev1', now, now);

      /* 分片 Plan 1b（Task 2）：DeviceAvatarService ctor 收 resolver，方法首参加 tenantId（两端验）。 */
      const svc = new DeviceAvatarService(new SingleDbResolver(db));
      svc.install('default', 'dev1', av1.id);
      assert.equal(svc.activate('default', 'dev1', av1.id), true);

      const svcUow = new DeviceAvatarService(new SingleDbResolver(db));
      assert.equal(svcUow.isInstalled('default', 'dev1', av1.id), true);
    } finally { db.close(); }
  });

  it('AvatarSnapshotService 接受双入口；SsoUserService（Task 6）/CollaborationService（Task 4）/MobileDeviceService（Task 3）/UserProfileService（Task 7）已 resolver 化', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const uow = db;
      /* 分片 Plan 1b（Task 4）：CollaborationService 已 resolver 化——不再接裸 db/uow，而收 TenantDbResolver。 */
      assert.ok(new CollaborationService(new SingleDbResolver(db)));
      /* 分片 Plan 1b（Task 7）：UserProfileService 已 resolver 化——不再接裸 db/uow，而收 TenantDbResolver。 */
      assert.ok(new UserProfileService(new SingleDbResolver(db)));
      /* 分片 Plan 1b（Task 3）：MobileDeviceService 已 resolver 化——不再接裸 db/uow，而收 TenantDbResolver。 */
      assert.ok(new MobileDeviceService(new SingleDbResolver(db)));
      assert.ok(new AvatarSnapshotService(db));
      assert.ok(new AvatarSnapshotService(uow));
      /* 分片 Plan 1c（Task 6）：SsoUserService 已 resolver 化——收 TenantDbResolver，SSO/OIDC 经
       * 协调库目录定位 email→tenant 再写 shard。 */
      assert.ok(new SsoUserService(new SingleDbResolver(db)));
      assert.ok(new SsoUserService(new SingleDbResolver(uow)));
    } finally { db.close(); }
  });
});
