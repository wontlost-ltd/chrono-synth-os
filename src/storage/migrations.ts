/**
 * 版本化迁移系统
 * 通过 schema_migrations 表追踪已应用版本，确保幂等执行
 */

import type { IDatabase } from './database.js';

/** 迁移定义 */
export interface Migration {
  readonly version: string;
  readonly description: string;
  readonly sql: readonly string[];
}

/** v001: 初始表结构（保留所有 IF NOT EXISTS，对已有库幂等） */
const v001_initial_schema: Migration = {
  version: 'v001',
  description: '初始表结构',
  sql: [
    /* 核心价值表 */
    `CREATE TABLE IF NOT EXISTS core_values (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),
    updated_at INTEGER NOT NULL
  )`,

    /* 记忆节点表 */
    `CREATE TABLE IF NOT EXISTS memory_nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('episodic', 'semantic', 'procedural')),
    content TEXT NOT NULL,
    valence REAL NOT NULL CHECK(valence >= -1 AND valence <= 1),
    salience REAL NOT NULL CHECK(salience >= 0 AND salience <= 1),
    created_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL
  )`,

    /* 记忆边表 */
    `CREATE TABLE IF NOT EXISTS memory_edges (
    source TEXT NOT NULL REFERENCES memory_nodes(id),
    target TEXT NOT NULL REFERENCES memory_nodes(id),
    strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),
    relation TEXT NOT NULL,
    PRIMARY KEY (source, target)
  )`,

    /* 叙事表 */
    `CREATE TABLE IF NOT EXISTS narrative (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

    /* 人格版本表 */
    `CREATE TABLE IF NOT EXISTS persona_versions (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    values_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'failed')),
    results_json TEXT NOT NULL DEFAULT '[]',
    resource_quota REAL NOT NULL CHECK(resource_quota >= 0 AND resource_quota <= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

    /* 冲突记录表 */
    `CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    involved_versions_json TEXT NOT NULL,
    affected_values_json TEXT NOT NULL,
    description TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT
  )`,

    /* 快照表 */
    `CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

    /* 演化记录表 */
    `CREATE TABLE IF NOT EXISTS evolution_records (
    id TEXT PRIMARY KEY,
    before_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    after_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    merged_version_ids_json TEXT NOT NULL,
    value_delta_json TEXT NOT NULL,
    evolved_at INTEGER NOT NULL
  )`,

    /* 索引：常用查询路径 */
    'CREATE INDEX IF NOT EXISTS idx_persona_status ON persona_versions(status)',
    'CREATE INDEX IF NOT EXISTS idx_conflicts_resolved_at ON conflicts(resolved_at)',
    'CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target)',
  ],
};

/** v002: 审计日志表 */
const v002_audit_log: Migration = {
  version: 'v002',
  description: '审计日志表',
  sql: [
    `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    request_id TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    latency_ms REAL NOT NULL
  )`,
    'CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_path ON audit_log(path)',
  ],
};

/**
 * v003: 审计日志增加 API Key 哈希字段
 * 注意：使用 safeSql 标记，在 runMigrations 中做列存在性检查
 */
const v003_audit_api_key: Migration = {
  version: 'v003',
  description: '审计日志增加 API Key 哈希字段',
  sql: [
    '/* safe:add-column:audit_log:api_key_hash */ ALTER TABLE audit_log ADD COLUMN api_key_hash TEXT',
  ],
};

/** 所有迁移按版本顺序排列 */
const MIGRATIONS: readonly Migration[] = [
  v001_initial_schema,
  v002_audit_log,
  v003_audit_api_key,
];

interface MigrationRow {
  version: string;
  applied_at: number;
}

/** 创建迁移追踪表 */
function ensureMigrationTable(db: IDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
}

/** 查询已应用的迁移版本 */
function getAppliedVersions(db: IDatabase): Set<string> {
  const rows = db.prepare<MigrationRow>(
    'SELECT version FROM schema_migrations ORDER BY version',
  ).all();
  return new Set(rows.map(r => r.version));
}

/** 检查 SQLite 表是否已有指定列 */
function hasColumn(db: IDatabase, table: string, column: string): boolean {
  const rows = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === column);
}

/** 解析 safe:add-column 标记 */
const ADD_COLUMN_RE = /^\/\* safe:add-column:(\w+):(\w+) \*\/ /;

/** 执行所有迁移（签名不变，内部逻辑改为版本化） */
export function runMigrations(db: IDatabase): void {
  ensureMigrationTable(db);
  const applied = getAppliedVersions(db);

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      for (const sql of migration.sql) {
        /* 处理 safe:add-column 标记：跳过已存在的列 */
        const match = ADD_COLUMN_RE.exec(sql);
        if (match) {
          const [, table, column] = match;
          if (hasColumn(db, table, column)) continue;
          db.exec(sql.replace(ADD_COLUMN_RE, ''));
        } else {
          db.exec(sql);
        }
      }
      db.prepare<void>(
        'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.description, Date.now());
    });
  }
}

export { MIGRATIONS };
