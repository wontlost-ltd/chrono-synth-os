/**
 * P2-H — license verifier tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  evaluateLicense,
  type LicensePayload, type SignedLicense, type SignedOverride, type OverridePayload,
} from '../../licensing/license-verifier.js';

/* ── Test helpers — these mirror what the offline license server does
 *    so the verifier and signer share canonical JSON shape. ── */

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

function signLicense(payload: LicensePayload): SignedLicense {
  const sig = sign(null, Buffer.from(canonicalJson(payload), 'utf-8'), privateKey).toString('base64url');
  return { payload, signature: sig };
}

function signOverride(payload: OverridePayload): SignedOverride {
  const sig = sign(null, Buffer.from(canonicalJson(payload), 'utf-8'), privateKey).toString('base64url');
  return { payload, signature: sig };
}

const MS_PER_DAY = 86_400_000;
const NOW = 1_000_000_000_000;

describe('evaluateLicense — happy path', () => {
  it('valid license returns status=valid', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: NOW - 1000,
      expiresAtMs: NOW + 30 * MS_PER_DAY,
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW });
    assert.equal(r.status, 'valid');
    assert.equal(r.graceRemainingMs, 0);
  });
});

describe('evaluateLicense — signature checks', () => {
  it('tampered payload → status=tampered', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW + 1000,
    });
    /* Mutate plan without resigning */
    const forged: SignedLicense = {
      ...license,
      payload: { ...license.payload, plan: 'enterprise-plus' },
    };
    const r = evaluateLicense(forged, publicKeyPem, { nowMs: NOW });
    assert.equal(r.status, 'tampered');
  });

  it('signed with wrong key → status=tampered', () => {
    const { privateKey: otherKey } = generateKeyPairSync('ed25519');
    const payload: LicensePayload = {
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW + 1000,
    };
    const sig = sign(null, Buffer.from(canonicalJson(payload), 'utf-8'), otherKey).toString('base64url');
    const r = evaluateLicense({ payload, signature: sig }, publicKeyPem, { nowMs: NOW });
    assert.equal(r.status, 'tampered');
  });
});

describe('evaluateLicense — temporal checks', () => {
  it('before nbf → status=invalid', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: NOW + MS_PER_DAY, expiresAtMs: NOW + 30 * MS_PER_DAY,
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW });
    assert.equal(r.status, 'invalid');
  });

  it('expired but within default 30d grace → status=grace', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW - 5 * MS_PER_DAY,
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW });
    assert.equal(r.status, 'grace');
    assert.equal(r.graceRemainingMs, 25 * MS_PER_DAY);
  });

  it('past expiry + grace → status=expired', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW - 31 * MS_PER_DAY,
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW });
    assert.equal(r.status, 'expired');
  });

  it('custom graceDays honoured', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW - 5 * MS_PER_DAY,
      graceDays: 3,
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW });
    /* 3d grace, 5d past expiry → no grace left */
    assert.equal(r.status, 'expired');
  });
});

describe('evaluateLicense — override extension', () => {
  it('valid override after grace expiry extends to override.expiresAtMs', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW - 60 * MS_PER_DAY,
    });
    const override = signOverride({
      licenseId: 'lic-1',
      expiresAtMs: NOW + 3 * MS_PER_DAY,
      reason: 'awaiting renewal countersign',
      approvedBy: 'ops-manager@chrono',
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW, override });
    assert.equal(r.status, 'grace');
    assert.equal(r.appliedOverride?.reason, 'awaiting renewal countersign');
  });

  it('override beyond 7d cap is rejected', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW - 60 * MS_PER_DAY,
    });
    const override = signOverride({
      licenseId: 'lic-1',
      expiresAtMs: NOW + 10 * MS_PER_DAY, /* > 7d */
      reason: 'too long', approvedBy: 'someone',
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW, override });
    assert.equal(r.status, 'expired');
    assert.equal(r.appliedOverride, null);
  });

  it('override for wrong license id is ignored', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW - 60 * MS_PER_DAY,
    });
    const override = signOverride({
      licenseId: 'wrong-license',
      expiresAtMs: NOW + 3 * MS_PER_DAY,
      reason: 'spoofed', approvedBy: 'attacker',
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW, override });
    assert.equal(r.status, 'expired');
    assert.equal(r.appliedOverride, null);
  });

  it('expired override is ignored', () => {
    const license = signLicense({
      id: 'lic-1', customerId: 'c1', plan: 'enterprise',
      notBeforeMs: 0, expiresAtMs: NOW - 60 * MS_PER_DAY,
    });
    const override = signOverride({
      licenseId: 'lic-1',
      expiresAtMs: NOW - 1000, /* past */
      reason: 'stale', approvedBy: 'a',
    });
    const r = evaluateLicense(license, publicKeyPem, { nowMs: NOW, override });
    assert.equal(r.status, 'expired');
  });
});
