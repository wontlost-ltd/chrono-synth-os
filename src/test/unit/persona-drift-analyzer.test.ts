import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, type IDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { PersonaDriftAnalyzer } from '../../safety/persona-drift-analyzer.js';

function makeDb(): IDatabase {
  const db = createMemoryDatabase();
  runMigrations(db);
  return db;
}

function insertSnapshot(db: IDatabase, tenantId: string, values: Array<{ id: string; label: string; weight: number }>, createdAt: number): string {
  const id = `snap-${createdAt}`;
  const dataJson = JSON.stringify({ values });
  db.prepare<void>(
    `INSERT INTO snapshots (id, data_json, reason, created_at, tenant_id) VALUES (?, ?, 'test', ?, ?)`,
  ).run(id, dataJson, createdAt, tenantId);
  return id;
}

describe('PersonaDriftAnalyzer', () => {
  it('returns zero drift when only one snapshot exists', () => {
    const db = makeDb();
    insertSnapshot(db, 'default', [{ id: 'v1', label: 'Honesty', weight: 0.8 }], 1000);
    const analyzer = new PersonaDriftAnalyzer(db);
    const report = analyzer.analyze('default');
    assert.equal(report.overallDriftScore, 0);
    assert.equal(report.alertLevel, 'ok');
    assert.equal(report.valueDrifts.length, 0);
  });

  it('detects warning-level drift when value changes > 15%', () => {
    const db = makeDb();
    insertSnapshot(db, 'default', [{ id: 'v1', label: 'Honesty', weight: 0.8 }], 1000);
    insertSnapshot(db, 'default', [{ id: 'v1', label: 'Honesty', weight: 0.62 }], 2000);
    const analyzer = new PersonaDriftAnalyzer(db);
    const report = analyzer.analyze('default');
    assert.equal(report.valueDrifts.length, 1);
    assert.equal(report.valueDrifts[0]?.alertLevel, 'warning');
    assert.ok(report.overallDriftScore > 0.15);
    assert.equal(report.alertLevel, 'warning');
  });

  it('detects critical-level drift when value changes > 30%', () => {
    const db = makeDb();
    insertSnapshot(db, 'default', [{ id: 'v1', label: 'Courage', weight: 0.9 }], 1000);
    insertSnapshot(db, 'default', [{ id: 'v1', label: 'Courage', weight: 0.55 }], 2000);
    const analyzer = new PersonaDriftAnalyzer(db);
    const report = analyzer.analyze('default');
    assert.equal(report.alertLevel, 'critical');
    assert.ok(report.overallDriftScore >= 0.30);
  });

  it('persists report and getLatest returns it', () => {
    const db = makeDb();
    insertSnapshot(db, 'default', [{ id: 'v1', label: 'Empathy', weight: 0.7 }], 1000);
    insertSnapshot(db, 'default', [{ id: 'v1', label: 'Empathy', weight: 0.5 }], 2000);
    const analyzer = new PersonaDriftAnalyzer(db);
    const report = analyzer.analyze('default');
    const latest = analyzer.getLatest('default');
    assert.ok(latest);
    assert.equal(latest.reportId, report.reportId);
    assert.equal(latest.alertLevel, report.alertLevel);
  });

  it('returns null from getLatest when no report exists', () => {
    const db = makeDb();
    const analyzer = new PersonaDriftAnalyzer(db);
    assert.equal(analyzer.getLatest('default'), null);
  });
});
