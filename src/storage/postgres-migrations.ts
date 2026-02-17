/**
 * PostgreSQL 迁移脚本
 * 将 SQLite 迁移转换为 PostgreSQL 兼容语法
 */

import type { Migration } from './migrations.js';

/** v001: 初始表结构（PostgreSQL 版本） */
const v001_initial_schema: Migration = {
  version: 'v001',
  description: '初始表结构',
  sql: [
    /* 核心价值表 */
    `CREATE TABLE IF NOT EXISTS core_values (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    weight DOUBLE PRECISION NOT NULL CHECK(weight >= 0 AND weight <= 1),
    updated_at BIGINT NOT NULL
  )`,

    /* 记忆节点表 */
    `CREATE TABLE IF NOT EXISTS memory_nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('episodic', 'semantic', 'procedural')),
    content TEXT NOT NULL,
    valence DOUBLE PRECISION NOT NULL CHECK(valence >= -1 AND valence <= 1),
    salience DOUBLE PRECISION NOT NULL CHECK(salience >= 0 AND salience <= 1),
    created_at BIGINT NOT NULL,
    last_accessed_at BIGINT NOT NULL
  )`,

    /* 记忆边表 */
    `CREATE TABLE IF NOT EXISTS memory_edges (
    source TEXT NOT NULL REFERENCES memory_nodes(id),
    target TEXT NOT NULL REFERENCES memory_nodes(id),
    strength DOUBLE PRECISION NOT NULL CHECK(strength >= 0 AND strength <= 1),
    relation TEXT NOT NULL,
    PRIMARY KEY (source, target)
  )`,

    /* 叙事表 */
    `CREATE TABLE IF NOT EXISTS narrative (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    content TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,

    /* 人格版本表 */
    `CREATE TABLE IF NOT EXISTS persona_versions (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    values_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'failed')),
    results_json TEXT NOT NULL DEFAULT '[]',
    resource_quota DOUBLE PRECISION NOT NULL CHECK(resource_quota >= 0 AND resource_quota <= 1),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,

    /* 冲突记录表 */
    `CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    involved_versions_json TEXT NOT NULL,
    affected_values_json TEXT NOT NULL,
    description TEXT NOT NULL,
    detected_at BIGINT NOT NULL,
    resolved_at BIGINT,
    resolution TEXT
  )`,

    /* 快照表 */
    `CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,

    /* 演化记录表 */
    `CREATE TABLE IF NOT EXISTS evolution_records (
    id TEXT PRIMARY KEY,
    before_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    after_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
    merged_version_ids_json TEXT NOT NULL,
    value_delta_json TEXT NOT NULL,
    evolved_at BIGINT NOT NULL
  )`,

    /* 索引 */
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
    timestamp BIGINT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    request_id TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    latency_ms DOUBLE PRECISION NOT NULL
  )`,
    'CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_path ON audit_log(path)',
  ],
};

/** v003: 审计日志增加 API Key 哈希字段 */
const v003_audit_api_key: Migration = {
  version: 'v003',
  description: '审计日志增加 API Key 哈希字段',
  sql: [
    'ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS api_key_hash TEXT',
  ],
};

/** v004: 认知记忆扩展 */
const v004_cognitive_memory: Migration = {
  version: 'v004',
  description: '认知记忆扩展',
  sql: [
    'ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS decay_lambda DOUBLE PRECISION NOT NULL DEFAULT 0.0001',
    'ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS last_decayed_at BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS consolidated_from TEXT REFERENCES memory_nodes(id) ON DELETE SET NULL',
    `CREATE TABLE IF NOT EXISTS working_memory (
      memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,
      score DOUBLE PRECISION NOT NULL,
      entered_at BIGINT NOT NULL
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
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
    'CREATE INDEX IF NOT EXISTS idx_survival_anchors_kind ON survival_anchors(kind)',
    'CREATE INDEX IF NOT EXISTS idx_survival_anchors_severity ON survival_anchors(severity)',

    `CREATE TABLE IF NOT EXISTS decision_style (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    style_json TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,

    `CREATE TABLE IF NOT EXISTS cognitive_model (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    model_json TEXT NOT NULL,
    updated_at BIGINT NOT NULL
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
    updated_at BIGINT NOT NULL
  )`,
  ],
};

/** v007: 多租户隔离（PostgreSQL） */
const v007_multi_tenant: Migration = {
  version: 'v007',
  description: '多租户隔离',
  sql: [
    /* 为所有多租户表添加 tenant_id 列 */
    `ALTER TABLE core_values ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE memory_edges ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE persona_versions ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE evolution_records ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE survival_anchors ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,

    /* 单例表重建为 tenant_id 主键 */
    'ALTER TABLE narrative DROP CONSTRAINT IF EXISTS narrative_pkey',
    'ALTER TABLE narrative DROP COLUMN IF EXISTS id',
    `ALTER TABLE narrative ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    'ALTER TABLE narrative ADD PRIMARY KEY (tenant_id)',

    'ALTER TABLE decision_style DROP CONSTRAINT IF EXISTS decision_style_pkey',
    'ALTER TABLE decision_style DROP COLUMN IF EXISTS id',
    `ALTER TABLE decision_style ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    'ALTER TABLE decision_style ADD PRIMARY KEY (tenant_id)',

    'ALTER TABLE cognitive_model DROP CONSTRAINT IF EXISTS cognitive_model_pkey',
    'ALTER TABLE cognitive_model DROP COLUMN IF EXISTS id',
    `ALTER TABLE cognitive_model ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    'ALTER TABLE cognitive_model ADD PRIMARY KEY (tenant_id)',

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
      window_ms BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, resource)
    )`,
    `CREATE TABLE IF NOT EXISTS quota_usage (
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      window_start BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, resource, window_start)
    )`,
  ],
};

/** v008: 异步任务队列（PostgreSQL） */
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
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      available_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_tasks_status_available ON tasks(status, available_at)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id)',
  ],
};

/** v009: 核心价值扩展（PostgreSQL） */
const v009_core_values_tuning: Migration = {
  version: 'v009',
  description: '核心价值扩展 time_discount/emotion_amplifier',
  sql: [
    'ALTER TABLE core_values ADD COLUMN IF NOT EXISTS time_discount DOUBLE PRECISION NOT NULL DEFAULT 0.5',
    'ALTER TABLE core_values ADD COLUMN IF NOT EXISTS emotion_amplifier DOUBLE PRECISION NOT NULL DEFAULT 1.0',
  ],
};

/** v010: 更新闸门 pending_updates（PostgreSQL） */
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
      delta DOUBLE PRECISION NOT NULL DEFAULT 0,
      reason TEXT,
      created_at BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_pending_updates_status ON pending_updates(status)',
    'CREATE INDEX IF NOT EXISTS idx_pending_updates_tenant ON pending_updates(tenant_id)',
  ],
};

/** PostgreSQL 迁移列表 */
export const PG_MIGRATIONS: readonly Migration[] = [
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
