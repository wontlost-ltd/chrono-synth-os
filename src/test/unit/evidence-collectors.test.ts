/**
 * EvidenceCollector — unit tests for the built-in SOC2 collectors.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-L-basic
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import {
  runCollector, runAllBuiltInCollectors, builtInCollectors,
  keyRotationCollector, auditChainHealthCollector, accessReviewCollector,
  type EvidenceCollector,
} from '../../compliance/evidence-collectors.js';
import { recordRequestAuditLog } from '../../audit/audit-log-store.js';
import { listEvidenceByControl, countEvidence } from '../../compliance/evidence-store.js';
import type { IDatabase } from '../../storage/database.js';

function seedTenants(db: IDatabase, count: number): string[] {
  const tenantIds: string[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    const tenantId = `tenant-${i}`;
    tenantIds.push(tenantId);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`user-${i}-admin`, `${i}-admin@x.test`, 'h', 'admin', tenantId, now, now);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`user-${i}-member`, `${i}-member@x.test`, 'h', 'member', tenantId, now, now);
  }
  return tenantIds;
}

describe('EvidenceCollector framework', () => {
  it('built-in registry exposes 3 collectors mapped to distinct controls', () => {
    assert.equal(builtInCollectors.length, 3);
    const controlIds = new Set(builtInCollectors.map(c => c.controlId));
    assert.equal(controlIds.size, 3);
    assert.ok(controlIds.has('CC6.1'));
    assert.ok(controlIds.has('A1.2'));
    assert.ok(controlIds.has('CC6.3'));
  });

  it('runCollector traps collect() throws into errors[] without crashing the batch', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const tenantIds = seedTenants(db, 2);
    const broken: EvidenceCollector = {
      id: 'broken-test', controlId: 'CC9.1', evidenceType: 'broken',
      collect() { throw new Error('synthetic-collect-failure'); },
    };
    const report = runCollector(db, broken, tenantIds);
    assert.equal(report.collectedCount, 0);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0].error, /synthetic-collect-failure/);
  });

  it('runCollector records evidence per tenant; isolates per-row errors', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const tenantIds = seedTenants(db, 3);
    const report = runCollector(db, keyRotationCollector, tenantIds);
    assert.equal(report.collectedCount, 3);
    assert.equal(report.errors.length, 0);
    for (const tenantId of tenantIds) {
      assert.equal(countEvidence(db, tenantId, 'CC6.1'), 1);
    }
  });
});

describe('keyRotationCollector', () => {
  it('counts admin users + recent tokens per tenant', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const [tenantA] = seedTenants(db, 1);
    /* Add a 2nd admin to tenant-a so the count is non-trivial. */
    const now = Date.now();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('user-a-admin2', 'a-admin2@x.test', 'h', 'admin', tenantA, now, now);

    runCollector(db, keyRotationCollector, [tenantA]);
    const rows = listEvidenceByControl(db, tenantA, 'CC6.1');
    assert.equal(rows.length, 1);
    const payload = rows[0].payload as { adminUserCount: number; tokensIssuedLast24h: number };
    assert.equal(payload.adminUserCount, 2);
    assert.equal(payload.tokensIssuedLast24h, 0);
  });
});

describe('auditChainHealthCollector', () => {
  it('snapshots chain tail + total rows', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const [tenantA] = seedTenants(db, 1);
    /* Write 3 audit rows so the chain has tail seq=3. */
    for (let i = 0; i < 3; i += 1) {
      recordRequestAuditLog(db, {
        tenantId: tenantA, requestId: `r-${i}`, method: 'GET', path: '/x',
        statusCode: 200, latencyMs: 1, actionType: 'read',
      });
    }
    runCollector(db, auditChainHealthCollector, [tenantA]);
    const rows = listEvidenceByControl(db, tenantA, 'A1.2');
    assert.equal(rows.length, 1);
    const payload = rows[0].payload as { chainTailSeq: number; totalAuditRows: number; chainTailHash: string | null };
    assert.equal(payload.chainTailSeq, 3);
    assert.equal(payload.totalAuditRows, 3);
    assert.match(payload.chainTailHash ?? '', /^[a-f0-9]{64}$/);
  });

  it('handles tenants with no audit rows gracefully (chainTailSeq=0)', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const [tenantA] = seedTenants(db, 1);
    runCollector(db, auditChainHealthCollector, [tenantA]);
    const rows = listEvidenceByControl(db, tenantA, 'A1.2');
    const payload = rows[0].payload as { chainTailSeq: number; totalAuditRows: number };
    assert.equal(payload.chainTailSeq, 0);
    assert.equal(payload.totalAuditRows, 0);
  });
});

describe('accessReviewCollector', () => {
  it('counts distinct actors in the last 30d window', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const [tenantA] = seedTenants(db, 1);
    /* 3 distinct actors */
    for (const actor of ['u-1', 'u-2', 'u-3', 'u-1' /* dup */]) {
      recordRequestAuditLog(db, {
        tenantId: tenantA, requestId: `r-${actor}`, method: 'GET', path: '/x',
        statusCode: 200, latencyMs: 1, actionType: 'read',
        actorType: 'user', actorId: actor,
      });
    }
    runCollector(db, accessReviewCollector, [tenantA]);
    const rows = listEvidenceByControl(db, tenantA, 'CC6.3');
    const payload = rows[0].payload as { distinctActorCount: number; actorListHashSampleCount: number };
    assert.equal(payload.distinctActorCount, 3);
    assert.equal(payload.actorListHashSampleCount, 3);
  });

  it('does NOT leak raw actor IDs into the evidence payload', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const [tenantA] = seedTenants(db, 1);
    recordRequestAuditLog(db, {
      tenantId: tenantA, requestId: 'r', method: 'GET', path: '/x',
      statusCode: 200, latencyMs: 1, actionType: 'read',
      actorType: 'user', actorId: 'sensitive-user-id-PII',
    });
    runCollector(db, accessReviewCollector, [tenantA]);
    const rows = listEvidenceByControl(db, tenantA, 'CC6.3');
    const json = JSON.stringify(rows[0].payload);
    assert.equal(json.includes('sensitive-user-id-PII'), false,
      `access review payload must not include raw actor IDs: ${json}`);
  });
});

describe('runAllBuiltInCollectors', () => {
  it('emits N evidence rows per tenant where N = built-in collector count', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const tenantIds = seedTenants(db, 2);
    const reports = runAllBuiltInCollectors(db, tenantIds);
    assert.equal(reports.length, 3);
    for (const r of reports) {
      assert.equal(r.errors.length, 0);
      assert.equal(r.collectedCount, tenantIds.length);
    }
    for (const tenantId of tenantIds) {
      assert.equal(countEvidence(db, tenantId), 3);
    }
  });
});
