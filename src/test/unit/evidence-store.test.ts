/**
 * EvidenceStore — unit tests for canonical hashing + record/list roundtrip.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-F-basic
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import {
  computeEvidenceHash, recordEvidence, getEvidenceById, listEvidenceByControl,
  listEvidenceByPeriod, countEvidence, exportEvidenceBundle, verifyEvidenceIntegrity,
} from '../../compliance/evidence-store.js';

describe('EvidenceStore — computeEvidenceHash', () => {
  it('64-char hex output', () => {
    const { sha256 } = computeEvidenceHash({ a: 1 });
    assert.match(sha256, /^[a-f0-9]{64}$/);
  });

  it('key order does not affect hash (canonical JSON)', () => {
    const a = computeEvidenceHash({ a: 1, b: { c: 2, d: 3 } });
    const b = computeEvidenceHash({ b: { d: 3, c: 2 }, a: 1 });
    assert.equal(a.sha256, b.sha256);
  });

  it('different payload yields different hash', () => {
    const a = computeEvidenceHash({ a: 1 });
    const b = computeEvidenceHash({ a: 2 });
    assert.notEqual(a.sha256, b.sha256);
  });

  it('arrays preserve element order in hash', () => {
    const a = computeEvidenceHash([1, 2, 3]);
    const b = computeEvidenceHash([3, 2, 1]);
    assert.notEqual(a.sha256, b.sha256);
  });
});

describe('EvidenceStore — record / query', () => {
  it('recordEvidence stores row retrievable by id', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const id = recordEvidence(db, {
      tenantId: 't1',
      controlId: 'CC6.1',
      evidenceType: 'access_log_query',
      payload: { query: 'SELECT count(*) FROM users WHERE role=admin', result: 3 },
    });
    const got = getEvidenceById(db, 't1', id);
    assert.ok(got);
    assert.equal(got.controlId, 'CC6.1');
    assert.equal(got.evidenceType, 'access_log_query');
    assert.equal(got.collector, 'system');
    assert.deepEqual(got.payload, { query: 'SELECT count(*) FROM users WHERE role=admin', result: 3 });
    assert.match(got.payloadSha256, /^[a-f0-9]{64}$/);
  });

  it('listEvidenceByControl orders newest first', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    recordEvidence(db, { tenantId: 't1', controlId: 'CC7.3', evidenceType: 'backup_check', payload: { n: 1 }, collectedAt: 1_000 });
    recordEvidence(db, { tenantId: 't1', controlId: 'CC7.3', evidenceType: 'backup_check', payload: { n: 2 }, collectedAt: 3_000 });
    recordEvidence(db, { tenantId: 't1', controlId: 'CC7.3', evidenceType: 'backup_check', payload: { n: 3 }, collectedAt: 2_000 });
    const list = listEvidenceByControl(db, 't1', 'CC7.3');
    assert.deepEqual(list.map(r => (r.payload as { n: number }).n), [2, 3, 1]);
  });

  it('listEvidenceByPeriod filters by control_id list', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    recordEvidence(db, { tenantId: 't1', controlId: 'CC6.1', evidenceType: 'x', payload: {}, collectedAt: 100 });
    recordEvidence(db, { tenantId: 't1', controlId: 'CC7.3', evidenceType: 'x', payload: {}, collectedAt: 200 });
    recordEvidence(db, { tenantId: 't1', controlId: 'A1.2', evidenceType: 'x', payload: {}, collectedAt: 300 });
    const subset = listEvidenceByPeriod(db, 't1', 0, 1000, { controlIds: ['CC6.1', 'A1.2'] });
    assert.equal(subset.length, 2);
    assert.deepEqual(subset.map(r => r.controlId).sort(), ['A1.2', 'CC6.1']);
  });

  it('tenant isolation: tenant-b cannot see tenant-a evidence', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    recordEvidence(db, { tenantId: 'tenant-a', controlId: 'CC6.1', evidenceType: 'x', payload: { secret: 1 } });
    recordEvidence(db, { tenantId: 'tenant-b', controlId: 'CC6.1', evidenceType: 'x', payload: { secret: 2 } });
    const aRows = listEvidenceByControl(db, 'tenant-a', 'CC6.1');
    const bRows = listEvidenceByControl(db, 'tenant-b', 'CC6.1');
    assert.equal(aRows.length, 1);
    assert.equal(bRows.length, 1);
    assert.deepEqual((aRows[0].payload as { secret: number }).secret, 1);
    assert.deepEqual((bRows[0].payload as { secret: number }).secret, 2);
  });

  it('countEvidence with and without control filter', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    recordEvidence(db, { tenantId: 't1', controlId: 'CC6.1', evidenceType: 'x', payload: {} });
    recordEvidence(db, { tenantId: 't1', controlId: 'CC6.1', evidenceType: 'x', payload: {} });
    recordEvidence(db, { tenantId: 't1', controlId: 'CC7.3', evidenceType: 'x', payload: {} });
    assert.equal(countEvidence(db, 't1'), 3);
    assert.equal(countEvidence(db, 't1', 'CC6.1'), 2);
    assert.equal(countEvidence(db, 't1', 'CC7.3'), 1);
    assert.equal(countEvidence(db, 't1', 'CC9.9'), 0);
  });
});

describe('EvidenceStore — export bundle', () => {
  it('exportEvidenceBundle returns one NDJSON line per row', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    recordEvidence(db, { tenantId: 't1', controlId: 'CC6.1', evidenceType: 'x', payload: { a: 1 }, collectedAt: 100 });
    recordEvidence(db, { tenantId: 't1', controlId: 'CC6.1', evidenceType: 'x', payload: { a: 2 }, collectedAt: 200 });
    const lines = exportEvidenceBundle(db, 't1', 0, 1000);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.ok(typeof parsed.id === 'string');
      assert.match(parsed.payloadSha256 as string, /^[a-f0-9]{64}$/);
    }
  });
});

describe('EvidenceStore — integrity verification', () => {
  it('clean bundle verifies ok', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    recordEvidence(db, { tenantId: 't1', controlId: 'CC6.1', evidenceType: 'x', payload: { a: 1 } });
    recordEvidence(db, { tenantId: 't1', controlId: 'CC7.3', evidenceType: 'x', payload: { b: 2 } });
    const result = verifyEvidenceIntegrity(db, 't1', 0, Date.now() + 1);
    assert.equal(result.ok, true);
    assert.equal(result.totalChecked, 2);
    assert.equal(result.mismatches.length, 0);
  });

  it('detects post-hoc payload tampering', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const id = recordEvidence(db, { tenantId: 't1', controlId: 'CC6.1', evidenceType: 'x', payload: { ok: true } });
    /* Forge a different payload but leave the stored hash alone, mimicking
     * an attacker with direct DB access. */
    db.prepare<void>(
      `UPDATE compliance_evidence SET payload_json = ? WHERE id = ?`,
    ).run(JSON.stringify({ ok: false }), id);
    const result = verifyEvidenceIntegrity(db, 't1', 0, Date.now() + 1);
    assert.equal(result.ok, false);
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].id, id);
  });
});
