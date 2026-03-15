import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PortabilityPackManifestV1Schema,
  ExportJobStatusV1Schema,
  ImportDryRunReportV1Schema,
} from '../src/portability/pack-manifest.js';

const validManifest = {
  schemaVersion: 'portability-pack.v1' as const,
  exportedAt: '2026-03-15T00:00:00Z',
  exportMode: 'personal' as const,
  sourceRuntime: 'node' as const,
  sourceApiMajor: 'v2' as const,
  tenant: {
    tenantId: 'tenant-001',
    deploymentMode: 'platform_managed' as const,
    encryptionMode: 'platform_managed' as const,
  },
  payloads: [
    {
      logicalName: 'personas',
      format: 'ndjson' as const,
      path: 'data/personas.ndjson',
      checksum: 'sha256:abc123',
      required: true,
    },
  ],
  compatibility: {
    minImporterVersion: '2.0.0',
    featureFlagsRequired: [],
  },
  integrity: {
    algorithm: 'sha256' as const,
    manifestChecksum: 'abc123',
    signatureAlgorithm: 'ed25519' as const,
    signaturePublicKey: 'pk_test',
    detachedSignaturePath: 'manifest.sig',
  },
};

describe('PortabilityPackManifestV1Schema', () => {
  it('accepts a valid manifest without encryption', () => {
    const result = PortabilityPackManifestV1Schema.safeParse(validManifest);
    assert.equal(result.success, true);
  });

  it('accepts all export modes', () => {
    for (const mode of ['personal', 'smb', 'enterprise'] as const) {
      const result = PortabilityPackManifestV1Schema.safeParse({ ...validManifest, exportMode: mode });
      assert.equal(result.success, true, `should accept exportMode: ${mode}`);
    }
  });

  it('accepts all source runtimes', () => {
    for (const rt of ['node', 'web', 'mobile', 'desktop'] as const) {
      const result = PortabilityPackManifestV1Schema.safeParse({ ...validManifest, sourceRuntime: rt });
      assert.equal(result.success, true, `should accept sourceRuntime: ${rt}`);
    }
  });

  it('accepts passphrase encryption with kdf', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: { mode: 'passphrase', kdf: 'argon2id' },
    });
    assert.equal(result.success, true);
  });

  it('rejects passphrase encryption without kdf', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: { mode: 'passphrase' },
    });
    assert.equal(result.success, false);
  });

  it('rejects passphrase encryption with kms metadata', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: { mode: 'passphrase', kdf: 'argon2id', kmsKeyRef: 'arn:aws:kms:key/123' },
    });
    assert.equal(result.success, false);
  });

  it('accepts kms-wrapped encryption with required fields', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: {
        mode: 'kms-wrapped',
        kmsKeyRef: 'arn:aws:kms:key/123',
        wrappedDataKeyPath: 'keys/wrapped.bin',
      },
    });
    assert.equal(result.success, true);
  });

  it('rejects kms-wrapped without kmsKeyRef', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: { mode: 'kms-wrapped', wrappedDataKeyPath: 'keys/wrapped.bin' },
    });
    assert.equal(result.success, false);
  });

  it('rejects kms-wrapped with kdf', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: { mode: 'kms-wrapped', kmsKeyRef: 'arn:aws:kms:key/123', wrappedDataKeyPath: 'keys/wrapped.bin', kdf: 'argon2id' },
    });
    assert.equal(result.success, false);
  });

  it('accepts none encryption mode', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: { mode: 'none' },
    });
    assert.equal(result.success, true);
  });

  it('rejects none encryption mode with kdf', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: { mode: 'none', kdf: 'argon2id' },
    });
    assert.equal(result.success, false);
  });

  it('rejects none encryption mode with kms metadata', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      encryption: { mode: 'none', kmsKeyRef: 'arn:aws:kms:key/123' },
    });
    assert.equal(result.success, false);
  });

  it('rejects tenant_dedicated without kmsKeyRef', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      tenant: {
        ...validManifest.tenant,
        encryptionMode: 'tenant_dedicated' as const,
      },
    });
    assert.equal(result.success, false);
  });

  it('accepts tenant_dedicated with kmsKeyRef', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      tenant: {
        ...validManifest.tenant,
        encryptionMode: 'tenant_dedicated' as const,
        kmsKeyRef: 'arn:aws:kms:key/123',
      },
    });
    assert.equal(result.success, true);
  });

  it('accepts optional blobs', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      blobs: [{ path: 'blobs/avatar.png', sha256: 'abc', bytes: 1024 }],
    });
    assert.equal(result.success, true);
  });

  it('rejects empty payloads array', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      payloads: [],
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid exportedAt timestamp', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      exportedAt: 'not-a-date',
    });
    assert.equal(result.success, false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = PortabilityPackManifestV1Schema.safeParse({
      ...validManifest,
      extra: true,
    });
    assert.equal(result.success, false);
  });
});

describe('ExportJobStatusV1Schema', () => {
  const validJob = {
    schemaVersion: 'export-job-status.v1' as const,
    exportId: 'export-001',
    state: 'running' as const,
    percent: 42,
    createdAt: '2026-03-15T00:00:00Z',
    warnings: [],
  };

  it('accepts a valid running job', () => {
    const result = ExportJobStatusV1Schema.safeParse(validJob);
    assert.equal(result.success, true);
  });

  it('accepts queued state', () => {
    const result = ExportJobStatusV1Schema.safeParse({ ...validJob, state: 'queued', percent: 0 });
    assert.equal(result.success, true);
  });

  it('accepts partial state', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      state: 'partial',
      percent: 80,
      completedAt: '2026-03-15T01:00:00Z',
    });
    assert.equal(result.success, true);
  });

  it('accepts completed job with all required fields', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      state: 'completed',
      percent: 100,
      completedAt: '2026-03-15T01:00:00Z',
      downloadUrl: 'https://storage.example.com/export-001.zip',
    });
    assert.equal(result.success, true);
  });

  it('rejects completed job without downloadUrl', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      state: 'completed',
      percent: 100,
      completedAt: '2026-03-15T01:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects completed job without completedAt', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      state: 'completed',
      percent: 100,
      downloadUrl: 'https://storage.example.com/export-001.zip',
    });
    assert.equal(result.success, false);
  });

  it('rejects completed job with percent != 100', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      state: 'completed',
      percent: 99,
      completedAt: '2026-03-15T01:00:00Z',
      downloadUrl: 'https://storage.example.com/export-001.zip',
    });
    assert.equal(result.success, false);
  });

  it('accepts failed job with errorCode', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      state: 'failed',
      completedAt: '2026-03-15T01:00:00Z',
      errorCode: 'STORAGE_FULL',
    });
    assert.equal(result.success, true);
  });

  it('rejects failed job without errorCode', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      state: 'failed',
      completedAt: '2026-03-15T01:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects partial job without completedAt', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      state: 'partial',
      percent: 80,
    });
    assert.equal(result.success, false);
  });

  it('rejects running job with completedAt', () => {
    const result = ExportJobStatusV1Schema.safeParse({
      ...validJob,
      completedAt: '2026-03-15T01:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects percent > 100', () => {
    const result = ExportJobStatusV1Schema.safeParse({ ...validJob, percent: 101 });
    assert.equal(result.success, false);
  });

  it('rejects percent < 0', () => {
    const result = ExportJobStatusV1Schema.safeParse({ ...validJob, percent: -1 });
    assert.equal(result.success, false);
  });
});

describe('ImportDryRunReportV1Schema', () => {
  const validReport = {
    schemaVersion: 'import-dryrun.v1' as const,
    importId: 'import-001',
    packSchemaVersion: 'portability-pack.v1',
    signatureValid: true,
    blockers: [],
    warnings: [{ code: 'DEPRECATED_FIELD', messageId: 'import.warning.deprecated_field' }],
    deltaSummary: {
      personas: { create: 5, update: 2, skip: 0 },
      memories: { create: 100, update: 10, skip: 3 },
    },
    estimatedDurationMs: 5000,
    canCommit: true,
    commitToken: 'tok_abc123',
  };

  it('accepts a valid dry run report', () => {
    const result = ImportDryRunReportV1Schema.safeParse(validReport);
    assert.equal(result.success, true);
  });

  it('accepts report with blockers preventing commit', () => {
    const result = ImportDryRunReportV1Schema.safeParse({
      ...validReport,
      signatureValid: false,
      canCommit: false,
      commitToken: undefined,
      blockers: [{ code: 'INVALID_SIGNATURE', messageId: 'import.error.invalid_signature' }],
    });
    assert.equal(result.success, true);
  });

  it('rejects canCommit=true when blockers exist', () => {
    const result = ImportDryRunReportV1Schema.safeParse({
      ...validReport,
      blockers: [{ code: 'INVALID_SIGNATURE', messageId: 'import.error.invalid_signature' }],
      canCommit: true,
      commitToken: 'tok_abc123',
    });
    assert.equal(result.success, false);
  });

  it('rejects canCommit=true when signatureValid=false', () => {
    const result = ImportDryRunReportV1Schema.safeParse({
      ...validReport,
      signatureValid: false,
      canCommit: true,
      commitToken: 'tok_abc123',
    });
    assert.equal(result.success, false);
  });

  it('rejects commitToken when canCommit=false', () => {
    const result = ImportDryRunReportV1Schema.safeParse({
      ...validReport,
      canCommit: false,
      commitToken: 'tok_abc123',
    });
    assert.equal(result.success, false);
  });

  it('rejects canCommit=true without commitToken', () => {
    const result = ImportDryRunReportV1Schema.safeParse({
      ...validReport,
      canCommit: true,
      commitToken: undefined,
    });
    assert.equal(result.success, false);
  });

  it('rejects unknown fields in deltaSummary entries (strict)', () => {
    const result = ImportDryRunReportV1Schema.safeParse({
      ...validReport,
      deltaSummary: {
        personas: { create: 5, update: 2, skip: 0, extra: 1 },
      },
    });
    assert.equal(result.success, false);
  });
});
