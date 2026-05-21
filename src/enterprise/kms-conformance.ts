/**
 * KMS provider Core conformance suite.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §4.2 P2-A (Layer 1: Core)
 *
 * Three-layer model:
 *   Layer 1 Core      — properties every KmsClient must satisfy
 *                       regardless of backend; pure unit-test style with
 *                       no I/O. THIS FILE.
 *   Layer 2 Provider  — provider-specific contract tests using a mock
 *                       SDK / local fake (LocalStack, Azurite); covered
 *                       per-provider in their own files.
 *   Layer 3 Live      — runs against real cloud KMS in a CI gate;
 *                       reserved for nightly + release pipelines.
 *
 * The Core suite is a single exported function so any concrete client
 * can opt in:
 *
 *   describe('PlatformKmsClient — Core conformance', () => {
 *     runCoreConformance(() => new PlatformKmsClient(testKey));
 *   });
 *
 * Why a callable rather than a test-runner-specific decorator:
 *   - keeps this module test-runner-agnostic (works under node:test,
 *     vitest, jest with thin glue)
 *   - lets provider tests compose extra cases freely
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KmsClient } from './kms-client.js';

/**
 * Run the Core conformance suite against a factory that builds a fresh
 * KmsClient per test. Each property is a hard requirement; failure
 * means the provider is non-conformant and cannot ship.
 *
 * Properties (each is one `it()`):
 *   C1 — generateDataKey returns plaintext (32B) + encrypted blob + ref
 *   C2 — round-trip: unwrap(generate.encrypted) === generate.plaintext
 *   C3 — distinct invocations produce distinct keys (no static keying)
 *   C4 — encryptedDataKey is non-trivial (not equal to plaintext, not
 *        all zeros — defends against the "stub returns ciphertext = key"
 *        anti-pattern that has silently shipped in past KMS adapters)
 *   C5 — unwrap of corrupted ciphertext throws (no silent zero buffer)
 *   C6 — provider property exposes the backend kind correctly
 */
export function runCoreConformance(factory: () => KmsClient): void {
  describe('Core conformance', () => {
    it('C1 — generateDataKey returns plaintext + encrypted + ref', async () => {
      const c = factory();
      const k = await c.generateDataKey('test-key-ref');
      assert.equal(k.dataKey.length, 32, 'data key must be 32 bytes (AES-256)');
      assert.ok(k.encryptedDataKey.length > 0, 'encrypted blob must be non-empty');
      assert.equal(typeof k.keyRef, 'string');
      assert.ok(k.keyRef.length > 0);
    });

    it('C2 — round-trip: unwrap(encrypted) === plaintext', async () => {
      const c = factory();
      const k = await c.generateDataKey('test-key-ref');
      const unwrapped = await c.unwrapDataKey(k.encryptedDataKey, k.keyRef);
      assert.equal(unwrapped.length, k.dataKey.length);
      assert.ok(unwrapped.equals(k.dataKey),
        'unwrap must return the exact plaintext that generate produced');
    });

    it('C3 — distinct invocations produce distinct plaintext keys', async () => {
      const c = factory();
      const a = await c.generateDataKey('test-key-ref');
      const b = await c.generateDataKey('test-key-ref');
      assert.ok(!a.dataKey.equals(b.dataKey),
        'each generateDataKey call must produce fresh randomness');
      assert.notEqual(a.encryptedDataKey, b.encryptedDataKey,
        'ciphertext must include IV/nonce; identical plaintexts must encrypt to distinct outputs');
    });

    it('C4 — encryptedDataKey does NOT equal dataKey (stub-leak check)', async () => {
      const c = factory();
      const k = await c.generateDataKey('test-key-ref');
      assert.notEqual(k.encryptedDataKey, k.dataKey.toString('base64'),
        'a stub that returns ciphertext = key (or vice versa) has shipped before — guard against it');
      assert.notEqual(k.encryptedDataKey, k.dataKey.toString('hex'));
      /* All-zero ciphertext would also smell wrong. */
      assert.notEqual(k.encryptedDataKey, '0'.repeat(k.encryptedDataKey.length));
    });

    it('C5 — unwrap of corrupted ciphertext throws (no silent zero buffer)', async () => {
      const c = factory();
      const k = await c.generateDataKey('test-key-ref');
      /* Truncate the ciphertext to 1 char — must fail. */
      await assert.rejects(
        () => c.unwrapDataKey('Z', k.keyRef),
        'unwrap must reject obviously corrupted ciphertext rather than return zeros',
      );
    });

    it('C6 — provider property reflects the backend kind', () => {
      const c = factory();
      assert.ok(
        ['platform', 'aws_kms', 'gcp_kms', 'azure_kv', 'vault'].includes(c.provider),
        `unknown provider value: ${c.provider}`,
      );
    });
  });
}
