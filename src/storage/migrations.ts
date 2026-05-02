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

/** v025: 配置中心与附加组件 */
const v025_config_and_addons: Migration = {
  version: 'v025',
  description: '配置中心（config_items/config_audit）与附加组件（add_ons/tenant_add_ons/entitlements）',
  sql: [
    /* 配置项表 */
    `CREATE TABLE IF NOT EXISTS config_items (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('public', 'protected', 'admin', 'secret')),
      requires_restart INTEGER NOT NULL DEFAULT 0,
      group_key TEXT NOT NULL DEFAULT 'general',
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    )`,

    /* 配置审计日志 */
    `CREATE TABLE IF NOT EXISTS config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_config_audit_key ON config_audit(config_key)',
    'CREATE INDEX IF NOT EXISTS idx_config_audit_time ON config_audit(changed_at)',

    /* 附加组件定义 */
    `CREATE TABLE IF NOT EXISTS add_ons (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      stripe_price_id TEXT NOT NULL DEFAULT '',
      resource TEXT NOT NULL,
      quota_amount INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_add_ons_code ON add_ons(code)',

    /* 租户已购附加组件 */
    `CREATE TABLE IF NOT EXISTS tenant_add_ons (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      add_on_id TEXT NOT NULL REFERENCES add_ons(id),
      stripe_subscription_item_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'canceled')),
      purchased_at INTEGER NOT NULL,
      canceled_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_tenant_add_ons_tenant ON tenant_add_ons(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_tenant_add_ons_status ON tenant_add_ons(tenant_id, status)',

    /* 权益快照表 */
    `CREATE TABLE IF NOT EXISTS entitlements (
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      effective_limit INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'plan',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, resource)
    )`,
  ],
};

/** v026: 移动端设备管理 */
const v026_mobile_devices: Migration = {
  version: 'v026',
  description: '移动端设备注册与推送 token 管理',
  sql: [
    `CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      device_uid TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('ios', 'android', 'web')),
      push_token TEXT,
      app_version TEXT,
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_tenant_user_uid ON devices(tenant_id, user_id, device_uid)',
    'CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id)',
  ],
};

/** v027: 身份与分身系统 */
const v027_identity_avatar: Migration = {
  version: 'v027',
  description: '身份与分身系统',
  sql: [
    `CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenant_id)',

    `CREATE TABLE IF NOT EXISTS avatars (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES identities(id),
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'general'
        CHECK(kind IN ('general','work','social','family','creative')),
      behavior_overrides TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_avatars_identity ON avatars(identity_id)',

    `CREATE TABLE IF NOT EXISTS device_avatars (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      is_active INTEGER NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL,
      UNIQUE(device_id, avatar_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_device_avatars_device ON device_avatars(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_device_avatars_avatar ON device_avatars(avatar_id)',

    /* 为已有用户回填 identity */
    `INSERT OR IGNORE INTO identities (id, user_id, tenant_id, display_name, created_at, updated_at)
     SELECT 'ident_' || REPLACE(id, 'user_', ''), id, tenant_id, email, created_at, updated_at
     FROM users`,

    /* 为已有 identity 创建默认 avatar */
    `INSERT OR IGNORE INTO avatars (id, identity_id, label, kind, is_default, is_active, created_at, updated_at)
     SELECT 'avt_' || REPLACE(id, 'ident_', ''), id, '默认', 'general', 1, 1, created_at, updated_at
     FROM identities`,
  ],
};

/** v028: 记忆淘汰索引 */
const v028_memory_eviction_indexes: Migration = {
  version: 'v028',
  description: '记忆淘汰索引（salience + last_accessed_at）',
  sql: [
    'CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant_salience ON memory_nodes(tenant_id, salience)',
    'CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant_last_accessed ON memory_nodes(tenant_id, last_accessed_at)',
  ],
};

/** v029: Avatar 自动运行 + 知识源 */
const v029_avatar_autorun: Migration = {
  version: 'v029',
  description: 'Avatar 自动运行配置、运行日志、知识源表',
  sql: [
    `CREATE TABLE IF NOT EXISTS avatar_autorun_config (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_ms INTEGER NOT NULL,
      next_run_at INTEGER NOT NULL,
      knowledge_source_ids_json TEXT NOT NULL DEFAULT '[]',
      drift_check_interval_ms INTEGER NOT NULL DEFAULT 86400000,
      drift_threshold REAL NOT NULL DEFAULT 0.3,
      review_required INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER,
      last_drift_check_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_autorun_config_avatar ON avatar_autorun_config(tenant_id, avatar_id)',
    'CREATE INDEX IF NOT EXISTS idx_autorun_config_due ON avatar_autorun_config(tenant_id, enabled, next_run_at)',

    `CREATE TABLE IF NOT EXISTS avatar_autorun_runlog (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      avatar_id TEXT NOT NULL,
      config_id TEXT NOT NULL REFERENCES avatar_autorun_config(id),
      task_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),
      metrics_json TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_autorun_runlog_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, started_at)',

    `CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('rss','api','file','manual')),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL,
      state_json TEXT,
      last_ingested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources(tenant_id, enabled, type)',
  ],
};

/** v030: 知识源支持 LLM 类型 */
const v030_knowledge_source_llm: Migration = {
  version: 'v030',
  description: '知识源支持 LLM 类型（重建 CHECK 约束）',
  sql: [
    /* SQLite 不支持 ALTER CHECK，需要重建表 */
    `CREATE TABLE IF NOT EXISTS knowledge_sources_new (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('rss','api','file','manual','llm')),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL,
      state_json TEXT,
      last_ingested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO knowledge_sources_new
     SELECT id, tenant_id, type, name, enabled, config_json, state_json, last_ingested_at, created_at, updated_at
     FROM knowledge_sources`,
    'DROP TABLE IF EXISTS knowledge_sources',
    'ALTER TABLE knowledge_sources_new RENAME TO knowledge_sources',
    'CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources(tenant_id, enabled, type)',
  ],
};

/** v031: 补充缺失的查询性能索引 */
const v031_missing_indexes: Migration = {
  version: 'v031',
  description: '补充 audit_log、subscriptions、pending_updates 等表的查询索引',
  sql: [
    /* 审计日志按租户+时间查询 */
    'CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_timestamp ON audit_log(tenant_id, timestamp)',
    /* 订阅按租户+状态查询 */
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_status ON subscriptions(tenant_id, status)',
    /* 待更新按状态+创建时间查询 */
    'CREATE INDEX IF NOT EXISTS idx_pending_updates_status ON pending_updates(status, created_at)',
    /* 冲突按解决状态+检测时间查询 */
    'CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON conflicts(resolved_at, detected_at)',
    /* 工作记忆按分数排序 */
    'CREATE INDEX IF NOT EXISTS idx_working_memory_score ON working_memory(score DESC)',
    /* autorun 配置按下次运行时间查询 */
    'CREATE INDEX IF NOT EXISTS idx_autorun_config_next_run ON avatar_autorun_config(enabled, next_run_at)',
    /* autorun 日志按租户+头像+时间查询 */
    'CREATE INDEX IF NOT EXISTS idx_autorun_runlog_tenant_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, created_at DESC)',
  ],
};

/** v032: Persona Core / Marketplace / Governance 平台化切片 */
const v032_persona_core_platform: Migration = {
  version: 'v032',
  description: 'Persona Core 2.0：核心人格、钱包、市场、治理与成长事件',
  sql: [
    `CREATE TABLE IF NOT EXISTS persona_core (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      display_name TEXT NOT NULL,
      profile_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN ('active','restricted','deceased','transferred')),
      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','shared','marketplace')),
      growth_index REAL NOT NULL DEFAULT 0 CHECK(growth_index >= 0),
      reputation REAL NOT NULL DEFAULT 0,
      training_investment REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deceased_at INTEGER,
      transferred_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_core_owner ON persona_core(tenant_id, owner_user_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_persona_core_status ON persona_core(tenant_id, status)',

    `CREATE TABLE IF NOT EXISTS persona_wallets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL UNIQUE REFERENCES persona_core(id) ON DELETE CASCADE,
      wallet_address TEXT NOT NULL UNIQUE,
      balance REAL NOT NULL DEFAULT 0,
      token_balance REAL NOT NULL DEFAULT 0,
      last_settled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_wallets_persona ON persona_wallets(tenant_id, persona_id)',

    `CREATE TABLE IF NOT EXISTS persona_forks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      fork_type TEXT NOT NULL CHECK(fork_type IN ('experimental','task','social','research','operations')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','recycled','archived')),
      sync_mode TEXT NOT NULL DEFAULT 'core' CHECK(sync_mode IN ('core','isolated')),
      experience_factor REAL NOT NULL DEFAULT 1 CHECK(experience_factor >= 0 AND experience_factor <= 2),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      recycled_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_forks_persona ON persona_forks(tenant_id, persona_id, status)',

    `CREATE TABLE IF NOT EXISTS persona_memories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('interaction','task','training','knowledge','governance')),
      summary TEXT NOT NULL,
      content_json TEXT NOT NULL DEFAULT '{}',
      importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_memories_persona ON persona_memories(tenant_id, persona_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS persona_knowledge_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      tags_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_knowledge_persona ON persona_knowledge_items(tenant_id, persona_id, updated_at DESC)',

    `CREATE TABLE IF NOT EXISTS marketplace_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      publisher_user_id TEXT NOT NULL REFERENCES users(id),
      assignee_persona_id TEXT REFERENCES persona_core(id) ON DELETE SET NULL,
      assignee_fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('writing','coding','research','operations','general')),
      reward REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'CRED',
      status TEXT NOT NULL CHECK(status IN ('open','accepted','completed','cancelled')),
      quality_score REAL,
      growth_delta REAL,
      published_at INTEGER NOT NULL,
      accepted_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_marketplace_tasks_status ON marketplace_tasks(tenant_id, status, updated_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_marketplace_tasks_assignee ON marketplace_tasks(tenant_id, assignee_persona_id, updated_at DESC)',

    `CREATE TABLE IF NOT EXISTS persona_growth_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES marketplace_tasks(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('task_completed','training','knowledge_sync','governance')),
      growth_delta REAL NOT NULL DEFAULT 0,
      reputation_delta REAL NOT NULL DEFAULT 0,
      training_delta REAL NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_growth_events_persona ON persona_growth_events(tenant_id, persona_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS persona_governance_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK(event_type IN ('warning','reward','restriction','review','transfer','death')),
      severity INTEGER NOT NULL CHECK(severity >= 1 AND severity <= 5),
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_governance_events_persona ON persona_governance_events(tenant_id, persona_id, created_at DESC)',
  ],
};

/** v033: Persona OS 认知记忆层 */
const v033_persona_cognitive_memory: Migration = {
  version: 'v033',
  description: 'Persona OS：persona 级认知记忆、关联边与工作记忆',
  sql: [
    `CREATE TABLE IF NOT EXISTS persona_memory_nodes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,
      source_memory_id TEXT UNIQUE REFERENCES persona_memories(id) ON DELETE SET NULL,
      knowledge_item_id TEXT UNIQUE REFERENCES persona_knowledge_items(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('episodic','semantic','procedural')),
      content TEXT NOT NULL,
      valence REAL NOT NULL DEFAULT 0 CHECK(valence >= -1 AND valence <= 1),
      salience REAL NOT NULL DEFAULT 0.5 CHECK(salience >= 0 AND salience <= 1),
      access_count INTEGER NOT NULL DEFAULT 0,
      decay_lambda REAL NOT NULL DEFAULT 0.0001,
      last_accessed_at INTEGER NOT NULL,
      last_decayed_at INTEGER NOT NULL,
      consolidated_from TEXT REFERENCES persona_memory_nodes(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_memory_nodes_persona ON persona_memory_nodes(tenant_id, persona_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_persona_memory_nodes_kind ON persona_memory_nodes(tenant_id, persona_id, kind, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS persona_memory_edges (
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      source TEXT NOT NULL REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,
      strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),
      relation TEXT NOT NULL,
      PRIMARY KEY (source, target)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_memory_edges_target ON persona_memory_edges(tenant_id, persona_id, target)',

    `CREATE TABLE IF NOT EXISTS persona_working_memory (
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      memory_id TEXT PRIMARY KEY REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      entered_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_working_memory_score ON persona_working_memory(tenant_id, persona_id, score DESC)',
  ],
};

/** v034: Persona OS 生命周期、转移、声誉历史与分析支撑 */
const v034_persona_operating_system_alignment: Migration = {
  version: 'v034',
  description: 'Persona OS v1 对齐：生命周期状态、转移记录、声誉历史与分析表',
  sql: [
    '/* safe:add-column:persona_core:lifecycle_status */ ALTER TABLE persona_core ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT \'active\'',
    'UPDATE persona_core SET lifecycle_status = status WHERE lifecycle_status IS NULL OR lifecycle_status = \'active\'',
    'CREATE INDEX IF NOT EXISTS idx_persona_core_lifecycle_status ON persona_core(tenant_id, lifecycle_status, updated_at DESC)',

    `CREATE TABLE IF NOT EXISTS persona_transfers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      from_owner_user_id TEXT NOT NULL REFERENCES users(id),
      to_owner_user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('pending_review','approved','completed','rejected','cancelled')),
      reason TEXT NOT NULL DEFAULT '',
      requested_at INTEGER NOT NULL,
      approved_at INTEGER,
      completed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_persona_transfers_persona ON persona_transfers(tenant_id, persona_id, requested_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_persona_transfers_target ON persona_transfers(tenant_id, to_owner_user_id, requested_at DESC)',

    `CREATE TABLE IF NOT EXISTS reputation_history (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      old_score REAL NOT NULL,
      new_score REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_reputation_history_persona ON reputation_history(tenant_id, persona_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS persona_daily_metrics (
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      metric_date TEXT NOT NULL,
      tasks_completed INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      reputation_score REAL NOT NULL DEFAULT 0,
      growth_index REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, persona_id, metric_date)
    )`,
    `CREATE TABLE IF NOT EXISTS marketplace_daily_metrics (
      tenant_id TEXT NOT NULL,
      metric_date TEXT NOT NULL,
      open_tasks INTEGER NOT NULL DEFAULT 0,
      completed_tasks INTEGER NOT NULL DEFAULT 0,
      gross_volume REAL NOT NULL DEFAULT 0,
      active_personas INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, metric_date)
    )`,
  ],
};

/** v035: Runtime / Marketplace workflow / Governance case-action */
const v035_persona_runtime_marketplace_governance: Migration = {
  version: 'v035',
  description: 'Persona OS v1：runtime session、任务工作流与治理 case/action',
  sql: [
    `CREATE TABLE IF NOT EXISTS task_applications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      ranking_score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('submitted','assigned','rejected','withdrawn')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_task_applications_unique ON task_applications(tenant_id, task_id, persona_id)',
    'CREATE INDEX IF NOT EXISTS idx_task_applications_task ON task_applications(tenant_id, task_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_task_applications_persona ON task_applications(tenant_id, persona_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS task_assignments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      application_id TEXT REFERENCES task_applications(id) ON DELETE SET NULL,
      runtime_session_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('assigned','in_progress','submitted','accepted','rejected','disputed','completed')),
      assigned_at INTEGER NOT NULL,
      started_at INTEGER,
      submitted_at INTEGER,
      completed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(tenant_id, task_id, assigned_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_task_assignments_persona ON task_assignments(tenant_id, persona_id, assigned_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_task_assignments_status ON task_assignments(tenant_id, status, assigned_at DESC)',

    `CREATE TABLE IF NOT EXISTS runtime_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,
      assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK(state IN ('PLAN','EXECUTE','EVALUATE','MEMORY_UPDATE','REPUTATION_UPDATE','COMPLETED','ERROR')),
      plan_json TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      evaluation_json TEXT,
      result_summary_json TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task ON runtime_sessions(tenant_id, task_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_runtime_sessions_persona ON runtime_sessions(tenant_id, persona_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_runtime_sessions_assignment ON runtime_sessions(tenant_id, assignment_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS task_results (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
      result_uri TEXT NOT NULL,
      evaluation_json TEXT NOT NULL DEFAULT '{}',
      quality_score REAL,
      client_rating INTEGER,
      status TEXT NOT NULL CHECK(status IN ('submitted','accepted','rejected','disputed')),
      rejection_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accepted_at INTEGER,
      rejected_at INTEGER,
      disputed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_task_results_assignment ON task_results(tenant_id, assignment_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_task_results_task ON task_results(tenant_id, task_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS governance_cases (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES marketplace_tasks(id) ON DELETE SET NULL,
      trigger_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
      status TEXT NOT NULL CHECK(status IN ('open','action_applied','appealed','resolved')),
      details_json TEXT NOT NULL DEFAULT '{}',
      appeal_json TEXT,
      opened_at INTEGER NOT NULL,
      resolved_at INTEGER,
      appealed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_governance_cases_persona ON governance_cases(tenant_id, persona_id, opened_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_governance_cases_status ON governance_cases(tenant_id, status, opened_at DESC)',

    `CREATE TABLE IF NOT EXISTS governance_actions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      case_id TEXT NOT NULL REFERENCES governance_cases(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL CHECK(action_type IN ('warning','temporary_restriction','temporary_suspension','reinstate','termination')),
      duration_seconds INTEGER,
      details_json TEXT NOT NULL DEFAULT '{}',
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_governance_actions_case ON governance_actions(tenant_id, case_id, created_at DESC)',
  ],
};

/** v036: Wallet ledger / payout / settlement */
const v036_persona_wallet_ledger: Migration = {
  version: 'v036',
  description: 'Persona OS v1：钱包账本、提现请求与任务结算',
  sql: [
    '/* safe:add-column:persona_wallets:currency */ ALTER TABLE persona_wallets ADD COLUMN currency TEXT NOT NULL DEFAULT \'CRED\'',
    '/* safe:add-column:persona_wallets:status */ ALTER TABLE persona_wallets ADD COLUMN status TEXT NOT NULL DEFAULT \'active\'',

    `CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('task_payment','platform_fee','owner_payout','persona_reserve','refund')),
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet ON wallet_transactions(tenant_id, wallet_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference ON wallet_transactions(tenant_id, reference_type, reference_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS wallet_payout_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed','rejected')),
      requested_by_user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_wallet_payout_requests_wallet ON wallet_payout_requests(tenant_id, wallet_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS wallet_settlements (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES task_assignments(id) ON DELETE CASCADE,
      total_amount_minor INTEGER NOT NULL CHECK(total_amount_minor > 0),
      currency TEXT NOT NULL,
      owner_pct INTEGER NOT NULL,
      persona_pct INTEGER NOT NULL,
      platform_pct INTEGER NOT NULL,
      owner_amount_minor INTEGER NOT NULL,
      persona_amount_minor INTEGER NOT NULL,
      platform_amount_minor INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_wallet_settlements_wallet ON wallet_settlements(tenant_id, wallet_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_wallet_settlements_task ON wallet_settlements(tenant_id, task_id, created_at DESC)',
  ],
};

/** v037: Persona memory sensitivity / encryption */
const v037_persona_memory_security: Migration = {
  version: 'v037',
  description: 'Persona OS v1：敏感记忆分级与静态加密元数据',
  sql: [
    '/* safe:add-column:persona_memories:sensitivity */ ALTER TABLE persona_memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT \'private\'',
    '/* safe:add-column:persona_memories:is_encrypted */ ALTER TABLE persona_memories ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0',
    '/* safe:add-column:persona_memories:owner_restricted */ ALTER TABLE persona_memories ADD COLUMN owner_restricted INTEGER NOT NULL DEFAULT 0',
    'CREATE INDEX IF NOT EXISTS idx_persona_memories_sensitivity ON persona_memories(tenant_id, persona_id, sensitivity, created_at DESC)',
  ],
};

/** v038: Async observability outbox / rollups */
const v038_observability_pipeline: Migration = {
  version: 'v038',
  description: '企业可观测性：异步观测发件箱与聚合滚动表',
  sql: [
    `CREATE TABLE IF NOT EXISTS observability_outbox (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      event_type TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      processed_at INTEGER,
      last_error TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_observability_outbox_status ON observability_outbox(status, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_observability_outbox_tenant ON observability_outbox(tenant_id, status, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_observability_outbox_topic ON observability_outbox(topic, partition_key, created_at ASC)',

    `CREATE TABLE IF NOT EXISTS observability_rollups (
      tenant_id TEXT PRIMARY KEY,
      runtime_completed_count INTEGER NOT NULL DEFAULT 0,
      runtime_duration_total_ms INTEGER NOT NULL DEFAULT 0,
      task_terminal_count INTEGER NOT NULL DEFAULT 0,
      task_success_count INTEGER NOT NULL DEFAULT 0,
      task_rejected_count INTEGER NOT NULL DEFAULT 0,
      task_disputed_count INTEGER NOT NULL DEFAULT 0,
      wallet_settlement_count INTEGER NOT NULL DEFAULT 0,
      wallet_settlement_total_amount_minor INTEGER NOT NULL DEFAULT 0,
      wallet_settlement_latency_total_ms INTEGER NOT NULL DEFAULT 0,
      governance_case_opened_count INTEGER NOT NULL DEFAULT 0,
      governance_case_active_count INTEGER NOT NULL DEFAULT 0,
      governance_action_applied_count INTEGER NOT NULL DEFAULT 0,
      persona_growth_total REAL NOT NULL DEFAULT 0,
      persona_growth_event_count INTEGER NOT NULL DEFAULT 0,
      persona_reputation_delta_total REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`,
  ],
};

/** v039: 通用幂等键缓存 */
const v039_idempotency_keys: Migration = {
  version: 'v039',
  description: '企业可靠性：通用 Idempotency-Key 响应缓存',
  sql: [
    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_method TEXT NOT NULL,
      request_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('in_progress','completed')),
      response_status INTEGER,
      response_content_type TEXT,
      response_headers_json TEXT,
      response_body TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_scope ON idempotency_keys(tenant_id, scope_key, idempotency_key)',
    'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expiry ON idempotency_keys(expires_at)',
  ],
};

/** v040: 审计日志扩展为请求审计 + 业务审计 */
const v040_audit_log_extended: Migration = {
  version: 'v040',
  description: '企业审计：扩展 audit_log 支持业务级审计事件',
  sql: [
    '/* safe:add-column:audit_log:created_at */ ALTER TABLE audit_log ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0',
    '/* safe:add-column:audit_log:event_kind */ ALTER TABLE audit_log ADD COLUMN event_kind TEXT NOT NULL DEFAULT \'request\'',
    '/* safe:add-column:audit_log:user_id */ ALTER TABLE audit_log ADD COLUMN user_id TEXT',
    '/* safe:add-column:audit_log:user_email */ ALTER TABLE audit_log ADD COLUMN user_email TEXT',
    '/* safe:add-column:audit_log:action_type */ ALTER TABLE audit_log ADD COLUMN action_type TEXT DEFAULT \'other\'',
    '/* safe:add-column:audit_log:actor_type */ ALTER TABLE audit_log ADD COLUMN actor_type TEXT',
    '/* safe:add-column:audit_log:actor_id */ ALTER TABLE audit_log ADD COLUMN actor_id TEXT',
    '/* safe:add-column:audit_log:target_type */ ALTER TABLE audit_log ADD COLUMN target_type TEXT',
    '/* safe:add-column:audit_log:target_id */ ALTER TABLE audit_log ADD COLUMN target_id TEXT',
    '/* safe:add-column:audit_log:payload_json */ ALTER TABLE audit_log ADD COLUMN payload_json TEXT',
    'UPDATE audit_log SET created_at = timestamp WHERE created_at = 0',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created_at ON audit_log(tenant_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(tenant_id, actor_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(tenant_id, target_type, target_id, created_at DESC)',
  ],
};

/** v041: runtime session timeout / retry / terminal recovery */
const v041_runtime_failure_recovery: Migration = {
  version: 'v041',
  description: '企业可靠性：runtime session 超时、重试与终态恢复',
  sql: [
    'ALTER TABLE runtime_sessions RENAME TO runtime_sessions_legacy_v041',
    `CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,
      assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK(state IN ('PLAN','EXECUTE','EVALUATE','MEMORY_UPDATE','REPUTATION_UPDATE','COMPLETED','FAILED','TIMEOUT','ERROR')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      timeout_at INTEGER,
      plan_json TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      evaluation_json TEXT,
      result_summary_json TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
    `INSERT INTO runtime_sessions (
      id, tenant_id, persona_id, task_id, assignment_id, state, retry_count, timeout_at,
      plan_json, artifacts_json, evaluation_json, result_summary_json, error_json,
      created_at, updated_at, completed_at
    )
    SELECT
      id,
      tenant_id,
      persona_id,
      task_id,
      assignment_id,
      CASE WHEN state = 'ERROR' THEN 'FAILED' ELSE state END,
      0,
      NULL,
      plan_json,
      artifacts_json,
      evaluation_json,
      result_summary_json,
      error_json,
      created_at,
      updated_at,
      completed_at
    FROM runtime_sessions_legacy_v041`,
    'DROP TABLE runtime_sessions_legacy_v041',
    'CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task ON runtime_sessions(tenant_id, task_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_runtime_sessions_persona ON runtime_sessions(tenant_id, persona_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_runtime_sessions_assignment ON runtime_sessions(tenant_id, assignment_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_runtime_sessions_timeout ON runtime_sessions(tenant_id, state, timeout_at)',
  ],
};

/** v042: 平台 DLQ 持久化与 replay 支撑 */
const v042_platform_dlq: Migration = {
  version: 'v042',
  description: '企业可靠性：平台 DLQ 事件持久化与 replay',
  sql: [
    `CREATE TABLE IF NOT EXISTS platform_dlq_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      source_component TEXT NOT NULL,
      source_topic TEXT NOT NULL,
      dlq_topic TEXT NOT NULL CHECK(dlq_topic IN ('runtime.dlq','wallet.dlq','governance.dlq')),
      event_type TEXT NOT NULL,
      partition_key TEXT,
      payload_json TEXT NOT NULL,
      error_message TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','replayed')),
      created_at INTEGER NOT NULL,
      replayed_at INTEGER
    )`,
    'CREATE INDEX IF NOT EXISTS idx_platform_dlq_status ON platform_dlq_events(status, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_platform_dlq_tenant ON platform_dlq_events(tenant_id, status, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_platform_dlq_topic ON platform_dlq_events(dlq_topic, status, created_at ASC)',
  ],
};

/** v043: organization/workspace/membership/role_binding */
const v043_organizations: Migration = {
  version: 'v043',
  description: '企业协作：organization/workspace/membership/role_binding',
  sql: [
    `CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(tenant_id, slug)',
    'CREATE INDEX IF NOT EXISTS idx_organizations_creator ON organizations(tenant_id, created_by_user_id, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(tenant_id, organization_id, slug)',
    'CREATE INDEX IF NOT EXISTS idx_workspaces_default ON workspaces(tenant_id, organization_id, is_default)',

    `CREATE TABLE IF NOT EXISTS organization_memberships (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('active','invited','suspended')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_org_memberships_unique ON organization_memberships(tenant_id, organization_id, user_id)',
    'CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON organization_memberships(tenant_id, user_id, status, created_at DESC)',

    `CREATE TABLE IF NOT EXISTS organization_role_bindings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      membership_id TEXT NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('org_admin','billing_admin','persona_operator','marketplace_manager','auditor','viewer')),
      created_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_org_role_bindings_unique ON organization_role_bindings(tenant_id, organization_id, workspace_id, membership_id, role)',
    'CREATE INDEX IF NOT EXISTS idx_org_role_bindings_membership ON organization_role_bindings(tenant_id, membership_id, role)',
  ],
};

/** v044: billing catalog / invoices / usage meters */
const v044_enterprise_billing: Migration = {
  version: 'v044',
  description: '企业商用：billing catalog、invoice、usage meter',
  sql: [
    `CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stripe_price_id TEXT NOT NULL DEFAULT '',
      price_minor INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      billing_interval TEXT NOT NULL DEFAULT 'month',
      limits_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_billing_plans_active ON billing_plans(is_active, id)',

    `CREATE TABLE IF NOT EXISTS billing_invoices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES billing_plans(id),
      status TEXT NOT NULL CHECK(status IN ('draft','open','paid','void')),
      amount_minor INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      billing_interval TEXT NOT NULL DEFAULT 'month',
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      wallet_settlement_count INTEGER NOT NULL DEFAULT 0,
      wallet_settlement_total_minor INTEGER NOT NULL DEFAULT 0,
      reconciliation_status TEXT NOT NULL DEFAULT 'balanced' CHECK(reconciliation_status IN ('balanced','mismatch','repair_required')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      paid_at INTEGER
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_period ON billing_invoices(tenant_id, subscription_id, period_start)',
    'CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant ON billing_invoices(tenant_id, status, period_start DESC)',

    `CREATE TABLE IF NOT EXISTS usage_meters (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      total_quantity INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_meters_period ON usage_meters(tenant_id, resource, period_start, period_end)',
    'CREATE INDEX IF NOT EXISTS idx_usage_meters_tenant ON usage_meters(tenant_id, period_start DESC, resource)',
  ],
};

/** v045: settlement reconciliation runs */
const v045_settlement_reconciliation: Migration = {
  version: 'v045',
  description: '企业财务：settlement reconciliation runs',
  sql: [
    `CREATE TABLE IF NOT EXISTS settlement_reconciliation_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      checked_settlements INTEGER NOT NULL DEFAULT 0,
      mismatched_settlements INTEGER NOT NULL DEFAULT 0,
      repaired_settlements INTEGER NOT NULL DEFAULT 0,
      deleted_transactions INTEGER NOT NULL DEFAULT 0,
      inserted_transactions INTEGER NOT NULL DEFAULT 0,
      orphan_transactions_removed INTEGER NOT NULL DEFAULT 0,
      report_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_settlement_reconciliation_runs_tenant ON settlement_reconciliation_runs(tenant_id, created_at DESC)',
  ],
};

/** v046: tenant enterprise profile / oidc / scim / dedicated deployment */
const v046_tenant_enterprise_profile: Migration = {
  version: 'v046',
  description: '企业集成：tenant enterprise profile / oidc / scim / dedicated deployment',
  sql: [
    `CREATE TABLE IF NOT EXISTS tenant_enterprise_profiles (
      tenant_id TEXT PRIMARY KEY,
      deployment_mode TEXT NOT NULL DEFAULT 'shared_cluster' CHECK(deployment_mode IN ('shared_cluster','dedicated_db')),
      database_isolation_mode TEXT NOT NULL DEFAULT 'shared' CHECK(database_isolation_mode IN ('shared','dedicated')),
      kafka_namespace TEXT NOT NULL DEFAULT '',
      encryption_mode TEXT NOT NULL DEFAULT 'platform_managed' CHECK(encryption_mode IN ('platform_managed','tenant_dedicated')),
      kms_key_ref TEXT,
      scim_token_hash TEXT,
      oidc_enabled INTEGER NOT NULL DEFAULT 0,
      oidc_issuer_url TEXT NOT NULL DEFAULT '',
      oidc_client_id TEXT NOT NULL DEFAULT '',
      oidc_client_secret_encrypted TEXT NOT NULL DEFAULT '',
      oidc_audience TEXT NOT NULL DEFAULT '',
      oidc_scope TEXT NOT NULL DEFAULT 'openid profile email',
      oidc_email_claim TEXT NOT NULL DEFAULT 'email',
      oidc_name_claim TEXT NOT NULL DEFAULT 'name',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_enterprise_profiles_scim_hash ON tenant_enterprise_profiles(scim_token_hash)',
  ],
};

/** v047: tenant 可包含多个 identities（企业多用户） */
const v047_multi_identity_per_tenant: Migration = {
  version: 'v047',
  description: '身份层重构：tenant 可包含多个 identities 与独立 avatar 生命周期',
  sql: [
    `CREATE TABLE IF NOT EXISTS identities_new (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO identities_new (id, user_id, tenant_id, display_name, bio, created_at, updated_at)
     SELECT id, user_id, tenant_id, display_name, bio, created_at, updated_at
     FROM identities`,

    `CREATE TABLE IF NOT EXISTS avatars_new (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES identities_new(id),
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'general'
        CHECK(kind IN ('general','work','social','family','creative')),
      behavior_overrides TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO avatars_new (id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at)
     SELECT id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at
     FROM avatars`,

    `CREATE TABLE IF NOT EXISTS device_avatars_new (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      avatar_id TEXT NOT NULL REFERENCES avatars_new(id),
      is_active INTEGER NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL,
      UNIQUE(device_id, avatar_id)
    )`,
    `INSERT OR IGNORE INTO device_avatars_new (id, device_id, avatar_id, is_active, installed_at)
     SELECT id, device_id, avatar_id, is_active, installed_at
     FROM device_avatars`,

    `CREATE TABLE IF NOT EXISTS avatar_autorun_config_new (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      avatar_id TEXT NOT NULL REFERENCES avatars_new(id),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_ms INTEGER NOT NULL,
      next_run_at INTEGER NOT NULL,
      knowledge_source_ids_json TEXT NOT NULL DEFAULT '[]',
      drift_check_interval_ms INTEGER NOT NULL DEFAULT 86400000,
      drift_threshold REAL NOT NULL DEFAULT 0.3,
      review_required INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER,
      last_drift_check_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO avatar_autorun_config_new (
      id, tenant_id, avatar_id, enabled, interval_ms, next_run_at,
      knowledge_source_ids_json, drift_check_interval_ms, drift_threshold, review_required,
      last_run_at, last_drift_check_at, last_error, created_at, updated_at
    )
     SELECT
      id, tenant_id, avatar_id, enabled, interval_ms, next_run_at,
      knowledge_source_ids_json, drift_check_interval_ms, drift_threshold, review_required,
      last_run_at, last_drift_check_at, last_error, created_at, updated_at
     FROM avatar_autorun_config`,

    `CREATE TABLE IF NOT EXISTS avatar_autorun_runlog_new (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      avatar_id TEXT NOT NULL,
      config_id TEXT NOT NULL REFERENCES avatar_autorun_config_new(id),
      task_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),
      metrics_json TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO avatar_autorun_runlog_new (
      id, tenant_id, avatar_id, config_id, task_id, status, metrics_json, error, started_at, completed_at, created_at
    )
     SELECT id, tenant_id, avatar_id, config_id, task_id, status, metrics_json, error, started_at, completed_at, created_at
     FROM avatar_autorun_runlog`,

    'DROP TABLE IF EXISTS avatar_autorun_runlog',
    'DROP TABLE IF EXISTS avatar_autorun_config',
    'DROP TABLE IF EXISTS device_avatars',
    'DROP TABLE IF EXISTS avatars',
    'DROP TABLE IF EXISTS identities',

    'ALTER TABLE identities_new RENAME TO identities',
    'ALTER TABLE avatars_new RENAME TO avatars',
    'ALTER TABLE device_avatars_new RENAME TO device_avatars',
    'ALTER TABLE avatar_autorun_config_new RENAME TO avatar_autorun_config',
    'ALTER TABLE avatar_autorun_runlog_new RENAME TO avatar_autorun_runlog',

    'CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_identities_tenant_user ON identities(tenant_id, user_id)',
    'CREATE INDEX IF NOT EXISTS idx_avatars_identity ON avatars(identity_id)',
    'CREATE INDEX IF NOT EXISTS idx_device_avatars_device ON device_avatars(device_id)',
    'CREATE INDEX IF NOT EXISTS idx_device_avatars_avatar ON device_avatars(avatar_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_autorun_config_avatar ON avatar_autorun_config(tenant_id, avatar_id)',
    'CREATE INDEX IF NOT EXISTS idx_autorun_config_due ON avatar_autorun_config(tenant_id, enabled, next_run_at)',
    'CREATE INDEX IF NOT EXISTS idx_autorun_config_next_run ON avatar_autorun_config(enabled, next_run_at)',
    'CREATE INDEX IF NOT EXISTS idx_autorun_runlog_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, started_at)',
    'CREATE INDEX IF NOT EXISTS idx_autorun_runlog_tenant_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, created_at DESC)',
  ],
};

/** v048: observability processed-event 去重表 */
const v048_observability_processed_events: Migration = {
  version: 'v048',
  description: '观测链路：为 Kafka / DB 双路径增加 rollup 幂等去重',
  sql: [
    `CREATE TABLE IF NOT EXISTS observability_processed_events (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      processed_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_observability_processed_events_tenant ON observability_processed_events(tenant_id, processed_at DESC)',
  ],
};

/** v049: 导出任务追踪表 */
const v049_export_jobs: Migration = {
  version: 'v049',
  description: '可移植性：异步导出任务状态追踪',
  sql: [
    `CREATE TABLE IF NOT EXISTS export_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      percent INTEGER NOT NULL DEFAULT 0,
      eta_ms INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      download_url TEXT,
      error_code TEXT,
      warnings TEXT NOT NULL DEFAULT '[]',
      pack_json TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant ON export_jobs(tenant_id, created_at DESC)',
  ],
};

/** v050: KMS 密钥审计日志 */
const v050_kms_key_audit: Migration = {
  version: 'v050',
  description: 'KMS 密钥操作审计日志',
  sql: [
    `CREATE TABLE IF NOT EXISTS kms_key_audit (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      provider TEXT NOT NULL,
      key_ref TEXT NOT NULL,
      performed_at TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error_code TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_kms_key_audit_tenant ON kms_key_audit(tenant_id, performed_at DESC)',
  ],
};

/** v051: 租户自带对象存储（BYOS）配置列 */
const v051_tenant_byos_object_storage: Migration = {
  version: 'v051',
  description: '租户自带对象存储（BYOS）配置',
  sql: [
    `/* safe:add-column:tenant_enterprise_profiles:byos_provider */ ALTER TABLE tenant_enterprise_profiles ADD COLUMN byos_provider TEXT NOT NULL DEFAULT 'platform'`,
    `/* safe:add-column:tenant_enterprise_profiles:byos_bucket */ ALTER TABLE tenant_enterprise_profiles ADD COLUMN byos_bucket TEXT NOT NULL DEFAULT ''`,
    `/* safe:add-column:tenant_enterprise_profiles:byos_key_prefix */ ALTER TABLE tenant_enterprise_profiles ADD COLUMN byos_key_prefix TEXT NOT NULL DEFAULT ''`,
  ],
};

/** v052: 事件账本核心表（event_ledger、消费者检查点、权威模式控制） */
const v052_event_ledger: Migration = {
  version: 'v052',
  description: '事件账本：event_ledger 主表、消费者检查点与权威模式控制表',
  sql: [
    `CREATE TABLE IF NOT EXISTS event_ledger (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      occurred_at INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      backfill_source_id TEXT,
      UNIQUE(tenant_id, stream_id, stream_version)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_event_ledger_stream ON event_ledger(tenant_id, stream_id, stream_version)`,
    `CREATE INDEX IF NOT EXISTS idx_event_ledger_tenant ON event_ledger(tenant_id, occurred_at)`,
    `CREATE TABLE IF NOT EXISTS event_ledger_consumer_checkpoints (
      consumer_id TEXT PRIMARY KEY,
      last_event_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS event_ledger_authority (
      singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK(singleton = 1),
      mode TEXT NOT NULL DEFAULT 'tables_primary',
      changed_at INTEGER NOT NULL,
      changed_reason TEXT NOT NULL DEFAULT ''
    )`,
    `INSERT OR IGNORE INTO event_ledger_authority(singleton, mode, changed_at) VALUES(1, 'tables_primary', 0)`,
  ],
};

/** v053: persona_core 双写发件箱（用于 dual_write / ledger_primary 模式） */
const v053_persona_core_ledger_outbox: Migration = {
  version: 'v053',
  description: 'persona_core 双写发件箱：暂存待追加至 event_ledger 的事件',
  sql: [
    `CREATE TABLE IF NOT EXISTS persona_core_ledger_outbox (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      event_type TEXT NOT NULL,
      command_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempted_at INTEGER,
      error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_persona_outbox_pending ON persona_core_ledger_outbox(tenant_id, created_at) WHERE attempts < 3`,
  ],
};

/** v054: 投影存储表 */
const v054_projection_store: Migration = {
  version: 'v054',
  description: '投影存储：读模型持久化，支持按租户+投影名+ID读写',
  sql: [
    `CREATE TABLE IF NOT EXISTS projection_store (
      tenant_id TEXT NOT NULL,
      projection TEXT NOT NULL,
      id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, projection, id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_projection_store_list ON projection_store(tenant_id, projection, id)`,
  ],
};

/** v055: 平台密钥撤销记录表 */
const v055_platform_key_revocations: Migration = {
  version: 'v055',
  description: '平台密钥撤销记录',
  sql: [
    `CREATE TABLE IF NOT EXISTS platform_key_revocations (
      key_ref TEXT PRIMARY KEY,
      revoked_at INTEGER NOT NULL,
      revoked_by TEXT
    )`,
  ],
};

/** v056: 平台运维操作日志表 */
const v056_platform_ops_log: Migration = {
  version: 'v056',
  description: '平台运维操作日志（控制平面事件）',
  sql: [
    `CREATE TABLE IF NOT EXISTS platform_ops_log (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_platform_ops_log_time ON platform_ops_log(occurred_at DESC)`,
  ],
};

/** v057: 同步冲突收件箱 */
const v057_conflict_inbox: Migration = {
  version: 'v057',
  description: '同步冲突收件箱',
  sql: [
    `CREATE TABLE IF NOT EXISTS conflict_inbox (
      conflict_id TEXT PRIMARY KEY,
      conflict_version TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      command_id TEXT,
      source_runtime TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      local_summary_id TEXT NOT NULL,
      local_summary_params TEXT NOT NULL DEFAULT '{}',
      server_summary_id TEXT NOT NULL,
      server_summary_params TEXT NOT NULL DEFAULT '{}',
      suggested_actions TEXT NOT NULL DEFAULT '["keep_server"]',
      resolved_at TEXT,
      resolution_action TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_conflict_inbox_tenant ON conflict_inbox(tenant_id, detected_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_conflict_inbox_blocking ON conflict_inbox(tenant_id, severity) WHERE resolved_at IS NULL',
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
  v025_config_and_addons,
  v026_mobile_devices,
  v027_identity_avatar,
  v028_memory_eviction_indexes,
  v029_avatar_autorun,
  v030_knowledge_source_llm,
  v031_missing_indexes,
  v032_persona_core_platform,
  v033_persona_cognitive_memory,
  v034_persona_operating_system_alignment,
  v035_persona_runtime_marketplace_governance,
  v036_persona_wallet_ledger,
  v037_persona_memory_security,
  v038_observability_pipeline,
  v039_idempotency_keys,
  v040_audit_log_extended,
  v041_runtime_failure_recovery,
  v042_platform_dlq,
  v043_organizations,
  v044_enterprise_billing,
  v045_settlement_reconciliation,
  v046_tenant_enterprise_profile,
  v047_multi_identity_per_tenant,
  v048_observability_processed_events,
  v049_export_jobs,
  v050_kms_key_audit,
  v051_tenant_byos_object_storage,
  v052_event_ledger,
  v053_persona_core_ledger_outbox,
  v054_projection_store,
  v055_platform_key_revocations,
  v056_platform_ops_log,
  v057_conflict_inbox,
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

/** 检查 SQLite 表是否存在 */
function hasTable(db: IDatabase, table: string): boolean {
  const row = db.prepare<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table);
  return row !== undefined;
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
        /* 处理 safe:add-column 标记：表不存在或列已存在时跳过 */
        const match = ADD_COLUMN_RE.exec(sql);
        if (match) {
          const [, table, column] = match;
          if (!hasTable(db, table) || hasColumn(db, table, column)) continue;
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
