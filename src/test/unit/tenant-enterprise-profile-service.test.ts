import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { loadConfig } from '../../config/schema.js';
import { TenantEnterpriseProfileService } from '../../enterprise/tenant-enterprise-profile-service.js';

describe('TenantEnterpriseProfileService', () => {
  it('字段加密关闭时允许保存任意 tenant-dedicated kmsKeyRef', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    const config = loadConfig({
      server: { publicUrl: 'https://api.example.test' },
      encryption: {
        enabled: false,
      },
    });
    const service = new TenantEnterpriseProfileService(db, config);

    const profile = service.upsertProfile('tenant_local', {
      deploymentMode: 'dedicated_db',
      databaseIsolationMode: 'dedicated',
      encryptionMode: 'tenant_dedicated',
      kmsKeyRef: 'tenant_e2e_key',
      kafkaNamespace: 'tenant-e2e',
      oidc: {
        enabled: false,
      },
    });

    assert.equal(profile.deploymentMode, 'dedicated_db');
    assert.equal(profile.encryptionMode, 'tenant_dedicated');
    assert.equal(profile.kmsKeyRef, 'tenant_e2e_key');
    assert.equal(profile.kafkaNamespace, 'tenant-e2e');
  });
});
