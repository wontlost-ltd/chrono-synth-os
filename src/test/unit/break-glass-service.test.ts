/**
 * P1-M — BreakGlassService unit tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { BreakGlassService, BreakGlassError, MAX_TTL_MS } from '../../identity/break-glass-service.js';
import { listEvidenceByControl } from '../../compliance/evidence-store.js';

const KEY = 'a'.repeat(40);

function makeService() {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return { db, svc: new BreakGlassService(db, KEY) };
}

describe('BreakGlassService.issue', () => {
  it('refuses construction with a short signing key', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    assert.throws(() => new BreakGlassService(db, 'short'), /≥32 chars/);
  });

  it('refuses issuance without approval id', () => {
    const { svc } = makeService();
    assert.throws(
      () => svc.issue({ requestedBy: 'a', approvalId: '', scope: 'auth.keys.rotate', tenantId: 't1' }),
      BreakGlassError,
    );
  });

  it('refuses ttl > MAX_TTL_MS', () => {
    const { svc } = makeService();
    assert.throws(
      () => svc.issue({ requestedBy: 'a', approvalId: 'X-1', scope: 'auth.keys.rotate', tenantId: 't1', ttlMs: MAX_TTL_MS + 1 }),
      (err: BreakGlassError) => err.code === 'TTL_TOO_LONG',
    );
  });

  it('writes CC6.1 evidence row on issuance', () => {
    const { db, svc } = makeService();
    svc.issue({ requestedBy: 'sre-1', approvalId: 'PD-INC-42', scope: 'auth.keys.rotate', tenantId: 't1' });
    const rows = listEvidenceByControl(db, 't1', 'CC6.1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].evidenceType, 'break_glass_issued');
    const payload = rows[0].payload as { approvalId: string; scope: string };
    assert.equal(payload.approvalId, 'PD-INC-42');
    assert.equal(payload.scope, 'auth.keys.rotate');
  });
});

describe('BreakGlassService.verify — happy path', () => {
  it('consumes a valid token for the correct scope + tenant', () => {
    const { svc } = makeService();
    const { token } = svc.issue({ requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 't1' });
    const payload = svc.verify(token, 'auth.keys.rotate', 't1');
    assert.equal(payload.scope, 'auth.keys.rotate');
    assert.equal(payload.requestedBy, 'sre');
  });
});

describe('BreakGlassService.verify — refusal paths', () => {
  it('refuses tampered body (signature mismatch)', () => {
    const { svc } = makeService();
    const { token } = svc.issue({ requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 't1' });
    const [body, sig] = token.split('.');
    /* Decode body, mutate scope to a stronger one, re-encode without
     * recomputing sig — classic forgery attempt. */
    const tampered = JSON.parse(Buffer.from(body!, 'base64url').toString('utf-8'));
    tampered.scope = 'auth.keys.compromise';
    const tamperedBody = Buffer.from(JSON.stringify(tampered)).toString('base64url');
    const forged = `${tamperedBody}.${sig}`;
    assert.throws(
      () => svc.verify(forged, 'auth.keys.compromise', 't1'),
      (err: BreakGlassError) => err.code === 'SIGNATURE_INVALID',
    );
  });

  it('refuses signature with wrong key', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc1 = new BreakGlassService(db, KEY);
    const svc2 = new BreakGlassService(db, 'b'.repeat(40));
    const { token } = svc1.issue({ requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 't1' });
    assert.throws(
      () => svc2.verify(token, 'auth.keys.rotate', 't1'),
      (err: BreakGlassError) => err.code === 'SIGNATURE_INVALID',
    );
  });

  it('refuses expired token', () => {
    const { svc } = makeService();
    const { token } = svc.issue({ requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 't1', ttlMs: 1 });
    /* Sleep past expiry. */
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.throws(
          () => svc.verify(token, 'auth.keys.rotate', 't1'),
          (err: BreakGlassError) => err.code === 'EXPIRED',
        );
        resolve();
      }, 10);
    });
  });

  it('refuses scope mismatch', () => {
    const { svc } = makeService();
    const { token } = svc.issue({ requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 't1' });
    assert.throws(
      () => svc.verify(token, 'auth.user.unlock', 't1'),
      (err: BreakGlassError) => err.code === 'SCOPE_MISMATCH',
    );
  });

  it('refuses tenant mismatch', () => {
    const { svc } = makeService();
    const { token } = svc.issue({ requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 't1' });
    assert.throws(
      () => svc.verify(token, 'auth.keys.rotate', 't-other'),
      (err: BreakGlassError) => err.code === 'TENANT_MISMATCH',
    );
  });

  it('refuses reuse (jti single-consumption)', () => {
    const { svc } = makeService();
    const { token } = svc.issue({ requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 't1' });
    svc.verify(token, 'auth.keys.rotate', 't1');
    assert.throws(
      () => svc.verify(token, 'auth.keys.rotate', 't1'),
      (err: BreakGlassError) => err.code === 'REPLAY_DETECTED',
    );
  });

  it('refuses malformed token', () => {
    const { svc } = makeService();
    assert.throws(
      () => svc.verify('not-a-token', 'auth.keys.rotate', 't1'),
      (err: BreakGlassError) => err.code === 'INVALID_FORMAT' || err.code === 'SIGNATURE_INVALID',
    );
  });
});

describe('BreakGlassService — evidence trail', () => {
  it('records every refusal with the outcome reason', () => {
    const { db, svc } = makeService();
    const { token } = svc.issue({ requestedBy: 'sre', approvalId: 'X', scope: 'auth.keys.rotate', tenantId: 't1' });
    /* Wrong scope */
    try { svc.verify(token, 'data.restore', 't1'); } catch { /* expected */ }
    /* Wrong tenant */
    try { svc.verify(token, 'auth.keys.rotate', 'other'); } catch { /* expected */ }
    /* Successful consume */
    svc.verify(token, 'auth.keys.rotate', 't1');
    /* Reuse */
    try { svc.verify(token, 'auth.keys.rotate', 't1'); } catch { /* expected */ }

    const rows = listEvidenceByControl(db, 't1', 'CC6.1');
    const outcomes = rows
      .filter(r => r.evidenceType === 'break_glass_use')
      .map(r => (r.payload as { outcome: string }).outcome);
    assert.deepEqual(outcomes.sort(), ['consumed', 'replay_detected', 'scope_mismatch', 'tenant_mismatch']);
  });
});

describe('BreakGlassService.signingKeyFingerprint', () => {
  it('returns a stable, short, non-secret-leaking value', () => {
    const { svc } = makeService();
    const fp = svc.signingKeyFingerprint();
    assert.match(fp, /^[a-f0-9]{16}$/);
    /* Must NOT contain the raw key. */
    assert.equal(fp.includes(KEY), false);
  });
});
