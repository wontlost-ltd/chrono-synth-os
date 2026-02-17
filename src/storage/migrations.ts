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

/** v004: 认知记忆扩展 */
const v004_cognitive_memory: Migration = {
  version: 'v004',
  description: '认知记忆扩展',
  sql: [
    '/* safe:add-column:memory_nodes:access_count */ ALTER TABLE memory_nodes ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0',
    '/* safe:add-column:memory_nodes:decay_lambda */ ALTER TABLE memory_nodes ADD COLUMN decay_lambda REAL NOT NULL DEFAULT 0.0001',
    '/* safe:add-column:memory_nodes:last_decayed_at */ ALTER TABLE memory_nodes ADD COLUMN last_decayed_at INTEGER NOT NULL DEFAULT 0',
    '/* safe:add-column:memory_nodes:consolidated_from */ ALTER TABLE memory_nodes ADD COLUMN consolidated_from TEXT REFERENCES memory_nodes(id) ON DELETE SET NULL',
    `CREATE TABLE IF NOT EXISTS working_memory (
      memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      entered_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_working_memory_score ON working_memory(score)',
    'CREATE INDEX IF NOT EXISTS idx_memory_nodes_salience ON memory_nodes(salience)',
    'CREATE INDEX IF NOT EXISTS idx_memory_nodes_kind_access ON memory_nodes(kind, access_count)',
  ],
};

/** v005: P-OS v0.1 人格模型（L0/L2/L3） */
const v005_personality_os: Migration = {
  version: 'v005',
  description: 'P-OS v0.1 人格模型',
  sql: [
    `CREATE TABLE IF NOT EXISTS survival_anchors (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('constraint', 'threshold', 'must_have')),
    value_json TEXT NOT NULL,
    severity INTEGER NOT NULL CHECK(severity >= 1 AND severity <= 5),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
    'CREATE INDEX IF NOT EXISTS idx_survival_anchors_kind ON survival_anchors(kind)',
    'CREATE INDEX IF NOT EXISTS idx_survival_anchors_severity ON survival_anchors(severity)',

    `CREATE TABLE IF NOT EXISTS decision_style (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    style_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

    `CREATE TABLE IF NOT EXISTS cognitive_model (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    model_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  ],
};

/** v006: 记忆向量索引 */
const v006_memory_embeddings: Migration = {
  version: 'v006',
  description: '记忆向量索引',
  sql: [
    `CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,
    embedding_json TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  ],
};

/** v007: 多租户隔离 */
const v007_multi_tenant: Migration = {
  version: 'v007',
  description: '多租户隔离',
  sql: [
    /* 为所有多租户表添加 tenant_id 列 */
    '/* safe:add-column:core_values:tenant_id */ ALTER TABLE core_values ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:memory_nodes:tenant_id */ ALTER TABLE memory_nodes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:memory_edges:tenant_id */ ALTER TABLE memory_edges ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:memory_embeddings:tenant_id */ ALTER TABLE memory_embeddings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:working_memory:tenant_id */ ALTER TABLE working_memory ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:persona_versions:tenant_id */ ALTER TABLE persona_versions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:conflicts:tenant_id */ ALTER TABLE conflicts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:snapshots:tenant_id */ ALTER TABLE snapshots ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:evolution_records:tenant_id */ ALTER TABLE evolution_records ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:survival_anchors:tenant_id */ ALTER TABLE survival_anchors ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',
    '/* safe:add-column:audit_log:tenant_id */ ALTER TABLE audit_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT \'default\'',

    /* 单例表重建为 tenant_id 主键 */
    'ALTER TABLE narrative RENAME TO narrative_old',
    `CREATE TABLE IF NOT EXISTS narrative (
      tenant_id TEXT PRIMARY KEY DEFAULT 'default',
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO narrative (tenant_id, content, updated_at)
     SELECT 'default', content, updated_at FROM narrative_old`,
    'DROP TABLE IF EXISTS narrative_old',

    'ALTER TABLE decision_style RENAME TO decision_style_old',
    `CREATE TABLE IF NOT EXISTS decision_style (
      tenant_id TEXT PRIMARY KEY DEFAULT 'default',
      style_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO decision_style (tenant_id, style_json, updated_at)
     SELECT 'default', style_json, updated_at FROM decision_style_old`,
    'DROP TABLE IF EXISTS decision_style_old',

    'ALTER TABLE cognitive_model RENAME TO cognitive_model_old',
    `CREATE TABLE IF NOT EXISTS cognitive_model (
      tenant_id TEXT PRIMARY KEY DEFAULT 'default',
      model_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO cognitive_model (tenant_id, model_json, updated_at)
     SELECT 'default', model_json, updated_at FROM cognitive_model_old`,
    'DROP TABLE IF EXISTS cognitive_model_old',

    /* 租户索引 */
    'CREATE INDEX IF NOT EXISTS idx_core_values_tenant ON core_values(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant ON memory_nodes(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_persona_versions_tenant ON persona_versions(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_snapshots_tenant ON snapshots(tenant_id)',

    /* 配额表 */
    `CREATE TABLE IF NOT EXISTS quota_limits (
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      max_per_window INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, resource)
    )`,
    `CREATE TABLE IF NOT EXISTS quota_usage (
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, resource, window_start)
    )`,
  ],
};

/** v008: 异步任务队列 */
const v008_task_queue: Migration = {
  version: 'v008',
  description: '异步任务队列',
  sql: [
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      result TEXT,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      available_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_tasks_status_available ON tasks(status, available_at)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id)',
  ],
};

/** v009: 核心价值扩展 */
const v009_core_values_tuning: Migration = {
  version: 'v009',
  description: '核心价值扩展 time_discount/emotion_amplifier',
  sql: [
    '/* safe:add-column:core_values:time_discount */ ALTER TABLE core_values ADD COLUMN time_discount REAL NOT NULL DEFAULT 0.5',
    '/* safe:add-column:core_values:emotion_amplifier */ ALTER TABLE core_values ADD COLUMN emotion_amplifier REAL NOT NULL DEFAULT 1.0',
  ],
};

/** v010: 更新闸门 pending_updates */
const v010_update_gate: Migration = {
  version: 'v010',
  description: '更新闸门 pending_updates',
  sql: [
    `CREATE TABLE IF NOT EXISTS pending_updates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      layer TEXT NOT NULL CHECK(layer IN ('L0', 'L1')),
      trigger_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      current_value TEXT,
      proposed_value TEXT,
      delta REAL NOT NULL DEFAULT 0,
      reason TEXT,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_pending_updates_status ON pending_updates(status)',
    'CREATE INDEX IF NOT EXISTS idx_pending_updates_tenant ON pending_updates(tenant_id)',
  ],
};

/** 所有迁移按版本顺序排列 */
const MIGRATIONS: readonly Migration[] = [
  v001_initial_schema,
  v002_audit_log,
  v003_audit_api_key,
  v004_cognitive_memory,
  v005_personality_os,
  v006_memory_embeddings,
  v007_multi_tenant,
  v008_task_queue,
  v009_core_values_tuning,
  v010_update_gate,
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
