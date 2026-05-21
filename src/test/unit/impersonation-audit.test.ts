/**
 * P1-S — impersonation audit unit tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import {
  startImpersonation, stopImpersonation, ImpersonationError, MAX_IMPERSONATION_MS,
} from '../../identity/impersonation-audit.js';
import { listEvidenceByControl } from '../../compliance/evidence-store.js';

const valid = {
  tenantId: 't1',
  adminUserId: 'admin-1',
  targetUserId: 'user-x',
  reason: 'Customer reported login loop; reproducing',
  ticketId: 'JIRA-1234',
};

describe('startImpersonation', () => {
  it('refuses without ticket id', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    assert.throws(
      () => startImpersonation(db, db, { ...valid, ticketId: '' }),
      (err: ImpersonationError) => err.code === 'NO_TICKET',
    );
  });

  it('refuses with a too-short reason', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    assert.throws(
      () => startImpersonation(db, db, { ...valid, reason: 'TLDR' }),
      (err: ImpersonationError) => err.code === 'NO_REASON',
    );
  });

  it('refuses durationMs > MAX', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    assert.throws(
      () => startImpersonation(db, db, { ...valid, durationMs: MAX_IMPERSONATION_MS + 1 }),
      (err: ImpersonationError) => err.code === 'DURATION_TOO_LONG',
    );
  });

  it('writes both audit_log business event and CC6.7 evidence', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const session = startImpersonation(db, db, valid);
    assert.ok(session.sessionId.startsWith('imp_'));

    /* CC6.7 evidence written */
    const rows = listEvidenceByControl(db, 't1', 'CC6.7');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].evidenceType, 'impersonation_start');
    const payload = rows[0].payload as { sessionId: string; reasonLength: number };
    assert.equal(payload.sessionId, session.sessionId);
    /* PII guard: reason text NOT in evidence payload — only length */
    assert.equal(payload.reasonLength, valid.reason.length);
    assert.equal(JSON.stringify(payload).includes(valid.reason), false,
      'reason text must not be stored verbatim in evidence row');
  });

  it('audit_log business event carries full reason text', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const session = startImpersonation(db, db, valid);
    const row = db.prepare<{ payload_json: string }>(
      `SELECT payload_json FROM audit_log
        WHERE tenant_id = ? AND action_type = 'impersonation.start' AND target_id = ?`,
    ).get('t1', valid.targetUserId);
    assert.ok(row);
    const payload = JSON.parse(row.payload_json) as { sessionId: string; reason: string };
    assert.equal(payload.sessionId, session.sessionId);
    assert.equal(payload.reason, valid.reason);
  });
});

describe('stopImpersonation', () => {
  it('writes stop event for the session', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const session = startImpersonation(db, db, valid);
    stopImpersonation(db, session);

    const types = listEvidenceByControl(db, 't1', 'CC6.7').map(r => r.evidenceType);
    assert.deepEqual(types.sort(), ['impersonation_start', 'impersonation_stop']);
  });
});
