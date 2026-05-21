/**
 * P1-N — LegalHoldService unit tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { LegalHoldService, LegalHoldActiveError } from '../../privacy/legal-hold-service.js';

describe('LegalHoldService.placeHold', () => {
  it('creates a tenant-wide hold without subjectId', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    const hold = svc.placeHold({
      tenantId: 't1', subject: 'tenant', reason: 'litigation 2026-Q2', createdBy: 'admin@x',
    });
    assert.equal(hold.tenantId, 't1');
    assert.equal(hold.subject, 'tenant');
    assert.equal(hold.subjectId, null);
    assert.equal(hold.releasedAt, null);
  });

  it('refuses subject=user without subjectId', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    assert.throws(
      () => svc.placeHold({ tenantId: 't1', subject: 'user', reason: 'r', createdBy: 'admin' }),
      /requires subjectId/,
    );
  });
});

describe('LegalHoldService.releaseHold', () => {
  it('marks released_at + released_by', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    const hold = svc.placeHold({ tenantId: 't1', subject: 'tenant', reason: 'r', createdBy: 'a' });
    const released = svc.releaseHold(hold.id, 'b', 't1');
    assert.ok(released.releasedAt !== null);
    assert.equal(released.releasedBy, 'b');
  });

  it('is idempotent when releasing twice', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    const hold = svc.placeHold({ tenantId: 't1', subject: 'tenant', reason: 'r', createdBy: 'a' });
    const first = svc.releaseHold(hold.id, 'b', 't1');
    const second = svc.releaseHold(hold.id, 'c', 't1');
    /* Second call returns the original release record — c is ignored to
     * preserve audit accuracy. */
    assert.equal(second.releasedBy, first.releasedBy);
    assert.equal(second.releasedAt, first.releasedAt);
  });

  it('refuses cross-tenant release', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    const hold = svc.placeHold({ tenantId: 't1', subject: 'tenant', reason: 'r', createdBy: 'a' });
    assert.throws(
      () => svc.releaseHold(hold.id, 'evil', 'other-tenant'),
      /different tenant/,
    );
  });
});

describe('LegalHoldService.findBlockingHold', () => {
  it('tenant-wide hold blocks every subject query', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    svc.placeHold({ tenantId: 't1', subject: 'tenant', reason: 'r', createdBy: 'a' });
    assert.ok(svc.findBlockingHold('t1', 'tenant', null));
    assert.ok(svc.findBlockingHold('t1', 'user', 'u-1'));
    assert.ok(svc.findBlockingHold('t1', 'persona', 'p-1'));
  });

  it('subject-specific hold only blocks matching subject', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    svc.placeHold({ tenantId: 't1', subject: 'user', subjectId: 'u-1', reason: 'r', createdBy: 'a' });
    assert.ok(svc.findBlockingHold('t1', 'user', 'u-1'));
    assert.equal(svc.findBlockingHold('t1', 'user', 'u-2'), null);
    assert.equal(svc.findBlockingHold('t1', 'persona', 'u-1'), null);
  });

  it('tenant-wide query returns any active hold (conservative)', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    svc.placeHold({ tenantId: 't1', subject: 'persona', subjectId: 'p-1', reason: 'r', createdBy: 'a' });
    /* Tenant-wide deletion must NOT proceed while any sub-hold is active. */
    assert.ok(svc.findBlockingHold('t1', 'tenant', null));
  });

  it('released holds no longer block', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    const hold = svc.placeHold({ tenantId: 't1', subject: 'tenant', reason: 'r', createdBy: 'a' });
    svc.releaseHold(hold.id, 'b', 't1');
    assert.equal(svc.findBlockingHold('t1', 'tenant', null), null);
  });

  it('does not cross tenant boundaries', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    svc.placeHold({ tenantId: 't1', subject: 'tenant', reason: 'r', createdBy: 'a' });
    assert.equal(svc.findBlockingHold('other-tenant', 'tenant', null), null,
      'a t1 hold must not block another tenant — that would corrupt tenant isolation');
  });
});

describe('LegalHoldService.assertNoBlockingHold', () => {
  it('throws LegalHoldActiveError carrying the hold', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    const hold = svc.placeHold({ tenantId: 't1', subject: 'tenant', reason: 'r', createdBy: 'a' });
    try {
      svc.assertNoBlockingHold('t1', 'tenant', null);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof LegalHoldActiveError);
      assert.equal(err.code, 'LEGAL_HOLD_ACTIVE');
      assert.equal(err.statusCode, 423);
      assert.equal(err.hold.id, hold.id);
    }
  });

  it('no-op when no holds active', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    assert.doesNotThrow(() => svc.assertNoBlockingHold('t1', 'tenant', null));
  });
});

describe('LegalHoldService.listActive', () => {
  it('returns only unreleased holds for the tenant', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const svc = new LegalHoldService(db);
    const h1 = svc.placeHold({ tenantId: 't1', subject: 'tenant', reason: 'r1', createdBy: 'a' });
    svc.placeHold({ tenantId: 't1', subject: 'user', subjectId: 'u-1', reason: 'r2', createdBy: 'a' });
    svc.placeHold({ tenantId: 't2', subject: 'tenant', reason: 'r3', createdBy: 'a' });
    svc.releaseHold(h1.id, 'b', 't1');

    const active = svc.listActive('t1');
    assert.equal(active.length, 1);
    assert.equal(active[0].subject, 'user');
  });
});
