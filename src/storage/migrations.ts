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

/** v011: 演化差异报告 */
const v011_evolution_diff_report: Migration = {
  version: 'v011',
  description: '演化差异报告',
  sql: [
    '/* safe:add-column:evolution_records:diff_report_json */ ALTER TABLE evolution_records ADD COLUMN diff_report_json TEXT',
  ],
};

/** v012: 人生模拟引擎 */
const v012_life_simulation: Migration = {
  version: 'v012',
  description: '人生模拟引擎',
  sql: [
    `CREATE TABLE IF NOT EXISTS life_simulations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      task_id TEXT NOT NULL,
      base_simulation_id TEXT REFERENCES life_simulations(id) ON DELETE SET NULL,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
      summary_json TEXT,
      progress_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_life_sims_tenant ON life_simulations(tenant_id, created_at)',

    `CREATE TABLE IF NOT EXISTS life_simulation_paths (
      id TEXT PRIMARY KEY,
      simulation_id TEXT NOT NULL REFERENCES life_simulations(id) ON DELETE CASCADE,
      path_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
      summary_json TEXT,
      timeline_json TEXT,
      branches_json TEXT,
      retrospective_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_life_sim_paths ON life_simulation_paths(simulation_id)',
  ],
};

/** v013: 用户认证与刷新令牌 */
const v013_users_auth: Migration = {
  version: 'v013',
  description: '用户认证与刷新令牌',
  sql: [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member', 'viewer')),
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)',
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      is_revoked INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)',
  ],
};

/** v014: 订阅与用量记录 */
const v014_subscriptions: Migration = {
  version: 'v014',
  description: '订阅与用量记录',
  sql: [
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan_id TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'past_due', 'canceled', 'trialing')),
      current_period_start INTEGER NOT NULL,
      current_period_end INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id)',
    `CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      recorded_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_resource ON usage_records(tenant_id, resource, recorded_at)',
  ],
};

/** v015: 协作分享 */
const v015_shared_simulations: Migration = {
  version: 'v015',
  description: '协作分享模拟',
  sql: [
    `CREATE TABLE IF NOT EXISTS shared_simulations (
      id TEXT PRIMARY KEY,
      simulation_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      shared_with_user_id TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'view' CHECK(permission IN ('view', 'edit')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_shared_sims_sim ON shared_simulations(simulation_id)',
    'CREATE INDEX IF NOT EXISTS idx_shared_sims_shared_with ON shared_simulations(shared_with_user_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_sims_unique ON shared_simulations(simulation_id, shared_with_user_id)',
  ],
};

/** v016: Webhook 幂等性 + LLM 用量持久化 */
const v016_webhook_and_llm_usage: Migration = {
  version: 'v016',
  description: 'Webhook 事件去重表与 LLM 用量持久化表',
  sql: [
    `CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      estimated_cost_usd REAL NOT NULL,
      recorded_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_tenant ON llm_usage(tenant_id, recorded_at)',
  ],
};

/** v017: 决策与引导会话持久化 */
const v017_decision_onboarding_persistence: Migration = {
  version: 'v017',
  description: '决策案例/运行结果与引导会话持久化',
  sql: [
    `CREATE TABLE IF NOT EXISTS decision_cases (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      alternatives_json TEXT NOT NULL,
      constraints_json TEXT,
      context_json TEXT,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_decision_cases_tenant ON decision_cases(tenant_id)',

    `CREATE TABLE IF NOT EXISTS decision_runs (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES decision_cases(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_decision_runs_case ON decision_runs(case_id)',
    'CREATE INDEX IF NOT EXISTS idx_decision_runs_tenant ON decision_runs(tenant_id)',

    `CREATE TABLE IF NOT EXISTS decision_feedbacks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES decision_runs(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      selected_alternative TEXT NOT NULL,
      satisfaction INTEGER NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_decision_feedbacks_run ON decision_feedbacks(run_id)',

    `CREATE TABLE IF NOT EXISTS onboarding_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      current_step INTEGER NOT NULL DEFAULT 1,
      completed_steps_json TEXT NOT NULL DEFAULT '[]',
      decision_json TEXT,
      simulation_result_json TEXT,
      snapshot_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_tenant ON onboarding_sessions(tenant_id)',
  ],
};

/** v018: 刷新令牌复合索引 + 过期清理 */
const v018_refresh_token_index: Migration = {
  version: 'v018',
  description: '刷新令牌复合索引与过期清理',
  sql: [
    'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash_revoked ON refresh_tokens(token_hash, is_revoked)',
  ],
};

/** v019: 任务队列安全 — claimed_by/claimed_at 列 */
const v019_task_queue_claim: Migration = {
  version: 'v019',
  description: '任务队列安全 — 工作者领取标记',
  sql: [
    '/* safe:add-column:tasks:claimed_by */ ALTER TABLE tasks ADD COLUMN claimed_by TEXT',
    '/* safe:add-column:tasks:claimed_at */ ALTER TABLE tasks ADD COLUMN claimed_at INTEGER',
  ],
};

const v020_billing_outbox: Migration = {
  version: 'v020',
  description: 'Stripe 计量发件箱 — 持久化重试',
  sql: [
    `CREATE TABLE IF NOT EXISTS billing_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      processed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_billing_outbox_status ON billing_outbox (status, created_at)',
  ],
};

/** v021: 任务队列优先级 */
const v021_task_priority: Migration = {
  version: 'v021',
  description: '任务队列优先级支持',
  sql: [
    '/* safe:add-column:tasks:priority */ ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0',
    'CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks (priority DESC, created_at ASC) WHERE status = \'pending\'',
  ],
};

/** v022: IVF 质心持久化 + WebSocket 事件日志 */
const v022_ivf_and_event_log: Migration = {
  version: 'v022',
  description: 'IVF 质心持久化与 WebSocket 持久化事件日志',
  sql: [
    `CREATE TABLE IF NOT EXISTS ivf_centroids (
      model TEXT PRIMARY KEY,
      centroids_json TEXT NOT NULL,
      num_vectors INTEGER NOT NULL DEFAULT 0,
      built_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ws_event_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      data_json TEXT NOT NULL,
      tenant_id TEXT,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_ws_event_log_tenant ON ws_event_log (tenant_id, seq)',
    'CREATE INDEX IF NOT EXISTS idx_ws_event_log_created ON ws_event_log (created_at)',
  ],
};

/** v023: API Key 租户绑定 */
const v023_api_keys: Migration = {
  version: 'v023',
  description: 'API Key 租户绑定（支持计划感知限流）',
  sql: [
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      plan_id TEXT NOT NULL DEFAULT 'free',
      is_revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash)',
    'CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id)',
  ],
};

/** v024: 任务队列性能索引（purge + 公平调度查询优化） */
const v024_task_queue_indexes: Migration = {
  version: 'v024',
  description: '任务队列 purge 和公平调度性能索引',
  sql: [
    'CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks (status, updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks (tenant_id, status)',
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
  v011_evolution_diff_report,
  v012_life_simulation,
  v013_users_auth,
  v014_subscriptions,
  v015_shared_simulations,
  v016_webhook_and_llm_usage,
  v017_decision_onboarding_persistence,
  v018_refresh_token_index,
  v019_task_queue_claim,
  v020_billing_outbox,
  v021_task_priority,
  v022_ivf_and_event_log,
  v023_api_keys,
  v024_task_queue_indexes,
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
