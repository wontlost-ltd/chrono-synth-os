import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TenantManifestV1Schema } from '../src/data-plane/tenant-manifest.js';

const validManifest = {
  schemaVersion: 'tenant-manifest.v1' as const,
  tenantId: 'tenant-001',
  region: 'us-east-1',
  deploymentMode: 'platform_managed' as const,
  encryptionMode: 'platform_managed' as const,
  storage: { primary: 'postgres://main' },
  kms: { provider: 'platform' as const },
  sync: {},
  retention: {},
};

describe('TenantManifestV1Schema', () => {
  it('accepts a valid manifest with defaults', () => {
    const result = TenantManifestV1Schema.safeParse(validManifest);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.sync.maxOfflineQueueSize, 1000);
      assert.equal(result.data.sync.flushOnReconnect, true);
      assert.equal(result.data.retention.defaultRetentionDays, 365);
      assert.equal(result.data.retention.auditRetentionDays, 730);
    }
  });

  it('accepts all deployment modes', () => {
    for (const mode of ['platform_managed', 'shared_cluster', 'dedicated_db', 'self_hosted'] as const) {
      const result = TenantManifestV1Schema.safeParse({ ...validManifest, deploymentMode: mode });
      assert.equal(result.success, true, `should accept deploymentMode: ${mode}`);
    }
  });

  it('accepts all KMS providers', () => {
    for (const provider of ['platform', 'aws_kms', 'gcp_kms', 'azure_kv', 'vault'] as const) {
      const result = TenantManifestV1Schema.safeParse({
        ...validManifest,
        kms: { provider },
      });
      assert.equal(result.success, true, `should accept kms.provider: ${provider}`);
    }
  });

  it('accepts a manifest with explicit sync values', () => {
    const result = TenantManifestV1Schema.safeParse({
      ...validManifest,
      sync: { maxOfflineQueueSize: 500, maxOfflineAgeMs: 86400000, flushOnReconnect: false },
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.sync.maxOfflineQueueSize, 500);
      assert.equal(result.data.sync.flushOnReconnect, false);
    }
  });

  it('accepts a manifest with replica storage', () => {
    const result = TenantManifestV1Schema.safeParse({
      ...validManifest,
      storage: { primary: 'postgres://main', replica: 'postgres://replica' },
    });
    assert.equal(result.success, true);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = TenantManifestV1Schema.safeParse({
      ...validManifest,
      unexpectedField: 'oops',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty tenantId', () => {
    const result = TenantManifestV1Schema.safeParse({
      ...validManifest,
      tenantId: '',
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid deployment mode', () => {
    const result = TenantManifestV1Schema.safeParse({
      ...validManifest,
      deploymentMode: 'invalid_mode',
    });
    assert.equal(result.success, false);
  });

  it('rejects tenant_dedicated encryption with platform KMS', () => {
    const result = TenantManifestV1Schema.safeParse({
      ...validManifest,
      encryptionMode: 'tenant_dedicated',
      kms: { provider: 'platform' },
    });
    assert.equal(result.success, false);
  });

  it('rejects tenant_dedicated encryption without keyRef', () => {
    const result = TenantManifestV1Schema.safeParse({
      ...validManifest,
      encryptionMode: 'tenant_dedicated',
      kms: { provider: 'aws_kms' },
    });
    assert.equal(result.success, false);
  });

  it('accepts tenant_dedicated encryption with valid KMS config', () => {
    const result = TenantManifestV1Schema.safeParse({
      ...validManifest,
      encryptionMode: 'tenant_dedicated',
      kms: { provider: 'aws_kms', keyRef: 'arn:aws:kms:us-east-1:123:key/abc' },
    });
    assert.equal(result.success, true);
  });
});
