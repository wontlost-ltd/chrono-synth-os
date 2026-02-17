/**
 * 数据库工厂
 * 根据配置创建 SQLite 或 PostgreSQL 数据库实例
 */

import type { AppConfig } from '../config/schema.js';
import type { IDatabase } from './database.js';
import { SqliteDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresDatabase } from './postgres-database.js';
import { runPostgresMigrations } from './postgres-migrations-runner.js';

/** 根据配置创建数据库实例并执行迁移 */
export function createDatabase(config: AppConfig): IDatabase {
  if (config.db.driver === 'postgres') {
    if (!config.db.connectionString) {
      throw new Error('PostgreSQL 模式下必须提供 db.connectionString');
    }
    const db = new PostgresDatabase(config.db.connectionString, {
      max: config.db.pool.max,
      idleTimeoutMs: config.db.pool.idleTimeoutMs,
    });
    runPostgresMigrations(db);
    return db;
  }

  const db = new SqliteDatabase(config.db.path);
  runMigrations(db);
  return db;
}
