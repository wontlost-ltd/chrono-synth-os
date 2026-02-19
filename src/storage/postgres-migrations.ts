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

/** v011: 演化差异报告（PostgreSQL） */
const v011_evolution_diff_report: Migration = {
  version: 'v011',
  description: '演化差异报告',
  sql: [
    'ALTER TABLE evolution_records ADD COLUMN IF NOT EXISTS diff_report_json TEXT',
  ],
};

/** v012: 人生模拟引擎（PostgreSQL） */
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
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      completed_at BIGINT
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
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_life_sim_paths ON life_simulation_paths(simulation_id)',
  ],
};

/** v013: 用户认证与刷新令牌（PostgreSQL） */
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
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)',
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      is_revoked INTEGER NOT NULL DEFAULT 0,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)',
  ],
};

/** v014: 订阅与用量记录（PostgreSQL） */
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
      current_period_start BIGINT NOT NULL,
      current_period_end BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id)',
    `CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      recorded_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_resource ON usage_records(tenant_id, resource, recorded_at)',
  ],
};

/** v015: 协作分享模拟（PostgreSQL） */
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
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_shared_sims_sim ON shared_simulations(simulation_id)',
    'CREATE INDEX IF NOT EXISTS idx_shared_sims_shared_with ON shared_simulations(shared_with_user_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_sims_unique ON shared_simulations(simulation_id, shared_with_user_id)',
  ],
};

/** v016: Webhook 幂等性 + LLM 用量持久化（PostgreSQL） */
const v016_webhook_and_llm_usage: Migration = {
  version: 'v016',
  description: 'Webhook 事件去重表与 LLM 用量持久化表',
  sql: [
    `CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS llm_usage (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      estimated_cost_usd DOUBLE PRECISION NOT NULL,
      recorded_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_tenant ON llm_usage(tenant_id, recorded_at)',
  ],
};

/** v017: 决策与引导会话持久化（PostgreSQL） */
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
      created_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_decision_cases_tenant ON decision_cases(tenant_id)',

    `CREATE TABLE IF NOT EXISTS decision_runs (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES decision_cases(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      result_json TEXT NOT NULL,
      created_at BIGINT NOT NULL
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
      created_at BIGINT NOT NULL
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
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_tenant ON onboarding_sessions(tenant_id)',
  ],
};

const v018_refresh_token_index: Migration = {
  version: 'v018',
  description: '刷新令牌复合索引与过期清理',
  sql: [
    'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash_revoked ON refresh_tokens(token_hash, is_revoked)',
  ],
};

const v019_task_queue_claim: Migration = {
  version: 'v019',
  description: '任务队列安全 — 工作者领取标记',
  sql: [
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_by TEXT',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_at BIGINT',
  ],
};

/** v020: Stripe 计量发件箱 */
const v020_billing_outbox: Migration = {
  version: 'v020',
  description: 'Stripe 计量发件箱 — 持久化重试',
  sql: [
    `CREATE TABLE IF NOT EXISTS billing_outbox (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      processed_at BIGINT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_billing_outbox_status ON billing_outbox (status, created_at)',
  ],
};

/** v021: 任务队列优先级 */
const v021_task_priority: Migration = {
  version: 'v021',
  description: '任务队列优先级支持',
  sql: [
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0',
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
      built_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ws_event_log (
      seq BIGSERIAL PRIMARY KEY,
      event TEXT NOT NULL,
      data_json TEXT NOT NULL,
      tenant_id TEXT,
      created_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_ws_event_log_tenant ON ws_event_log (tenant_id, seq)',
    'CREATE INDEX IF NOT EXISTS idx_ws_event_log_created ON ws_event_log (created_at)',
  ],
};

/** v023: API Key 租户绑定（PostgreSQL） */
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
      created_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash)',
    'CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id)',
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
];
