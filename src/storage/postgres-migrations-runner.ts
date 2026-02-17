/**
 * PostgreSQL 迁移执行器
 * 复用 SQLite 迁移的执行逻辑，但使用 PostgreSQL 专用 SQL
 */

import type { IDatabase } from './database.js';
import { PG_MIGRATIONS } from './postgres-migrations.js';

interface MigrationRow {
  version: string;
  applied_at: number;
}

/** 创建迁移追踪表 */
function ensureMigrationTable(db: IDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at BIGINT NOT NULL
  )`);
}

/** 查询已应用的迁移版本 */
function getAppliedVersions(db: IDatabase): Set<string> {
  const rows = db.prepare<MigrationRow>(
    'SELECT version FROM schema_migrations ORDER BY version',
  ).all();
  return new Set(rows.map(r => r.version));
}

/** 执行 PostgreSQL 迁移 */
export function runPostgresMigrations(db: IDatabase): void {
  ensureMigrationTable(db);
  const applied = getAppliedVersions(db);

  for (const migration of PG_MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      for (const sql of migration.sql) {
        db.exec(sql);
      }
      db.prepare<void>(
        'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.description, Date.now());
    });
  }
}
