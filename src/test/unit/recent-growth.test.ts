/**
 * buildRecentGrowthPhrase（ADR-0054 Phase 5 recentGrowth 来源）：把已存 drift 报告渲染成
 * 第一人称成长一句，喂给 chat 的 proactiveReply.recentGrowth。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, type IDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { PersonaDriftAnalyzer } from '../../safety/persona-drift-analyzer.js';
import { buildRecentGrowthPhrase } from '../../server/routes/companion/recent-growth.js';

function makeDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

function insertSnapshot(db: IDatabase, tenantId: string, values: Array<{ id: string; label: string; weight: number }>, createdAt: number): void {
  db.prepare<void>(
    `INSERT INTO snapshots (id, data_json, reason, created_at, tenant_id) VALUES (?, ?, 'test', ?, ?)`,
  ).run(`snap-${createdAt}`, JSON.stringify({ values }), createdAt, tenantId);
}

describe('buildRecentGrowthPhrase（ADR-0054 Phase 5）', () => {
  it('无任何快照/报告 → undefined（无基线，不带成长片段）', () => {
    const db = makeDb();
    assert.equal(buildRecentGrowthPhrase(db, 'default'), undefined);
  });

  it('单快照（无可对比基线）→ undefined', () => {
    const db = makeDb();
    insertSnapshot(db, 'default', [{ id: 'v1', label: '诚实', weight: 0.8 }], 1000);
    new PersonaDriftAnalyzer(db).analyze('default'); /* 持久化报告 */
    assert.equal(buildRecentGrowthPhrase(db, 'default'), undefined, '单快照不算历史基线');
  });

  it('权重上升（toward）→「我越来越看重「<label>」」', () => {
    const db = makeDb();
    insertSnapshot(db, 'default', [{ id: 'v1', label: '勇气', weight: 0.4 }], 1000);
    insertSnapshot(db, 'default', [{ id: 'v1', label: '勇气', weight: 0.85 }], 2000);
    new PersonaDriftAnalyzer(db).analyze('default');
    const phrase = buildRecentGrowthPhrase(db, 'default');
    assert.equal(phrase, '我越来越看重「勇气」');
  });

  it('权重下降（away）→「我逐渐放下「<label>」」', () => {
    const db = makeDb();
    insertSnapshot(db, 'default', [{ id: 'v1', label: '安稳', weight: 0.9 }], 1000);
    insertSnapshot(db, 'default', [{ id: 'v1', label: '安稳', weight: 0.45 }], 2000);
    new PersonaDriftAnalyzer(db).analyze('default');
    const phrase = buildRecentGrowthPhrase(db, 'default');
    assert.equal(phrase, '我逐渐放下「安稳」');
  });

  it('确定性：同一份报告 → 同一句话（可复现）', () => {
    const db = makeDb();
    insertSnapshot(db, 'default', [{ id: 'v1', label: '好奇', weight: 0.3 }], 1000);
    insertSnapshot(db, 'default', [{ id: 'v1', label: '好奇', weight: 0.9 }], 2000);
    new PersonaDriftAnalyzer(db).analyze('default');
    assert.equal(buildRecentGrowthPhrase(db, 'default'), buildRecentGrowthPhrase(db, 'default'));
  });

  it('租户隔离：A 的成长不串到 B', () => {
    const db = makeDb();
    insertSnapshot(db, 'tenant-a', [{ id: 'v1', label: '勇气', weight: 0.4 }], 1000);
    insertSnapshot(db, 'tenant-a', [{ id: 'v1', label: '勇气', weight: 0.85 }], 2000);
    new PersonaDriftAnalyzer(db).analyze('tenant-a');
    assert.match(buildRecentGrowthPhrase(db, 'tenant-a') ?? '', /勇气/);
    assert.equal(buildRecentGrowthPhrase(db, 'tenant-b'), undefined, 'B 无报告 → undefined');
  });
});
