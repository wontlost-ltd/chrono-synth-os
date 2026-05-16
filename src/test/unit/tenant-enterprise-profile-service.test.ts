import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { loadConfig } from '../../config/schema.js';
import { TenantEnterpriseProfileService } from '../../enterprise/tenant-enterprise-profile-service.js';
import { TenantManifestV1Schema } from '@chrono/contracts';

describe('TenantEnterpriseProfileService', () => {
  it('字段加密关闭时允许保存任意 tenant-dedicated kmsKeyRef', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
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

  describe('getManifest', () => {
    it('默认租户（无 DB 记录）返回 platform_managed manifest', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      const config = loadConfig({ region: 'ap-east-1' });
      const service = new TenantEnterpriseProfileService(db, config);

      const manifest = service.getManifest('default');

      assert.doesNotThrow(() => TenantManifestV1Schema.parse(manifest));
      assert.equal(manifest.schemaVersion, 'tenant-manifest.v1');
      assert.equal(manifest.tenantId, 'default');
      assert.equal(manifest.region, 'ap-east-1');
      assert.equal(manifest.deploymentMode, 'shared_cluster');
      assert.equal(manifest.encryptionMode, 'platform_managed');
      assert.equal(manifest.kms.provider, 'platform');
      assert.equal(manifest.kms.keyRef, undefined);
    });

    it('dedicated_db + tenant_dedicated + AWS KMS keyRef 映射正确', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      const config = loadConfig({
        region: 'us-east-1',
        encryption: { enabled: false },
      });
      const service = new TenantEnterpriseProfileService(db, config);
      service.upsertProfile('tenant_aws', {
        deploymentMode: 'dedicated_db',
        encryptionMode: 'tenant_dedicated',
        kmsKeyRef: 'arn:aws:kms:us-east-1:123456789012:key/abc',
      });

      const manifest = service.getManifest('tenant_aws');

      assert.doesNotThrow(() => TenantManifestV1Schema.parse(manifest));
      assert.equal(manifest.deploymentMode, 'dedicated_db');
      assert.equal(manifest.encryptionMode, 'tenant_dedicated');
      assert.equal(manifest.kms.provider, 'aws_kms');
      assert.equal(manifest.kms.keyRef, 'arn:aws:kms:us-east-1:123456789012:key/abc');
    });

    it('shared_cluster 租户返回 shared_cluster deploymentMode', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      const config = loadConfig({ region: 'eu-central-1' });
      const service = new TenantEnterpriseProfileService(db, config);
      service.upsertProfile('tenant_shared', {
        deploymentMode: 'shared_cluster',
        encryptionMode: 'platform_managed',
      });

      const manifest = service.getManifest('tenant_shared');

      assert.doesNotThrow(() => TenantManifestV1Schema.parse(manifest));
      assert.equal(manifest.deploymentMode, 'shared_cluster');
      assert.equal(manifest.kms.provider, 'platform');
      assert.equal(manifest.region, 'eu-central-1');
    });

    it('manifest storage.primary 来自 config.db.path（SQLite）', () => {
      const db = createMemoryDatabase();
      runDslSqliteMigrations(db);
      const config = loadConfig({ region: 'local', db: { path: '/data/chrono.db' } });
      const service = new TenantEnterpriseProfileService(db, config);

      const manifest = service.getManifest('default');

      assert.equal(manifest.storage.primary, '/data/chrono.db');
    });
  });
});
