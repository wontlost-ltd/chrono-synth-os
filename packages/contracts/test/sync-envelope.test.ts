import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEnvelopeV1Schema } from '../src/sync/sync-envelope.js';

const validEnvelope = {
  schemaVersion: 'sync-envelope.v1' as const,
  commandId: 'cmd-001',
  tenantId: 'tenant-001',
  actorId: 'user-001',
  runtimeId: 'rt-web-001',
  entityRef: 'persona:p-001',
  createdAt: '2026-03-15T00:00:00Z',
  expiresAt: '2026-03-15T01:00:00Z',
  nonce: 'nonce-abc123def',
  idempotencyKey: 'idem-xyz789abc',
  payloadHash: 'sha256:abcdef0123456789',
  signatureKeyId: 'key-001',
  signature: 'c2lnLWJhc2U2NA==',
  signatureAlgorithm: 'hmac-sha256' as const,
};

describe('SyncEnvelopeV1Schema', () => {
  it('accepts a valid envelope', () => {
    const result = SyncEnvelopeV1Schema.safeParse(validEnvelope);
    assert.equal(result.success, true);
  });

  it('accepts ed25519 signature algorithm', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      signatureAlgorithm: 'ed25519',
    });
    assert.equal(result.success, true);
  });

  it('accepts optional expectedVersion', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      expectedVersion: 5,
    });
    assert.equal(result.success, true);
  });

  it('accepts expectedVersion=0', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      expectedVersion: 0,
    });
    assert.equal(result.success, true);
  });

  it('rejects expiresAt <= createdAt', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      expiresAt: '2026-03-14T23:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects expiresAt === createdAt', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      expiresAt: '2026-03-15T00:00:00Z',
    });
    assert.equal(result.success, false);
  });

  it('rejects empty commandId', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      commandId: '',
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid createdAt format', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      createdAt: 'not-a-date',
    });
    assert.equal(result.success, false);
  });

  it('rejects unknown fields (strict mode)', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      extra: true,
    });
    assert.equal(result.success, false);
  });

  it('rejects invalid signatureAlgorithm', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      signatureAlgorithm: 'rsa-sha256',
    });
    assert.equal(result.success, false);
  });

  it('rejects negative expectedVersion', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      expectedVersion: -1,
    });
    assert.equal(result.success, false);
  });

  it('rejects fractional expectedVersion', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      expectedVersion: 1.5,
    });
    assert.equal(result.success, false);
  });

  it('rejects whitespace-only nonce', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      nonce: '        ',
    });
    assert.equal(result.success, false);
  });

  it('rejects whitespace-only idempotencyKey', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      idempotencyKey: '   ',
    });
    assert.equal(result.success, false);
  });

  it('rejects whitespace-only signatureKeyId', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      signatureKeyId: '   ',
    });
    assert.equal(result.success, false);
  });

  it('rejects whitespace-only signature', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      signature: '   ',
    });
    assert.equal(result.success, false);
  });

  it('rejects too-short nonce', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      nonce: 'abc',
    });
    assert.equal(result.success, false);
  });

  it('rejects payloadHash with invalid characters', () => {
    const result = SyncEnvelopeV1Schema.safeParse({
      ...validEnvelope,
      payloadHash: 'sha256:abc def!@#',
    });
    assert.equal(result.success, false);
  });
});
