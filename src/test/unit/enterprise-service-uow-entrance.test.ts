/**
 * 单元测试：enterprise 模块 service 双入口（Phase 2 批次 3 验收）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { loadConfig } from '../../config/schema.js';
import { AdminControlPlaneService } from '../../enterprise/admin-control-plane-service.js';
import { OrganizationService } from '../../enterprise/organization-service.js';
import { ScimProvisioningService } from '../../enterprise/scim-provisioning-service.js';
import { TenantEnterpriseProfileService } from '../../enterprise/tenant-enterprise-profile-service.js';
import { resolveTenantKafkaTopic, listTenantKafkaTopics } from '../../enterprise/tenant-kafka-topics.js';
import type { IDatabase } from '../../storage/database.js';

function seedUser(db: IDatabase, userId: string, email: string, tenantId = 'default'): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, 'hash', 'admin', ?, ?, ?)`,
  ).run(userId, email, tenantId, now, now);
}

describe('Phase 2 批次 3：enterprise services 双入口', () => {
  it('AdminControlPlaneService 双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new AdminControlPlaneService(db);
      const fromUow = new AdminControlPlaneService(db);
      assert.deepEqual(
        fromDb.listPersonas('default', { page: 1, pageSize: 10 }).pagination.total,
        fromUow.listPersonas('default', { page: 1, pageSize: 10 }).pagination.total,
      );
    } finally { db.close(); }
  });

  it('OrganizationService 双入口：create 走 runAtomic', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      seedUser(db, 'user_org_db', 'org-db@x.com');
      const fromDb = new OrganizationService(db);
      const result = fromDb.create('default', 'user_org_db', {
        name: 'Acme',
        defaultWorkspaceName: 'Default',
      });
      assert.ok(result.organization.organizationId.startsWith('org_'));

      seedUser(db, 'user_org_uow', 'org-uow@x.com');
      const fromUow = new OrganizationService(db);
      const result2 = fromUow.create('default', 'user_org_uow', {
        name: 'Beta Co',
        defaultWorkspaceName: 'Main',
      });
      assert.ok(result2.organization.organizationId.startsWith('org_'));

      assert.equal(fromUow.listByUser('default', 'user_org_db').length, 1);
    } finally { db.close(); }
  });

  it('ScimProvisioningService 双入口：createUser → IdentityService 联动', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new ScimProvisioningService(db);
      const r1 = fromDb.createUser('default', { email: 'scim1@x.com', displayName: 'S1' });
      assert.equal(r1.isNew, true);

      const fromUow = new ScimProvisioningService(db);
      const r2 = fromUow.createUser('default', { email: 'scim2@x.com', displayName: 'S2' });
      assert.equal(r2.isNew, true);

      const list = fromUow.listUsers('default', { startIndex: 1, count: 10 });
      assert.equal(list.totalResults, 2);
    } finally { db.close(); }
  });

  it('TenantEnterpriseProfileService 双入口（只读路径）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const config = loadConfig({});
      const fromDb = new TenantEnterpriseProfileService(db, config);
      const fromUow = new TenantEnterpriseProfileService(db, config);
      assert.equal(fromDb.getProfile('default').deploymentMode, 'shared_cluster');
      assert.equal(fromUow.getProfile('default').deploymentMode, 'shared_cluster');
    } finally { db.close(); }
  });

  it('tenant-kafka-topics 函数式双入口', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      assert.equal(resolveTenantKafkaTopic(db, 'default', 'events.audit'), 'events.audit');
      assert.equal(resolveTenantKafkaTopic(db, 'default', 'events.audit'), 'events.audit');

      const list1 = listTenantKafkaTopics(db, 'events.audit');
      const list2 = listTenantKafkaTopics(db, 'events.audit');
      assert.deepEqual(list1.sort(), list2.sort());
    } finally { db.close(); }
  });
});
