/**
 * Negative integration test — break-glass token misuse paths.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-C + §8 #15 + §3.5 P1-M
 *
 * Activated once BreakGlassService shipped. Covers:
 *   - expired tokens rejected (TTL ≤ 15min)
 *   - wrong-scope tokens rejected
 *   - reused tokens rejected (single-consumption jti)
 *   - tampered tokens rejected (HMAC signature check)
 *   - issuance without approval id rejected
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { BreakGlassService, BreakGlassError } from '../../identity/break-glass-service.js';

const KEY = 'a'.repeat(40);

describe('P1-M negative — break-glass token misuse', () => {
  it('expired token is rejected', async () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new BreakGlassService(db, KEY);
    const { token } = svc.issue({
      requestedBy: 'sre-on-call',
      approvalId: 'PD-INC-42',
      scope: 'auth.keys.rotate',
      tenantId: 'tenant-a',
      ttlMs: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.throws(
      () => svc.verify(token, 'auth.keys.rotate', 'tenant-a'),
      (err: BreakGlassError) => err.code === 'EXPIRED',
    );
  });

  it('scope mismatch is rejected', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new BreakGlassService(db, KEY);
    const { token } = svc.issue({
      requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 'tenant-a',
    });
    assert.throws(
      () => svc.verify(token, 'auth.user.unlock', 'tenant-a'),
      (err: BreakGlassError) => err.code === 'SCOPE_MISMATCH',
    );
  });

  it('replay of consumed token is rejected', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new BreakGlassService(db, KEY);
    const { token } = svc.issue({
      requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 'tenant-a',
    });
    svc.verify(token, 'auth.keys.rotate', 'tenant-a');
    assert.throws(
      () => svc.verify(token, 'auth.keys.rotate', 'tenant-a'),
      (err: BreakGlassError) => err.code === 'ALREADY_USED',
    );
  });

  it('issuance without approval id is rejected', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new BreakGlassService(db, KEY);
    assert.throws(
      () => svc.issue({ requestedBy: 'sre', approvalId: '', scope: 'auth.keys.rotate', tenantId: 'tenant-a' }),
      (err: BreakGlassError) => err.code === 'NO_APPROVAL_ID',
    );
  });

  it('tampered token (modified scope) is rejected', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new BreakGlassService(db, KEY);
    const { token } = svc.issue({
      requestedBy: 'sre', approvalId: 'X', scope: 'auth.user.unlock', tenantId: 'tenant-a',
    });
    const [body, sig] = token.split('.');
    const tampered = JSON.parse(Buffer.from(body!, 'base64url').toString('utf-8'));
    tampered.scope = 'auth.keys.rotate';
    const tamperedBody = Buffer.from(JSON.stringify(tampered)).toString('base64url');
    const forged = `${tamperedBody}.${sig}`;
    assert.throws(
      () => svc.verify(forged, 'auth.keys.rotate', 'tenant-a'),
      (err: BreakGlassError) => err.code === 'SIGNATURE_INVALID',
    );
  });
});
