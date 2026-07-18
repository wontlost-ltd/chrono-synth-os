/**
 * 数据库工厂
 * 根据配置创建 SQLite 或 PostgreSQL 数据库实例
 */

import type { AppConfig } from '../config/schema.js';
import type { IDatabase } from './database.js';
import { SqliteDatabase } from './database.js';
import { runDslPostgresMigrations, runDslSqliteMigrations } from './dsl-migrations-runner.js';
import { PostgresDatabase } from './postgres-database.js';

/** 根据配置创建数据库实例并执行迁移 */
export function createDatabase(config: AppConfig): IDatabase {
  /* fail-closed（分片 Phase 0）：任何非空 db.shards 拒绝启动——单/多 shard 半截启用（shard db≠host db,
   * 而 12 项未接线访问点仍走 host db）会致同租户数据静默分裂。ShardRouter 引擎已合入且可单测,但生产
   * activation 须待后续子片把全 inventory 访问点接线 + 2-shard 验收后才解除。这是运行时约束,非文档承诺。 */
  if (config.db.shards && Object.keys(config.db.shards).length > 0) {
    throw new Error(
      '拒绝启动：配置了 db.shards 但分片访问点接线尚未完成——任何非空 shards（含 1 个）都会致未接线访问点静默错-shard。' +
      '生产分片 activation 待后续子片完成后解除。',
    );
  }
  if (config.db.driver === 'postgres') {
    if (!config.db.connectionString) {
      throw new Error('PostgreSQL 模式下必须提供 db.connectionString');
    }
    const db = new PostgresDatabase(config.db.connectionString, {
      max: config.db.pool.max,
      idleTimeoutMs: config.db.pool.idleTimeoutMs,
    });
    runDslPostgresMigrations(db);
    return db;
  }

  const db = new SqliteDatabase(config.db.path);
  runDslSqliteMigrations(db);
  return db;
}
