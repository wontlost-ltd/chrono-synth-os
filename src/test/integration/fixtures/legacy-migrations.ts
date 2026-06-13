export interface LegacySqlMigration {
  readonly version: string;
  readonly description: string;
  readonly sql: readonly string[];
}

export const LEGACY_SQLITE_MIGRATIONS = [
  {
    "version": "v001",
    "description": "初始表结构",
    "sql": [
      "CREATE TABLE IF NOT EXISTS core_values (\n    id TEXT PRIMARY KEY,\n    label TEXT NOT NULL,\n    weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),\n    updated_at INTEGER NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS memory_nodes (\n    id TEXT PRIMARY KEY,\n    kind TEXT NOT NULL CHECK(kind IN ('episodic', 'semantic', 'procedural')),\n    content TEXT NOT NULL,\n    valence REAL NOT NULL CHECK(valence >= -1 AND valence <= 1),\n    salience REAL NOT NULL CHECK(salience >= 0 AND salience <= 1),\n    created_at INTEGER NOT NULL,\n    last_accessed_at INTEGER NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS memory_edges (\n    source TEXT NOT NULL REFERENCES memory_nodes(id),\n    target TEXT NOT NULL REFERENCES memory_nodes(id),\n    strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),\n    relation TEXT NOT NULL,\n    PRIMARY KEY (source, target)\n  )",
      "CREATE TABLE IF NOT EXISTS narrative (\n    id INTEGER PRIMARY KEY CHECK(id = 1),\n    content TEXT NOT NULL,\n    updated_at INTEGER NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS persona_versions (\n    id TEXT PRIMARY KEY,\n    label TEXT NOT NULL,\n    values_json TEXT NOT NULL,\n    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'failed')),\n    results_json TEXT NOT NULL DEFAULT '[]',\n    resource_quota REAL NOT NULL CHECK(resource_quota >= 0 AND resource_quota <= 1),\n    created_at INTEGER NOT NULL,\n    updated_at INTEGER NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS conflicts (\n    id TEXT PRIMARY KEY,\n    kind TEXT NOT NULL,\n    severity TEXT NOT NULL,\n    involved_versions_json TEXT NOT NULL,\n    affected_values_json TEXT NOT NULL,\n    description TEXT NOT NULL,\n    detected_at INTEGER NOT NULL,\n    resolved_at INTEGER,\n    resolution TEXT\n  )",
      "CREATE TABLE IF NOT EXISTS snapshots (\n    id TEXT PRIMARY KEY,\n    data_json TEXT NOT NULL,\n    reason TEXT NOT NULL,\n    created_at INTEGER NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS evolution_records (\n    id TEXT PRIMARY KEY,\n    before_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),\n    after_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),\n    merged_version_ids_json TEXT NOT NULL,\n    value_delta_json TEXT NOT NULL,\n    evolved_at INTEGER NOT NULL\n  )",
      "CREATE INDEX IF NOT EXISTS idx_persona_status ON persona_versions(status)",
      "CREATE INDEX IF NOT EXISTS idx_conflicts_resolved_at ON conflicts(resolved_at)",
      "CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at)",
      "CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target)"
    ]
  },
  {
    "version": "v002",
    "description": "审计日志表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS audit_log (\n    id TEXT PRIMARY KEY,\n    timestamp INTEGER NOT NULL,\n    method TEXT NOT NULL,\n    path TEXT NOT NULL,\n    request_id TEXT NOT NULL,\n    status_code INTEGER NOT NULL,\n    latency_ms REAL NOT NULL\n  )",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_path ON audit_log(path)"
    ]
  },
  {
    "version": "v003",
    "description": "审计日志增加 API Key 哈希字段",
    "sql": [
      "/* safe:add-column:audit_log:api_key_hash */ ALTER TABLE audit_log ADD COLUMN api_key_hash TEXT"
    ]
  },
  {
    "version": "v004",
    "description": "认知记忆扩展",
    "sql": [
      "/* safe:add-column:memory_nodes:access_count */ ALTER TABLE memory_nodes ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
      "/* safe:add-column:memory_nodes:decay_lambda */ ALTER TABLE memory_nodes ADD COLUMN decay_lambda REAL NOT NULL DEFAULT 0.0001",
      "/* safe:add-column:memory_nodes:last_decayed_at */ ALTER TABLE memory_nodes ADD COLUMN last_decayed_at INTEGER NOT NULL DEFAULT 0",
      "/* safe:add-column:memory_nodes:consolidated_from */ ALTER TABLE memory_nodes ADD COLUMN consolidated_from TEXT REFERENCES memory_nodes(id) ON DELETE SET NULL",
      "CREATE TABLE IF NOT EXISTS working_memory (\n      memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,\n      score REAL NOT NULL,\n      entered_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_working_memory_score ON working_memory(score)",
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_salience ON memory_nodes(salience)",
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_kind_access ON memory_nodes(kind, access_count)"
    ]
  },
  {
    "version": "v005",
    "description": "P-OS v0.1 人格模型",
    "sql": [
      "CREATE TABLE IF NOT EXISTS survival_anchors (\n    id TEXT PRIMARY KEY,\n    label TEXT NOT NULL,\n    kind TEXT NOT NULL CHECK(kind IN ('constraint', 'threshold', 'must_have')),\n    value_json TEXT NOT NULL,\n    severity INTEGER NOT NULL CHECK(severity >= 1 AND severity <= 5),\n    created_at INTEGER NOT NULL,\n    updated_at INTEGER NOT NULL\n  )",
      "CREATE INDEX IF NOT EXISTS idx_survival_anchors_kind ON survival_anchors(kind)",
      "CREATE INDEX IF NOT EXISTS idx_survival_anchors_severity ON survival_anchors(severity)",
      "CREATE TABLE IF NOT EXISTS decision_style (\n    id INTEGER PRIMARY KEY CHECK(id = 1),\n    style_json TEXT NOT NULL,\n    updated_at INTEGER NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS cognitive_model (\n    id INTEGER PRIMARY KEY CHECK(id = 1),\n    model_json TEXT NOT NULL,\n    updated_at INTEGER NOT NULL\n  )"
    ]
  },
  {
    "version": "v006",
    "description": "记忆向量索引",
    "sql": [
      "CREATE TABLE IF NOT EXISTS memory_embeddings (\n    memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,\n    embedding_json TEXT NOT NULL,\n    model TEXT NOT NULL,\n    updated_at INTEGER NOT NULL\n  )"
    ]
  },
  {
    "version": "v007",
    "description": "多租户隔离",
    "sql": [
      "/* safe:add-column:core_values:tenant_id */ ALTER TABLE core_values ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:memory_nodes:tenant_id */ ALTER TABLE memory_nodes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:memory_edges:tenant_id */ ALTER TABLE memory_edges ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:memory_embeddings:tenant_id */ ALTER TABLE memory_embeddings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:working_memory:tenant_id */ ALTER TABLE working_memory ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:persona_versions:tenant_id */ ALTER TABLE persona_versions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:conflicts:tenant_id */ ALTER TABLE conflicts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:snapshots:tenant_id */ ALTER TABLE snapshots ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:evolution_records:tenant_id */ ALTER TABLE evolution_records ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:survival_anchors:tenant_id */ ALTER TABLE survival_anchors ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "/* safe:add-column:audit_log:tenant_id */ ALTER TABLE audit_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE narrative RENAME TO narrative_old",
      "CREATE TABLE IF NOT EXISTS narrative (\n      tenant_id TEXT PRIMARY KEY DEFAULT 'default',\n      content TEXT NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "INSERT OR IGNORE INTO narrative (tenant_id, content, updated_at)\n     SELECT 'default', content, updated_at FROM narrative_old",
      "DROP TABLE IF EXISTS narrative_old",
      "ALTER TABLE decision_style RENAME TO decision_style_old",
      "CREATE TABLE IF NOT EXISTS decision_style (\n      tenant_id TEXT PRIMARY KEY DEFAULT 'default',\n      style_json TEXT NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "INSERT OR IGNORE INTO decision_style (tenant_id, style_json, updated_at)\n     SELECT 'default', style_json, updated_at FROM decision_style_old",
      "DROP TABLE IF EXISTS decision_style_old",
      "ALTER TABLE cognitive_model RENAME TO cognitive_model_old",
      "CREATE TABLE IF NOT EXISTS cognitive_model (\n      tenant_id TEXT PRIMARY KEY DEFAULT 'default',\n      model_json TEXT NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "INSERT OR IGNORE INTO cognitive_model (tenant_id, model_json, updated_at)\n     SELECT 'default', model_json, updated_at FROM cognitive_model_old",
      "DROP TABLE IF EXISTS cognitive_model_old",
      "CREATE INDEX IF NOT EXISTS idx_core_values_tenant ON core_values(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant ON memory_nodes(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_persona_versions_tenant ON persona_versions(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_snapshots_tenant ON snapshots(tenant_id)",
      "CREATE TABLE IF NOT EXISTS quota_limits (\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      max_per_window INTEGER NOT NULL,\n      window_ms INTEGER NOT NULL,\n      PRIMARY KEY (tenant_id, resource)\n    )",
      "CREATE TABLE IF NOT EXISTS quota_usage (\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      used INTEGER NOT NULL DEFAULT 0,\n      window_start INTEGER NOT NULL,\n      PRIMARY KEY (tenant_id, resource, window_start)\n    )"
    ]
  },
  {
    "version": "v008",
    "description": "异步任务队列",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tasks (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      type TEXT NOT NULL,\n      payload TEXT NOT NULL DEFAULT '{}',\n      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),\n      result TEXT,\n      error TEXT,\n      retry_count INTEGER NOT NULL DEFAULT 0,\n      max_retries INTEGER NOT NULL DEFAULT 3,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      available_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tasks_status_available ON tasks(status, available_at)",
      "CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id)"
    ]
  },
  {
    "version": "v009",
    "description": "核心价值扩展 time_discount/emotion_amplifier",
    "sql": [
      "/* safe:add-column:core_values:time_discount */ ALTER TABLE core_values ADD COLUMN time_discount REAL NOT NULL DEFAULT 0.5",
      "/* safe:add-column:core_values:emotion_amplifier */ ALTER TABLE core_values ADD COLUMN emotion_amplifier REAL NOT NULL DEFAULT 1.0"
    ]
  },
  {
    "version": "v010",
    "description": "更新闸门 pending_updates",
    "sql": [
      "CREATE TABLE IF NOT EXISTS pending_updates (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      layer TEXT NOT NULL CHECK(layer IN ('L0', 'L1')),\n      trigger_type TEXT NOT NULL,\n      target_id TEXT NOT NULL,\n      current_value TEXT,\n      proposed_value TEXT,\n      delta REAL NOT NULL DEFAULT 0,\n      reason TEXT,\n      created_at INTEGER NOT NULL,\n      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected'))\n    )",
      "CREATE INDEX IF NOT EXISTS idx_pending_updates_status ON pending_updates(status)",
      "CREATE INDEX IF NOT EXISTS idx_pending_updates_tenant ON pending_updates(tenant_id)"
    ]
  },
  {
    "version": "v011",
    "description": "演化差异报告",
    "sql": [
      "/* safe:add-column:evolution_records:diff_report_json */ ALTER TABLE evolution_records ADD COLUMN diff_report_json TEXT"
    ]
  },
  {
    "version": "v012",
    "description": "人生模拟引擎",
    "sql": [
      "CREATE TABLE IF NOT EXISTS life_simulations (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      task_id TEXT NOT NULL,\n      base_simulation_id TEXT REFERENCES life_simulations(id) ON DELETE SET NULL,\n      config_json TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),\n      summary_json TEXT,\n      progress_json TEXT,\n      error TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      completed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_life_sims_tenant ON life_simulations(tenant_id, created_at)",
      "CREATE TABLE IF NOT EXISTS life_simulation_paths (\n      id TEXT PRIMARY KEY,\n      simulation_id TEXT NOT NULL REFERENCES life_simulations(id) ON DELETE CASCADE,\n      path_id TEXT NOT NULL,\n      label TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),\n      summary_json TEXT,\n      timeline_json TEXT,\n      branches_json TEXT,\n      retrospective_json TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_life_sim_paths ON life_simulation_paths(simulation_id)"
    ]
  },
  {
    "version": "v013",
    "description": "用户认证与刷新令牌",
    "sql": [
      "CREATE TABLE IF NOT EXISTS users (\n      id TEXT PRIMARY KEY,\n      email TEXT NOT NULL UNIQUE,\n      password_hash TEXT NOT NULL,\n      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member', 'viewer')),\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)",
      "CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)",
      "CREATE TABLE IF NOT EXISTS refresh_tokens (\n      id TEXT PRIMARY KEY,\n      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      token_hash TEXT NOT NULL,\n      is_revoked INTEGER NOT NULL DEFAULT 0,\n      expires_at INTEGER NOT NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)"
    ]
  },
  {
    "version": "v014",
    "description": "订阅与用量记录",
    "sql": [
      "CREATE TABLE IF NOT EXISTS subscriptions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      stripe_customer_id TEXT,\n      stripe_subscription_id TEXT,\n      plan_id TEXT NOT NULL DEFAULT 'free',\n      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'past_due', 'canceled', 'trialing')),\n      current_period_start INTEGER NOT NULL,\n      current_period_end INTEGER NOT NULL,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id)",
      "CREATE TABLE IF NOT EXISTS usage_records (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      quantity INTEGER NOT NULL DEFAULT 1,\n      recorded_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_resource ON usage_records(tenant_id, resource, recorded_at)"
    ]
  },
  {
    "version": "v015",
    "description": "协作分享模拟",
    "sql": [
      "CREATE TABLE IF NOT EXISTS shared_simulations (\n      id TEXT PRIMARY KEY,\n      simulation_id TEXT NOT NULL,\n      owner_user_id TEXT NOT NULL,\n      shared_with_user_id TEXT NOT NULL,\n      permission TEXT NOT NULL DEFAULT 'view' CHECK(permission IN ('view', 'edit')),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_shared_sims_sim ON shared_simulations(simulation_id)",
      "CREATE INDEX IF NOT EXISTS idx_shared_sims_shared_with ON shared_simulations(shared_with_user_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_sims_unique ON shared_simulations(simulation_id, shared_with_user_id)"
    ]
  },
  {
    "version": "v016",
    "description": "Webhook 事件去重表与 LLM 用量持久化表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS webhook_events (\n      event_id TEXT PRIMARY KEY,\n      event_type TEXT NOT NULL,\n      processed_at INTEGER NOT NULL\n    )",
      "CREATE TABLE IF NOT EXISTS llm_usage (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      tenant_id TEXT NOT NULL,\n      provider TEXT NOT NULL,\n      model TEXT NOT NULL,\n      input_tokens INTEGER NOT NULL,\n      output_tokens INTEGER NOT NULL,\n      total_tokens INTEGER NOT NULL,\n      estimated_cost_usd REAL NOT NULL,\n      recorded_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_llm_usage_tenant ON llm_usage(tenant_id, recorded_at)"
    ]
  },
  {
    "version": "v017",
    "description": "决策案例/运行结果与引导会话持久化",
    "sql": [
      "CREATE TABLE IF NOT EXISTS decision_cases (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      title TEXT NOT NULL,\n      description TEXT NOT NULL,\n      alternatives_json TEXT NOT NULL,\n      constraints_json TEXT,\n      context_json TEXT,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_decision_cases_tenant ON decision_cases(tenant_id)",
      "CREATE TABLE IF NOT EXISTS decision_runs (\n      id TEXT PRIMARY KEY,\n      case_id TEXT NOT NULL REFERENCES decision_cases(id) ON DELETE CASCADE,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      result_json TEXT NOT NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_decision_runs_case ON decision_runs(case_id)",
      "CREATE INDEX IF NOT EXISTS idx_decision_runs_tenant ON decision_runs(tenant_id)",
      "CREATE TABLE IF NOT EXISTS decision_feedbacks (\n      id TEXT PRIMARY KEY,\n      run_id TEXT NOT NULL REFERENCES decision_runs(id) ON DELETE CASCADE,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      selected_alternative TEXT NOT NULL,\n      satisfaction INTEGER NOT NULL,\n      notes TEXT,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_decision_feedbacks_run ON decision_feedbacks(run_id)",
      "CREATE TABLE IF NOT EXISTS onboarding_sessions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      current_step INTEGER NOT NULL DEFAULT 1,\n      completed_steps_json TEXT NOT NULL DEFAULT '[]',\n      decision_json TEXT,\n      simulation_result_json TEXT,\n      snapshot_id TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_tenant ON onboarding_sessions(tenant_id)"
    ]
  },
  {
    "version": "v018",
    "description": "刷新令牌复合索引与过期清理",
    "sql": [
      "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash_revoked ON refresh_tokens(token_hash, is_revoked)"
    ]
  },
  {
    "version": "v019",
    "description": "任务队列安全 — 工作者领取标记",
    "sql": [
      "/* safe:add-column:tasks:claimed_by */ ALTER TABLE tasks ADD COLUMN claimed_by TEXT",
      "/* safe:add-column:tasks:claimed_at */ ALTER TABLE tasks ADD COLUMN claimed_at INTEGER"
    ]
  },
  {
    "version": "v020",
    "description": "Stripe 计量发件箱 — 持久化重试",
    "sql": [
      "CREATE TABLE IF NOT EXISTS billing_outbox (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      tenant_id TEXT NOT NULL,\n      customer_id TEXT NOT NULL,\n      event_name TEXT NOT NULL,\n      quantity INTEGER NOT NULL,\n      idempotency_key TEXT NOT NULL UNIQUE,\n      status TEXT NOT NULL DEFAULT 'pending',\n      attempts INTEGER NOT NULL DEFAULT 0,\n      last_error TEXT,\n      created_at INTEGER NOT NULL,\n      processed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_billing_outbox_status ON billing_outbox (status, created_at)"
    ]
  },
  {
    "version": "v021",
    "description": "任务队列优先级支持",
    "sql": [
      "/* safe:add-column:tasks:priority */ ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks (priority DESC, created_at ASC) WHERE status = 'pending'"
    ]
  },
  {
    "version": "v022",
    "description": "IVF 质心持久化与 WebSocket 持久化事件日志",
    "sql": [
      "CREATE TABLE IF NOT EXISTS ivf_centroids (\n      model TEXT PRIMARY KEY,\n      centroids_json TEXT NOT NULL,\n      num_vectors INTEGER NOT NULL DEFAULT 0,\n      built_at INTEGER NOT NULL\n    )",
      "CREATE TABLE IF NOT EXISTS ws_event_log (\n      seq INTEGER PRIMARY KEY AUTOINCREMENT,\n      event TEXT NOT NULL,\n      data_json TEXT NOT NULL,\n      tenant_id TEXT,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_ws_event_log_tenant ON ws_event_log (tenant_id, seq)",
      "CREATE INDEX IF NOT EXISTS idx_ws_event_log_created ON ws_event_log (created_at)"
    ]
  },
  {
    "version": "v023",
    "description": "API Key 租户绑定（支持计划感知限流）",
    "sql": [
      "CREATE TABLE IF NOT EXISTS api_keys (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      key_hash TEXT NOT NULL UNIQUE,\n      plan_id TEXT NOT NULL DEFAULT 'free',\n      is_revoked INTEGER NOT NULL DEFAULT 0,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash)",
      "CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id)"
    ]
  },
  {
    "version": "v024",
    "description": "任务队列 purge 和公平调度性能索引",
    "sql": [
      "CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks (status, updated_at)",
      "CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks (tenant_id, status)"
    ]
  },
  {
    "version": "v025",
    "description": "配置中心（config_items/config_audit）与附加组件（add_ons/tenant_add_ons/entitlements）",
    "sql": [
      "CREATE TABLE IF NOT EXISTS config_items (\n      key TEXT PRIMARY KEY,\n      value_json TEXT NOT NULL,\n      category TEXT NOT NULL CHECK(category IN ('public', 'protected', 'admin', 'secret')),\n      requires_restart INTEGER NOT NULL DEFAULT 0,\n      group_key TEXT NOT NULL DEFAULT 'general',\n      updated_at INTEGER NOT NULL,\n      updated_by TEXT NOT NULL\n    )",
      "CREATE TABLE IF NOT EXISTS config_audit (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      config_key TEXT NOT NULL,\n      old_value TEXT,\n      new_value TEXT,\n      changed_by TEXT NOT NULL,\n      changed_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_config_audit_key ON config_audit(config_key)",
      "CREATE INDEX IF NOT EXISTS idx_config_audit_time ON config_audit(changed_at)",
      "CREATE TABLE IF NOT EXISTS add_ons (\n      id TEXT PRIMARY KEY,\n      code TEXT NOT NULL UNIQUE,\n      name TEXT NOT NULL,\n      description TEXT NOT NULL DEFAULT '',\n      stripe_price_id TEXT NOT NULL DEFAULT '',\n      resource TEXT NOT NULL,\n      quota_amount INTEGER NOT NULL,\n      is_active INTEGER NOT NULL DEFAULT 1,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_add_ons_code ON add_ons(code)",
      "CREATE TABLE IF NOT EXISTS tenant_add_ons (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      add_on_id TEXT NOT NULL REFERENCES add_ons(id),\n      stripe_subscription_item_id TEXT,\n      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'canceled')),\n      purchased_at INTEGER NOT NULL,\n      canceled_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tenant_add_ons_tenant ON tenant_add_ons(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_tenant_add_ons_status ON tenant_add_ons(tenant_id, status)",
      "CREATE TABLE IF NOT EXISTS entitlements (\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      effective_limit INTEGER NOT NULL,\n      source TEXT NOT NULL DEFAULT 'plan',\n      updated_at INTEGER NOT NULL,\n      PRIMARY KEY (tenant_id, resource)\n    )"
    ]
  },
  {
    "version": "v026",
    "description": "移动端设备注册与推送 token 管理",
    "sql": [
      "CREATE TABLE IF NOT EXISTS devices (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      user_id TEXT NOT NULL,\n      device_uid TEXT NOT NULL,\n      platform TEXT NOT NULL CHECK(platform IN ('ios', 'android', 'web')),\n      push_token TEXT,\n      app_version TEXT,\n      last_seen_at INTEGER NOT NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_tenant_user_uid ON devices(tenant_id, user_id, device_uid)",
      "CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id)"
    ]
  },
  {
    "version": "v027",
    "description": "身份与分身系统",
    "sql": [
      "CREATE TABLE IF NOT EXISTS identities (\n      id TEXT PRIMARY KEY,\n      user_id TEXT NOT NULL UNIQUE,\n      tenant_id TEXT NOT NULL,\n      display_name TEXT NOT NULL,\n      bio TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenant_id)",
      "CREATE TABLE IF NOT EXISTS avatars (\n      id TEXT PRIMARY KEY,\n      identity_id TEXT NOT NULL REFERENCES identities(id),\n      label TEXT NOT NULL,\n      kind TEXT NOT NULL DEFAULT 'general'\n        CHECK(kind IN ('general','work','social','family','creative')),\n      behavior_overrides TEXT,\n      is_default INTEGER NOT NULL DEFAULT 0,\n      is_active INTEGER NOT NULL DEFAULT 1,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_avatars_identity ON avatars(identity_id)",
      "CREATE TABLE IF NOT EXISTS device_avatars (\n      id TEXT PRIMARY KEY,\n      device_id TEXT NOT NULL REFERENCES devices(id),\n      avatar_id TEXT NOT NULL REFERENCES avatars(id),\n      is_active INTEGER NOT NULL DEFAULT 0,\n      installed_at INTEGER NOT NULL,\n      UNIQUE(device_id, avatar_id)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_device_avatars_device ON device_avatars(device_id)",
      "CREATE INDEX IF NOT EXISTS idx_device_avatars_avatar ON device_avatars(avatar_id)",
      "INSERT OR IGNORE INTO identities (id, user_id, tenant_id, display_name, created_at, updated_at)\n     SELECT 'ident_' || REPLACE(id, 'user_', ''), id, tenant_id, email, created_at, updated_at\n     FROM users",
      "INSERT OR IGNORE INTO avatars (id, identity_id, label, kind, is_default, is_active, created_at, updated_at)\n     SELECT 'avt_' || REPLACE(id, 'ident_', ''), id, '默认', 'general', 1, 1, created_at, updated_at\n     FROM identities"
    ]
  },
  {
    "version": "v028",
    "description": "记忆淘汰索引（salience + last_accessed_at）",
    "sql": [
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant_salience ON memory_nodes(tenant_id, salience)",
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant_last_accessed ON memory_nodes(tenant_id, last_accessed_at)"
    ]
  },
  {
    "version": "v029",
    "description": "Avatar 自动运行配置、运行日志、知识源表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS avatar_autorun_config (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      avatar_id TEXT NOT NULL REFERENCES avatars(id),\n      enabled INTEGER NOT NULL DEFAULT 0,\n      interval_ms INTEGER NOT NULL,\n      next_run_at INTEGER NOT NULL,\n      knowledge_source_ids_json TEXT NOT NULL DEFAULT '[]',\n      drift_check_interval_ms INTEGER NOT NULL DEFAULT 86400000,\n      drift_threshold REAL NOT NULL DEFAULT 0.3,\n      review_required INTEGER NOT NULL DEFAULT 0,\n      last_run_at INTEGER,\n      last_drift_check_at INTEGER,\n      last_error TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_autorun_config_avatar ON avatar_autorun_config(tenant_id, avatar_id)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_config_due ON avatar_autorun_config(tenant_id, enabled, next_run_at)",
      "CREATE TABLE IF NOT EXISTS avatar_autorun_runlog (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      avatar_id TEXT NOT NULL,\n      config_id TEXT NOT NULL REFERENCES avatar_autorun_config(id),\n      task_id TEXT NOT NULL DEFAULT '',\n      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),\n      metrics_json TEXT,\n      error TEXT,\n      started_at INTEGER,\n      completed_at INTEGER,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_autorun_runlog_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, started_at)",
      "CREATE TABLE IF NOT EXISTS knowledge_sources (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      type TEXT NOT NULL CHECK(type IN ('rss','api','file','manual')),\n      name TEXT NOT NULL,\n      enabled INTEGER NOT NULL DEFAULT 1,\n      config_json TEXT NOT NULL,\n      state_json TEXT,\n      last_ingested_at INTEGER,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources(tenant_id, enabled, type)"
    ]
  },
  {
    "version": "v030",
    "description": "知识源支持 LLM 类型（重建 CHECK 约束）",
    "sql": [
      "CREATE TABLE IF NOT EXISTS knowledge_sources_new (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      type TEXT NOT NULL CHECK(type IN ('rss','api','file','manual','llm')),\n      name TEXT NOT NULL,\n      enabled INTEGER NOT NULL DEFAULT 1,\n      config_json TEXT NOT NULL,\n      state_json TEXT,\n      last_ingested_at INTEGER,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "INSERT OR IGNORE INTO knowledge_sources_new\n     SELECT id, tenant_id, type, name, enabled, config_json, state_json, last_ingested_at, created_at, updated_at\n     FROM knowledge_sources",
      "DROP TABLE IF EXISTS knowledge_sources",
      "ALTER TABLE knowledge_sources_new RENAME TO knowledge_sources",
      "CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources(tenant_id, enabled, type)"
    ]
  },
  {
    "version": "v031",
    "description": "补充 audit_log、subscriptions、pending_updates 等表的查询索引",
    "sql": [
      "CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_timestamp ON audit_log(tenant_id, timestamp)",
      "CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_status ON subscriptions(tenant_id, status)",
      "CREATE INDEX IF NOT EXISTS idx_pending_updates_status ON pending_updates(status, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON conflicts(resolved_at, detected_at)",
      "CREATE INDEX IF NOT EXISTS idx_working_memory_score ON working_memory(score DESC)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_config_next_run ON avatar_autorun_config(enabled, next_run_at)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_runlog_tenant_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, created_at DESC)"
    ]
  },
  {
    "version": "v032",
    "description": "Persona Core 2.0：核心人格、钱包、市场、治理与成长事件",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_core (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      owner_user_id TEXT NOT NULL REFERENCES users(id),\n      display_name TEXT NOT NULL,\n      profile_json TEXT NOT NULL DEFAULT '{}',\n      status TEXT NOT NULL CHECK(status IN ('active','restricted','deceased','transferred')),\n      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','shared','marketplace')),\n      growth_index REAL NOT NULL DEFAULT 0 CHECK(growth_index >= 0),\n      reputation REAL NOT NULL DEFAULT 0,\n      training_investment REAL NOT NULL DEFAULT 0,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      deceased_at INTEGER,\n      transferred_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_core_owner ON persona_core(tenant_id, owner_user_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_persona_core_status ON persona_core(tenant_id, status)",
      "CREATE TABLE IF NOT EXISTS persona_wallets (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL UNIQUE REFERENCES persona_core(id) ON DELETE CASCADE,\n      wallet_address TEXT NOT NULL UNIQUE,\n      balance REAL NOT NULL DEFAULT 0,\n      token_balance REAL NOT NULL DEFAULT 0,\n      last_settled_at INTEGER,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_wallets_persona ON persona_wallets(tenant_id, persona_id)",
      "CREATE TABLE IF NOT EXISTS persona_forks (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      label TEXT NOT NULL,\n      fork_type TEXT NOT NULL CHECK(fork_type IN ('experimental','task','social','research','operations')),\n      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','recycled','archived')),\n      sync_mode TEXT NOT NULL DEFAULT 'core' CHECK(sync_mode IN ('core','isolated')),\n      experience_factor REAL NOT NULL DEFAULT 1 CHECK(experience_factor >= 0 AND experience_factor <= 2),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      recycled_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_forks_persona ON persona_forks(tenant_id, persona_id, status)",
      "CREATE TABLE IF NOT EXISTS persona_memories (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,\n      kind TEXT NOT NULL CHECK(kind IN ('interaction','task','training','knowledge','governance')),\n      summary TEXT NOT NULL,\n      content_json TEXT NOT NULL DEFAULT '{}',\n      importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_memories_persona ON persona_memories(tenant_id, persona_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_knowledge_items (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      title TEXT NOT NULL,\n      content TEXT NOT NULL,\n      source TEXT NOT NULL DEFAULT 'manual',\n      tags_json TEXT NOT NULL DEFAULT '[]',\n      confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_knowledge_persona ON persona_knowledge_items(tenant_id, persona_id, updated_at DESC)",
      "CREATE TABLE IF NOT EXISTS marketplace_tasks (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      publisher_user_id TEXT NOT NULL REFERENCES users(id),\n      assignee_persona_id TEXT REFERENCES persona_core(id) ON DELETE SET NULL,\n      assignee_fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,\n      title TEXT NOT NULL,\n      description TEXT NOT NULL,\n      category TEXT NOT NULL CHECK(category IN ('writing','coding','research','operations','general')),\n      reward REAL NOT NULL DEFAULT 0,\n      currency TEXT NOT NULL DEFAULT 'CRED',\n      status TEXT NOT NULL CHECK(status IN ('open','accepted','completed','cancelled')),\n      quality_score REAL,\n      growth_delta REAL,\n      published_at INTEGER NOT NULL,\n      accepted_at INTEGER,\n      completed_at INTEGER,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_marketplace_tasks_status ON marketplace_tasks(tenant_id, status, updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_marketplace_tasks_assignee ON marketplace_tasks(tenant_id, assignee_persona_id, updated_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_growth_events (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      task_id TEXT REFERENCES marketplace_tasks(id) ON DELETE SET NULL,\n      event_type TEXT NOT NULL CHECK(event_type IN ('task_completed','training','knowledge_sync','governance')),\n      growth_delta REAL NOT NULL DEFAULT 0,\n      reputation_delta REAL NOT NULL DEFAULT 0,\n      training_delta REAL NOT NULL DEFAULT 0,\n      payload_json TEXT NOT NULL DEFAULT '{}',\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_growth_events_persona ON persona_growth_events(tenant_id, persona_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_governance_events (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      event_type TEXT NOT NULL CHECK(event_type IN ('warning','reward','restriction','review','transfer','death')),\n      severity INTEGER NOT NULL CHECK(severity >= 1 AND severity <= 5),\n      summary TEXT NOT NULL,\n      payload_json TEXT NOT NULL DEFAULT '{}',\n      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_governance_events_persona ON persona_governance_events(tenant_id, persona_id, created_at DESC)"
    ]
  },
  {
    "version": "v033",
    "description": "Persona OS：persona 级认知记忆、关联边与工作记忆",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_memory_nodes (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,\n      source_memory_id TEXT UNIQUE REFERENCES persona_memories(id) ON DELETE SET NULL,\n      knowledge_item_id TEXT UNIQUE REFERENCES persona_knowledge_items(id) ON DELETE SET NULL,\n      kind TEXT NOT NULL CHECK(kind IN ('episodic','semantic','procedural')),\n      content TEXT NOT NULL,\n      valence REAL NOT NULL DEFAULT 0 CHECK(valence >= -1 AND valence <= 1),\n      salience REAL NOT NULL DEFAULT 0.5 CHECK(salience >= 0 AND salience <= 1),\n      access_count INTEGER NOT NULL DEFAULT 0,\n      decay_lambda REAL NOT NULL DEFAULT 0.0001,\n      last_accessed_at INTEGER NOT NULL,\n      last_decayed_at INTEGER NOT NULL,\n      consolidated_from TEXT REFERENCES persona_memory_nodes(id) ON DELETE SET NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_memory_nodes_persona ON persona_memory_nodes(tenant_id, persona_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_persona_memory_nodes_kind ON persona_memory_nodes(tenant_id, persona_id, kind, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_memory_edges (\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      source TEXT NOT NULL REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,\n      target TEXT NOT NULL REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,\n      strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),\n      relation TEXT NOT NULL,\n      PRIMARY KEY (source, target)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_memory_edges_target ON persona_memory_edges(tenant_id, persona_id, target)",
      "CREATE TABLE IF NOT EXISTS persona_working_memory (\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      memory_id TEXT PRIMARY KEY REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,\n      score REAL NOT NULL,\n      entered_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_working_memory_score ON persona_working_memory(tenant_id, persona_id, score DESC)"
    ]
  },
  {
    "version": "v034",
    "description": "Persona OS v1 对齐：生命周期状态、转移记录、声誉历史与分析表",
    "sql": [
      "/* safe:add-column:persona_core:lifecycle_status */ ALTER TABLE persona_core ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'",
      "UPDATE persona_core SET lifecycle_status = status WHERE lifecycle_status IS NULL OR lifecycle_status = 'active'",
      "CREATE INDEX IF NOT EXISTS idx_persona_core_lifecycle_status ON persona_core(tenant_id, lifecycle_status, updated_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_transfers (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      from_owner_user_id TEXT NOT NULL REFERENCES users(id),\n      to_owner_user_id TEXT NOT NULL REFERENCES users(id),\n      status TEXT NOT NULL CHECK(status IN ('pending_review','approved','completed','rejected','cancelled')),\n      reason TEXT NOT NULL DEFAULT '',\n      requested_at INTEGER NOT NULL,\n      approved_at INTEGER,\n      completed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_transfers_persona ON persona_transfers(tenant_id, persona_id, requested_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_persona_transfers_target ON persona_transfers(tenant_id, to_owner_user_id, requested_at DESC)",
      "CREATE TABLE IF NOT EXISTS reputation_history (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      old_score REAL NOT NULL,\n      new_score REAL NOT NULL,\n      reason TEXT NOT NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_reputation_history_persona ON reputation_history(tenant_id, persona_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_daily_metrics (\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      metric_date TEXT NOT NULL,\n      tasks_completed INTEGER NOT NULL DEFAULT 0,\n      revenue REAL NOT NULL DEFAULT 0,\n      reputation_score REAL NOT NULL DEFAULT 0,\n      growth_index REAL NOT NULL DEFAULT 0,\n      PRIMARY KEY (tenant_id, persona_id, metric_date)\n    )",
      "CREATE TABLE IF NOT EXISTS marketplace_daily_metrics (\n      tenant_id TEXT NOT NULL,\n      metric_date TEXT NOT NULL,\n      open_tasks INTEGER NOT NULL DEFAULT 0,\n      completed_tasks INTEGER NOT NULL DEFAULT 0,\n      gross_volume REAL NOT NULL DEFAULT 0,\n      active_personas INTEGER NOT NULL DEFAULT 0,\n      PRIMARY KEY (tenant_id, metric_date)\n    )"
    ]
  },
  {
    "version": "v035",
    "description": "Persona OS v1：runtime session、任务工作流与治理 case/action",
    "sql": [
      "CREATE TABLE IF NOT EXISTS task_applications (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      ranking_score REAL NOT NULL DEFAULT 0,\n      status TEXT NOT NULL CHECK(status IN ('submitted','assigned','rejected','withdrawn')),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_applications_unique ON task_applications(tenant_id, task_id, persona_id)",
      "CREATE INDEX IF NOT EXISTS idx_task_applications_task ON task_applications(tenant_id, task_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_task_applications_persona ON task_applications(tenant_id, persona_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS task_assignments (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      application_id TEXT REFERENCES task_applications(id) ON DELETE SET NULL,\n      runtime_session_id TEXT,\n      status TEXT NOT NULL CHECK(status IN ('assigned','in_progress','submitted','accepted','rejected','disputed','completed')),\n      assigned_at INTEGER NOT NULL,\n      started_at INTEGER,\n      submitted_at INTEGER,\n      completed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(tenant_id, task_id, assigned_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_task_assignments_persona ON task_assignments(tenant_id, persona_id, assigned_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_task_assignments_status ON task_assignments(tenant_id, status, assigned_at DESC)",
      "CREATE TABLE IF NOT EXISTS runtime_sessions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,\n      state TEXT NOT NULL CHECK(state IN ('PLAN','EXECUTE','EVALUATE','MEMORY_UPDATE','REPUTATION_UPDATE','COMPLETED','ERROR')),\n      plan_json TEXT,\n      artifacts_json TEXT NOT NULL DEFAULT '[]',\n      evaluation_json TEXT,\n      result_summary_json TEXT,\n      error_json TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      completed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task ON runtime_sessions(tenant_id, task_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_persona ON runtime_sessions(tenant_id, persona_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_assignment ON runtime_sessions(tenant_id, assignment_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS task_results (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,\n      result_uri TEXT NOT NULL,\n      evaluation_json TEXT NOT NULL DEFAULT '{}',\n      quality_score REAL,\n      client_rating INTEGER,\n      status TEXT NOT NULL CHECK(status IN ('submitted','accepted','rejected','disputed')),\n      rejection_reason TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      accepted_at INTEGER,\n      rejected_at INTEGER,\n      disputed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_task_results_assignment ON task_results(tenant_id, assignment_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_task_results_task ON task_results(tenant_id, task_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS governance_cases (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      task_id TEXT REFERENCES marketplace_tasks(id) ON DELETE SET NULL,\n      trigger_type TEXT NOT NULL,\n      severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),\n      status TEXT NOT NULL CHECK(status IN ('open','action_applied','appealed','resolved')),\n      details_json TEXT NOT NULL DEFAULT '{}',\n      appeal_json TEXT,\n      opened_at INTEGER NOT NULL,\n      resolved_at INTEGER,\n      appealed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_governance_cases_persona ON governance_cases(tenant_id, persona_id, opened_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_governance_cases_status ON governance_cases(tenant_id, status, opened_at DESC)",
      "CREATE TABLE IF NOT EXISTS governance_actions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      case_id TEXT NOT NULL REFERENCES governance_cases(id) ON DELETE CASCADE,\n      action_type TEXT NOT NULL CHECK(action_type IN ('warning','temporary_restriction','temporary_suspension','reinstate','termination')),\n      duration_seconds INTEGER,\n      details_json TEXT NOT NULL DEFAULT '{}',\n      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_governance_actions_case ON governance_actions(tenant_id, case_id, created_at DESC)"
    ]
  },
  {
    "version": "v036",
    "description": "Persona OS v1：钱包账本、提现请求与任务结算",
    "sql": [
      "/* safe:add-column:persona_wallets:currency */ ALTER TABLE persona_wallets ADD COLUMN currency TEXT NOT NULL DEFAULT 'CRED'",
      "/* safe:add-column:persona_wallets:status */ ALTER TABLE persona_wallets ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
      "CREATE TABLE IF NOT EXISTS wallet_transactions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,\n      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('task_payment','platform_fee','owner_payout','persona_reserve','refund')),\n      amount_minor INTEGER NOT NULL,\n      currency TEXT NOT NULL,\n      reference_type TEXT,\n      reference_id TEXT,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet ON wallet_transactions(tenant_id, wallet_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference ON wallet_transactions(tenant_id, reference_type, reference_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS wallet_payout_requests (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,\n      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),\n      currency TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('completed','rejected')),\n      requested_by_user_id TEXT NOT NULL REFERENCES users(id),\n      created_at INTEGER NOT NULL,\n      completed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_wallet_payout_requests_wallet ON wallet_payout_requests(tenant_id, wallet_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS wallet_settlements (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      assignment_id TEXT NOT NULL UNIQUE REFERENCES task_assignments(id) ON DELETE CASCADE,\n      total_amount_minor INTEGER NOT NULL CHECK(total_amount_minor > 0),\n      currency TEXT NOT NULL,\n      owner_pct INTEGER NOT NULL,\n      persona_pct INTEGER NOT NULL,\n      platform_pct INTEGER NOT NULL,\n      owner_amount_minor INTEGER NOT NULL,\n      persona_amount_minor INTEGER NOT NULL,\n      platform_amount_minor INTEGER NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('completed')),\n      created_at INTEGER NOT NULL,\n      completed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_wallet_settlements_wallet ON wallet_settlements(tenant_id, wallet_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_wallet_settlements_task ON wallet_settlements(tenant_id, task_id, created_at DESC)"
    ]
  },
  {
    "version": "v037",
    "description": "Persona OS v1：敏感记忆分级与静态加密元数据",
    "sql": [
      "/* safe:add-column:persona_memories:sensitivity */ ALTER TABLE persona_memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'private'",
      "/* safe:add-column:persona_memories:is_encrypted */ ALTER TABLE persona_memories ADD COLUMN is_encrypted INTEGER NOT NULL DEFAULT 0",
      "/* safe:add-column:persona_memories:owner_restricted */ ALTER TABLE persona_memories ADD COLUMN owner_restricted INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX IF NOT EXISTS idx_persona_memories_sensitivity ON persona_memories(tenant_id, persona_id, sensitivity, created_at DESC)"
    ]
  },
  {
    "version": "v038",
    "description": "企业可观测性：异步观测发件箱与聚合滚动表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS observability_outbox (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      topic TEXT NOT NULL,\n      event_type TEXT NOT NULL,\n      partition_key TEXT NOT NULL,\n      payload_json TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','processing','sent','failed')),\n      attempts INTEGER NOT NULL DEFAULT 0,\n      created_at INTEGER NOT NULL,\n      processed_at INTEGER,\n      last_error TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_observability_outbox_status ON observability_outbox(status, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS idx_observability_outbox_tenant ON observability_outbox(tenant_id, status, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS idx_observability_outbox_topic ON observability_outbox(topic, partition_key, created_at ASC)",
      "CREATE TABLE IF NOT EXISTS observability_rollups (\n      tenant_id TEXT PRIMARY KEY,\n      runtime_completed_count INTEGER NOT NULL DEFAULT 0,\n      runtime_duration_total_ms INTEGER NOT NULL DEFAULT 0,\n      task_terminal_count INTEGER NOT NULL DEFAULT 0,\n      task_success_count INTEGER NOT NULL DEFAULT 0,\n      task_rejected_count INTEGER NOT NULL DEFAULT 0,\n      task_disputed_count INTEGER NOT NULL DEFAULT 0,\n      wallet_settlement_count INTEGER NOT NULL DEFAULT 0,\n      wallet_settlement_total_amount_minor INTEGER NOT NULL DEFAULT 0,\n      wallet_settlement_latency_total_ms INTEGER NOT NULL DEFAULT 0,\n      governance_case_opened_count INTEGER NOT NULL DEFAULT 0,\n      governance_case_active_count INTEGER NOT NULL DEFAULT 0,\n      governance_action_applied_count INTEGER NOT NULL DEFAULT 0,\n      persona_growth_total REAL NOT NULL DEFAULT 0,\n      persona_growth_event_count INTEGER NOT NULL DEFAULT 0,\n      persona_reputation_delta_total REAL NOT NULL DEFAULT 0,\n      updated_at INTEGER NOT NULL\n    )"
    ]
  },
  {
    "version": "v039",
    "description": "企业可靠性：通用 Idempotency-Key 响应缓存",
    "sql": [
      "CREATE TABLE IF NOT EXISTS idempotency_keys (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      scope_key TEXT NOT NULL,\n      idempotency_key TEXT NOT NULL,\n      request_hash TEXT NOT NULL,\n      request_method TEXT NOT NULL,\n      request_path TEXT NOT NULL,\n      state TEXT NOT NULL CHECK(state IN ('in_progress','completed')),\n      response_status INTEGER,\n      response_content_type TEXT,\n      response_headers_json TEXT,\n      response_body TEXT,\n      created_at INTEGER NOT NULL,\n      expires_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_scope ON idempotency_keys(tenant_id, scope_key, idempotency_key)",
      "CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expiry ON idempotency_keys(expires_at)"
    ]
  },
  {
    "version": "v040",
    "description": "企业审计：扩展 audit_log 支持业务级审计事件",
    "sql": [
      "/* safe:add-column:audit_log:created_at */ ALTER TABLE audit_log ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
      "/* safe:add-column:audit_log:event_kind */ ALTER TABLE audit_log ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'request'",
      "/* safe:add-column:audit_log:user_id */ ALTER TABLE audit_log ADD COLUMN user_id TEXT",
      "/* safe:add-column:audit_log:user_email */ ALTER TABLE audit_log ADD COLUMN user_email TEXT",
      "/* safe:add-column:audit_log:action_type */ ALTER TABLE audit_log ADD COLUMN action_type TEXT DEFAULT 'other'",
      "/* safe:add-column:audit_log:actor_type */ ALTER TABLE audit_log ADD COLUMN actor_type TEXT",
      "/* safe:add-column:audit_log:actor_id */ ALTER TABLE audit_log ADD COLUMN actor_id TEXT",
      "/* safe:add-column:audit_log:target_type */ ALTER TABLE audit_log ADD COLUMN target_type TEXT",
      "/* safe:add-column:audit_log:target_id */ ALTER TABLE audit_log ADD COLUMN target_id TEXT",
      "/* safe:add-column:audit_log:payload_json */ ALTER TABLE audit_log ADD COLUMN payload_json TEXT",
      "UPDATE audit_log SET created_at = timestamp WHERE created_at = 0",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created_at ON audit_log(tenant_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(tenant_id, actor_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(tenant_id, target_type, target_id, created_at DESC)"
    ]
  },
  {
    "version": "v041",
    "description": "企业可靠性：runtime session 超时、重试与终态恢复",
    "sql": [
      "ALTER TABLE runtime_sessions RENAME TO runtime_sessions_legacy_v041",
      "CREATE TABLE runtime_sessions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,\n      state TEXT NOT NULL CHECK(state IN ('PLAN','EXECUTE','EVALUATE','MEMORY_UPDATE','REPUTATION_UPDATE','COMPLETED','FAILED','TIMEOUT','ERROR')),\n      retry_count INTEGER NOT NULL DEFAULT 0,\n      timeout_at INTEGER,\n      plan_json TEXT,\n      artifacts_json TEXT NOT NULL DEFAULT '[]',\n      evaluation_json TEXT,\n      result_summary_json TEXT,\n      error_json TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      completed_at INTEGER\n    )",
      "INSERT INTO runtime_sessions (\n      id, tenant_id, persona_id, task_id, assignment_id, state, retry_count, timeout_at,\n      plan_json, artifacts_json, evaluation_json, result_summary_json, error_json,\n      created_at, updated_at, completed_at\n    )\n    SELECT\n      id,\n      tenant_id,\n      persona_id,\n      task_id,\n      assignment_id,\n      CASE WHEN state = 'ERROR' THEN 'FAILED' ELSE state END,\n      0,\n      NULL,\n      plan_json,\n      artifacts_json,\n      evaluation_json,\n      result_summary_json,\n      error_json,\n      created_at,\n      updated_at,\n      completed_at\n    FROM runtime_sessions_legacy_v041",
      "DROP TABLE runtime_sessions_legacy_v041",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task ON runtime_sessions(tenant_id, task_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_persona ON runtime_sessions(tenant_id, persona_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_assignment ON runtime_sessions(tenant_id, assignment_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_timeout ON runtime_sessions(tenant_id, state, timeout_at)"
    ]
  },
  {
    "version": "v042",
    "description": "企业可靠性：平台 DLQ 事件持久化与 replay",
    "sql": [
      "CREATE TABLE IF NOT EXISTS platform_dlq_events (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      source_component TEXT NOT NULL,\n      source_topic TEXT NOT NULL,\n      dlq_topic TEXT NOT NULL CHECK(dlq_topic IN ('runtime.dlq','wallet.dlq','governance.dlq')),\n      event_type TEXT NOT NULL,\n      partition_key TEXT,\n      payload_json TEXT NOT NULL,\n      error_message TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','replayed')),\n      created_at INTEGER NOT NULL,\n      replayed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_platform_dlq_status ON platform_dlq_events(status, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS idx_platform_dlq_tenant ON platform_dlq_events(tenant_id, status, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS idx_platform_dlq_topic ON platform_dlq_events(dlq_topic, status, created_at ASC)"
    ]
  },
  {
    "version": "v043",
    "description": "企业协作：organization/workspace/membership/role_binding",
    "sql": [
      "CREATE TABLE IF NOT EXISTS organizations (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      name TEXT NOT NULL,\n      slug TEXT NOT NULL,\n      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(tenant_id, slug)",
      "CREATE INDEX IF NOT EXISTS idx_organizations_creator ON organizations(tenant_id, created_by_user_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS workspaces (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,\n      name TEXT NOT NULL,\n      slug TEXT NOT NULL,\n      is_default INTEGER NOT NULL DEFAULT 0,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(tenant_id, organization_id, slug)",
      "CREATE INDEX IF NOT EXISTS idx_workspaces_default ON workspaces(tenant_id, organization_id, is_default)",
      "CREATE TABLE IF NOT EXISTS organization_memberships (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,\n      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      status TEXT NOT NULL CHECK(status IN ('active','invited','suspended')),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_org_memberships_unique ON organization_memberships(tenant_id, organization_id, user_id)",
      "CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON organization_memberships(tenant_id, user_id, status, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS organization_role_bindings (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,\n      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n      membership_id TEXT NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,\n      role TEXT NOT NULL CHECK(role IN ('org_admin','billing_admin','persona_operator','marketplace_manager','auditor','viewer')),\n      created_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_org_role_bindings_unique ON organization_role_bindings(tenant_id, organization_id, workspace_id, membership_id, role)",
      "CREATE INDEX IF NOT EXISTS idx_org_role_bindings_membership ON organization_role_bindings(tenant_id, membership_id, role)"
    ]
  },
  {
    "version": "v044",
    "description": "企业商用：billing catalog、invoice、usage meter",
    "sql": [
      "CREATE TABLE IF NOT EXISTS billing_plans (\n      id TEXT PRIMARY KEY,\n      name TEXT NOT NULL,\n      stripe_price_id TEXT NOT NULL DEFAULT '',\n      price_minor INTEGER NOT NULL DEFAULT 0,\n      currency TEXT NOT NULL DEFAULT 'USD',\n      billing_interval TEXT NOT NULL DEFAULT 'month',\n      limits_json TEXT NOT NULL,\n      is_active INTEGER NOT NULL DEFAULT 1,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_billing_plans_active ON billing_plans(is_active, id)",
      "CREATE TABLE IF NOT EXISTS billing_invoices (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,\n      plan_id TEXT NOT NULL REFERENCES billing_plans(id),\n      status TEXT NOT NULL CHECK(status IN ('draft','open','paid','void')),\n      amount_minor INTEGER NOT NULL DEFAULT 0,\n      currency TEXT NOT NULL DEFAULT 'USD',\n      billing_interval TEXT NOT NULL DEFAULT 'month',\n      period_start INTEGER NOT NULL,\n      period_end INTEGER NOT NULL,\n      wallet_settlement_count INTEGER NOT NULL DEFAULT 0,\n      wallet_settlement_total_minor INTEGER NOT NULL DEFAULT 0,\n      reconciliation_status TEXT NOT NULL DEFAULT 'balanced' CHECK(reconciliation_status IN ('balanced','mismatch','repair_required')),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      paid_at INTEGER\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_period ON billing_invoices(tenant_id, subscription_id, period_start)",
      "CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant ON billing_invoices(tenant_id, status, period_start DESC)",
      "CREATE TABLE IF NOT EXISTS usage_meters (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      period_start INTEGER NOT NULL,\n      period_end INTEGER NOT NULL,\n      total_quantity INTEGER NOT NULL DEFAULT 0,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_meters_period ON usage_meters(tenant_id, resource, period_start, period_end)",
      "CREATE INDEX IF NOT EXISTS idx_usage_meters_tenant ON usage_meters(tenant_id, period_start DESC, resource)"
    ]
  },
  {
    "version": "v045",
    "description": "企业财务：settlement reconciliation runs",
    "sql": [
      "CREATE TABLE IF NOT EXISTS settlement_reconciliation_runs (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      checked_settlements INTEGER NOT NULL DEFAULT 0,\n      mismatched_settlements INTEGER NOT NULL DEFAULT 0,\n      repaired_settlements INTEGER NOT NULL DEFAULT 0,\n      deleted_transactions INTEGER NOT NULL DEFAULT 0,\n      inserted_transactions INTEGER NOT NULL DEFAULT 0,\n      orphan_transactions_removed INTEGER NOT NULL DEFAULT 0,\n      report_json TEXT NOT NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_settlement_reconciliation_runs_tenant ON settlement_reconciliation_runs(tenant_id, created_at DESC)"
    ]
  },
  {
    "version": "v046",
    "description": "企业集成：tenant enterprise profile / oidc / scim / dedicated deployment",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tenant_enterprise_profiles (\n      tenant_id TEXT PRIMARY KEY,\n      deployment_mode TEXT NOT NULL DEFAULT 'shared_cluster' CHECK(deployment_mode IN ('shared_cluster','dedicated_db')),\n      database_isolation_mode TEXT NOT NULL DEFAULT 'shared' CHECK(database_isolation_mode IN ('shared','dedicated')),\n      kafka_namespace TEXT NOT NULL DEFAULT '',\n      encryption_mode TEXT NOT NULL DEFAULT 'platform_managed' CHECK(encryption_mode IN ('platform_managed','tenant_dedicated')),\n      kms_key_ref TEXT,\n      scim_token_hash TEXT,\n      oidc_enabled INTEGER NOT NULL DEFAULT 0,\n      oidc_issuer_url TEXT NOT NULL DEFAULT '',\n      oidc_client_id TEXT NOT NULL DEFAULT '',\n      oidc_client_secret_encrypted TEXT NOT NULL DEFAULT '',\n      oidc_audience TEXT NOT NULL DEFAULT '',\n      oidc_scope TEXT NOT NULL DEFAULT 'openid profile email',\n      oidc_email_claim TEXT NOT NULL DEFAULT 'email',\n      oidc_name_claim TEXT NOT NULL DEFAULT 'name',\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_enterprise_profiles_scim_hash ON tenant_enterprise_profiles(scim_token_hash)"
    ]
  },
  {
    "version": "v047",
    "description": "身份层重构：tenant 可包含多个 identities 与独立 avatar 生命周期",
    "sql": [
      "CREATE TABLE IF NOT EXISTS identities_new (\n      id TEXT PRIMARY KEY,\n      user_id TEXT NOT NULL UNIQUE,\n      tenant_id TEXT NOT NULL,\n      display_name TEXT NOT NULL,\n      bio TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "INSERT OR IGNORE INTO identities_new (id, user_id, tenant_id, display_name, bio, created_at, updated_at)\n     SELECT id, user_id, tenant_id, display_name, bio, created_at, updated_at\n     FROM identities",
      "CREATE TABLE IF NOT EXISTS avatars_new (\n      id TEXT PRIMARY KEY,\n      identity_id TEXT NOT NULL REFERENCES identities_new(id),\n      label TEXT NOT NULL,\n      kind TEXT NOT NULL DEFAULT 'general'\n        CHECK(kind IN ('general','work','social','family','creative')),\n      behavior_overrides TEXT,\n      is_default INTEGER NOT NULL DEFAULT 0,\n      is_active INTEGER NOT NULL DEFAULT 1,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "INSERT OR IGNORE INTO avatars_new (id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at)\n     SELECT id, identity_id, label, kind, behavior_overrides, is_default, is_active, created_at, updated_at\n     FROM avatars",
      "CREATE TABLE IF NOT EXISTS device_avatars_new (\n      id TEXT PRIMARY KEY,\n      device_id TEXT NOT NULL REFERENCES devices(id),\n      avatar_id TEXT NOT NULL REFERENCES avatars_new(id),\n      is_active INTEGER NOT NULL DEFAULT 0,\n      installed_at INTEGER NOT NULL,\n      UNIQUE(device_id, avatar_id)\n    )",
      "INSERT OR IGNORE INTO device_avatars_new (id, device_id, avatar_id, is_active, installed_at)\n     SELECT id, device_id, avatar_id, is_active, installed_at\n     FROM device_avatars",
      "CREATE TABLE IF NOT EXISTS avatar_autorun_config_new (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      avatar_id TEXT NOT NULL REFERENCES avatars_new(id),\n      enabled INTEGER NOT NULL DEFAULT 0,\n      interval_ms INTEGER NOT NULL,\n      next_run_at INTEGER NOT NULL,\n      knowledge_source_ids_json TEXT NOT NULL DEFAULT '[]',\n      drift_check_interval_ms INTEGER NOT NULL DEFAULT 86400000,\n      drift_threshold REAL NOT NULL DEFAULT 0.3,\n      review_required INTEGER NOT NULL DEFAULT 0,\n      last_run_at INTEGER,\n      last_drift_check_at INTEGER,\n      last_error TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "INSERT OR IGNORE INTO avatar_autorun_config_new (\n      id, tenant_id, avatar_id, enabled, interval_ms, next_run_at,\n      knowledge_source_ids_json, drift_check_interval_ms, drift_threshold, review_required,\n      last_run_at, last_drift_check_at, last_error, created_at, updated_at\n    )\n     SELECT\n      id, tenant_id, avatar_id, enabled, interval_ms, next_run_at,\n      knowledge_source_ids_json, drift_check_interval_ms, drift_threshold, review_required,\n      last_run_at, last_drift_check_at, last_error, created_at, updated_at\n     FROM avatar_autorun_config",
      "CREATE TABLE IF NOT EXISTS avatar_autorun_runlog_new (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      avatar_id TEXT NOT NULL,\n      config_id TEXT NOT NULL REFERENCES avatar_autorun_config_new(id),\n      task_id TEXT NOT NULL DEFAULT '',\n      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),\n      metrics_json TEXT,\n      error TEXT,\n      started_at INTEGER,\n      completed_at INTEGER,\n      created_at INTEGER NOT NULL\n    )",
      "INSERT OR IGNORE INTO avatar_autorun_runlog_new (\n      id, tenant_id, avatar_id, config_id, task_id, status, metrics_json, error, started_at, completed_at, created_at\n    )\n     SELECT id, tenant_id, avatar_id, config_id, task_id, status, metrics_json, error, started_at, completed_at, created_at\n     FROM avatar_autorun_runlog",
      "DROP TABLE IF EXISTS avatar_autorun_runlog",
      "DROP TABLE IF EXISTS avatar_autorun_config",
      "DROP TABLE IF EXISTS device_avatars",
      "DROP TABLE IF EXISTS avatars",
      "DROP TABLE IF EXISTS identities",
      "ALTER TABLE identities_new RENAME TO identities",
      "ALTER TABLE avatars_new RENAME TO avatars",
      "ALTER TABLE device_avatars_new RENAME TO device_avatars",
      "ALTER TABLE avatar_autorun_config_new RENAME TO avatar_autorun_config",
      "ALTER TABLE avatar_autorun_runlog_new RENAME TO avatar_autorun_runlog",
      "CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_identities_tenant_user ON identities(tenant_id, user_id)",
      "CREATE INDEX IF NOT EXISTS idx_avatars_identity ON avatars(identity_id)",
      "CREATE INDEX IF NOT EXISTS idx_device_avatars_device ON device_avatars(device_id)",
      "CREATE INDEX IF NOT EXISTS idx_device_avatars_avatar ON device_avatars(avatar_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_autorun_config_avatar ON avatar_autorun_config(tenant_id, avatar_id)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_config_due ON avatar_autorun_config(tenant_id, enabled, next_run_at)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_config_next_run ON avatar_autorun_config(enabled, next_run_at)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_runlog_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, started_at)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_runlog_tenant_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, created_at DESC)"
    ]
  },
  {
    "version": "v048",
    "description": "观测链路：为 Kafka / DB 双路径增加 rollup 幂等去重",
    "sql": [
      "CREATE TABLE IF NOT EXISTS observability_processed_events (\n      event_id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      event_type TEXT NOT NULL,\n      processed_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_observability_processed_events_tenant ON observability_processed_events(tenant_id, processed_at DESC)"
    ]
  },
  {
    "version": "v049",
    "description": "可移植性：异步导出任务状态追踪",
    "sql": [
      "CREATE TABLE IF NOT EXISTS export_jobs (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      state TEXT NOT NULL DEFAULT 'queued',\n      percent INTEGER NOT NULL DEFAULT 0,\n      eta_ms INTEGER,\n      created_at INTEGER NOT NULL,\n      completed_at INTEGER,\n      download_url TEXT,\n      error_code TEXT,\n      warnings TEXT NOT NULL DEFAULT '[]',\n      pack_json TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant ON export_jobs(tenant_id, created_at DESC)"
    ]
  },
  {
    "version": "v050",
    "description": "KMS 密钥操作审计日志",
    "sql": [
      "CREATE TABLE IF NOT EXISTS kms_key_audit (\n      event_id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      operation TEXT NOT NULL,\n      provider TEXT NOT NULL,\n      key_ref TEXT NOT NULL,\n      performed_at TEXT NOT NULL,\n      success INTEGER NOT NULL DEFAULT 1,\n      error_code TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_kms_key_audit_tenant ON kms_key_audit(tenant_id, performed_at DESC)"
    ]
  },
  {
    "version": "v051",
    "description": "租户自带对象存储（BYOS）配置",
    "sql": [
      "/* safe:add-column:tenant_enterprise_profiles:byos_provider */ ALTER TABLE tenant_enterprise_profiles ADD COLUMN byos_provider TEXT NOT NULL DEFAULT 'platform'",
      "/* safe:add-column:tenant_enterprise_profiles:byos_bucket */ ALTER TABLE tenant_enterprise_profiles ADD COLUMN byos_bucket TEXT NOT NULL DEFAULT ''",
      "/* safe:add-column:tenant_enterprise_profiles:byos_key_prefix */ ALTER TABLE tenant_enterprise_profiles ADD COLUMN byos_key_prefix TEXT NOT NULL DEFAULT ''"
    ]
  },
  {
    "version": "v052",
    "description": "事件账本：event_ledger 主表、消费者检查点与权威模式控制表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS event_ledger (\n      event_id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      stream_id TEXT NOT NULL,\n      stream_version INTEGER NOT NULL,\n      event_type TEXT NOT NULL,\n      schema_version INTEGER NOT NULL DEFAULT 1,\n      occurred_at INTEGER NOT NULL,\n      command_id TEXT NOT NULL,\n      payload_json TEXT NOT NULL,\n      backfill_source_id TEXT,\n      UNIQUE(tenant_id, stream_id, stream_version)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_event_ledger_stream ON event_ledger(tenant_id, stream_id, stream_version)",
      "CREATE INDEX IF NOT EXISTS idx_event_ledger_tenant ON event_ledger(tenant_id, occurred_at)",
      "CREATE TABLE IF NOT EXISTS event_ledger_consumer_checkpoints (\n      consumer_id TEXT PRIMARY KEY,\n      last_event_id TEXT NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE TABLE IF NOT EXISTS event_ledger_authority (\n      singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK(singleton = 1),\n      mode TEXT NOT NULL DEFAULT 'tables_primary',\n      changed_at INTEGER NOT NULL,\n      changed_reason TEXT NOT NULL DEFAULT ''\n    )",
      "INSERT OR IGNORE INTO event_ledger_authority(singleton, mode, changed_at) VALUES(1, 'tables_primary', 0)"
    ]
  },
  {
    "version": "v053",
    "description": "persona_core 双写发件箱：暂存待追加至 event_ledger 的事件",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_core_ledger_outbox (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      stream_id TEXT NOT NULL,\n      payload_json TEXT NOT NULL,\n      event_type TEXT NOT NULL,\n      command_id TEXT NOT NULL,\n      created_at INTEGER NOT NULL,\n      attempts INTEGER NOT NULL DEFAULT 0,\n      last_attempted_at INTEGER,\n      error TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_outbox_pending ON persona_core_ledger_outbox(tenant_id, created_at) WHERE attempts < 3"
    ]
  },
  {
    "version": "v054",
    "description": "投影存储：读模型持久化，支持按租户+投影名+ID读写",
    "sql": [
      "CREATE TABLE IF NOT EXISTS projection_store (\n      tenant_id TEXT NOT NULL,\n      projection TEXT NOT NULL,\n      id TEXT NOT NULL,\n      value_json TEXT NOT NULL,\n      version INTEGER NOT NULL DEFAULT 0,\n      updated_at INTEGER NOT NULL,\n      PRIMARY KEY (tenant_id, projection, id)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_projection_store_list ON projection_store(tenant_id, projection, id)"
    ]
  },
  {
    "version": "v055",
    "description": "平台密钥撤销记录",
    "sql": [
      "CREATE TABLE IF NOT EXISTS platform_key_revocations (\n      key_ref TEXT PRIMARY KEY,\n      revoked_at INTEGER NOT NULL,\n      revoked_by TEXT\n    )"
    ]
  },
  {
    "version": "v056",
    "description": "平台运维操作日志（控制平面事件）",
    "sql": [
      "CREATE TABLE IF NOT EXISTS platform_ops_log (\n      id TEXT PRIMARY KEY,\n      event_type TEXT NOT NULL,\n      payload_json TEXT NOT NULL,\n      occurred_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_platform_ops_log_time ON platform_ops_log(occurred_at DESC)"
    ]
  },
  {
    "version": "v057",
    "description": "同步冲突收件箱",
    "sql": [
      "CREATE TABLE IF NOT EXISTS conflict_inbox (\n      conflict_id TEXT PRIMARY KEY,\n      conflict_version TEXT NOT NULL,\n      tenant_id TEXT NOT NULL,\n      entity_type TEXT NOT NULL,\n      entity_id TEXT NOT NULL,\n      command_id TEXT,\n      source_runtime TEXT NOT NULL,\n      detected_at TEXT NOT NULL,\n      severity TEXT NOT NULL DEFAULT 'warning',\n      local_summary_id TEXT NOT NULL,\n      local_summary_params TEXT NOT NULL DEFAULT '{}',\n      server_summary_id TEXT NOT NULL,\n      server_summary_params TEXT NOT NULL DEFAULT '{}',\n      suggested_actions TEXT NOT NULL DEFAULT '[\"keep_server\"]',\n      resolved_at TEXT,\n      resolution_action TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_conflict_inbox_tenant ON conflict_inbox(tenant_id, detected_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_conflict_inbox_blocking ON conflict_inbox(tenant_id, severity) WHERE resolved_at IS NULL"
    ]
  },
  {
    "version": "v058",
    "description": "可移植性：导入 commit token 与导入任务追踪",
    "sql": [
      "CREATE TABLE IF NOT EXISTS import_commit_tokens (\n      token TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      import_id TEXT NOT NULL,\n      manifest_checksum TEXT NOT NULL,\n      expires_at INTEGER NOT NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_ict_tenant ON import_commit_tokens(tenant_id)",
      "CREATE TABLE IF NOT EXISTS import_jobs (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      state TEXT NOT NULL DEFAULT 'pending',\n      manifest_checksum TEXT NOT NULL,\n      imported_count INTEGER NOT NULL DEFAULT 0,\n      skipped_count INTEGER NOT NULL DEFAULT 0,\n      created_at INTEGER NOT NULL,\n      completed_at INTEGER,\n      error_message TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_ij_tenant ON import_jobs(tenant_id)"
    ]
  },
  {
    "version": "v059",
    "description": "租户 BYOK/BYOS 密钥版本、密钥操作审计与存储绑定",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tenant_key_versions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      key_ref TEXT NOT NULL,\n      provider TEXT NOT NULL,\n      version INTEGER NOT NULL,\n      status TEXT NOT NULL DEFAULT 'active',\n      created_at INTEGER NOT NULL,\n      revoked_at INTEGER,\n      UNIQUE(tenant_id, key_ref, provider, version)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tenant_key_versions_tenant_key\n      ON tenant_key_versions(tenant_id, key_ref, provider, version DESC)",
      "CREATE TABLE IF NOT EXISTS tenant_vault_audit (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      operation TEXT NOT NULL,\n      key_ref TEXT NOT NULL,\n      key_version INTEGER,\n      outcome TEXT NOT NULL,\n      error_message TEXT,\n      performed_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tenant_vault_audit_tenant_time\n      ON tenant_vault_audit(tenant_id, performed_at DESC)",
      "CREATE TABLE IF NOT EXISTS tenant_storage_bindings (\n      tenant_id TEXT PRIMARY KEY,\n      provider TEXT NOT NULL,\n      bucket_or_path TEXT NOT NULL,\n      region TEXT,\n      encryption_key_ref TEXT,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )"
    ]
  },
  {
    "version": "v060",
    "description": "AI 安全治理：memory_nodes 置信度、来源类型与未验证标记",
    "sql": [
      "/* safe:add-column:memory_nodes:confidence_score */ ALTER TABLE memory_nodes ADD COLUMN confidence_score REAL NOT NULL DEFAULT 0.5",
      "/* safe:add-column:memory_nodes:source_kind */ ALTER TABLE memory_nodes ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'unknown'",
      "/* safe:add-column:memory_nodes:unverified */ ALTER TABLE memory_nodes ADD COLUMN unverified INTEGER NOT NULL DEFAULT 1"
    ]
  },
  {
    "version": "v061",
    "description": "AI 安全治理：人格漂移分析日志",
    "sql": [
      "CREATE TABLE IF NOT EXISTS drift_analysis_log (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      baseline_snapshot_id TEXT,\n      analyzed_at INTEGER NOT NULL,\n      overall_drift_score REAL NOT NULL,\n      alert_level TEXT NOT NULL DEFAULT 'ok',\n      value_drifts_json TEXT NOT NULL DEFAULT '[]'\n    )",
      "CREATE INDEX IF NOT EXISTS idx_drift_analysis_log_tenant ON drift_analysis_log(tenant_id, analyzed_at DESC)"
    ]
  },
  {
    "version": "v062",
    "description": "P1-A 岗位人格模板：predefined builtin templates + custom CRUD",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_templates (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      category TEXT NOT NULL,\n      label TEXT NOT NULL,\n      description TEXT NOT NULL DEFAULT '',\n      default_values_json TEXT NOT NULL DEFAULT '[]',\n      default_narrative TEXT NOT NULL DEFAULT '',\n      behavior_boundaries_json TEXT NOT NULL DEFAULT '[]',\n      required_knowledge_categories_json TEXT NOT NULL DEFAULT '[]',\n      is_builtin INTEGER NOT NULL DEFAULT 0,\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_templates_tenant_category ON persona_templates(tenant_id, category)"
    ]
  },
  {
    "version": "v063",
    "description": "P1-B 知识批量导入：fingerprint 去重 + 异步 job 跟踪",
    "sql": [
      "/* safe:add-column:persona_knowledge_items:fingerprint */ ALTER TABLE persona_knowledge_items ADD COLUMN fingerprint TEXT",
      "/* safe:if-table-exists:persona_knowledge_items */ CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_knowledge_fp ON persona_knowledge_items(tenant_id, persona_id, fingerprint) WHERE fingerprint IS NOT NULL",
      "CREATE TABLE IF NOT EXISTS bulk_knowledge_import_jobs (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      owner_user_id TEXT NOT NULL,\n      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued', 'running', 'completed', 'failed')),\n      total_items INTEGER NOT NULL,\n      imported_count INTEGER NOT NULL DEFAULT 0,\n      skipped_count INTEGER NOT NULL DEFAULT 0,\n      failed_count INTEGER NOT NULL DEFAULT 0,\n      failures_json TEXT NOT NULL DEFAULT '[]',\n      deduplicate_strategy TEXT NOT NULL DEFAULT 'skip' CHECK(deduplicate_strategy IN ('skip', 'overwrite')),\n      created_at INTEGER NOT NULL,\n      started_at INTEGER,\n      completed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_bki_jobs_tenant_created ON bulk_knowledge_import_jobs(tenant_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_bki_jobs_persona ON bulk_knowledge_import_jobs(tenant_id, persona_id, created_at DESC)"
    ]
  },
  {
    "version": "v064",
    "description": "P1-B job 元数据：模板联动统计",
    "sql": [
      "/* safe:add-column:bulk_knowledge_import_jobs:metadata_json */ ALTER TABLE bulk_knowledge_import_jobs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'"
    ]
  },
  {
    "version": "v065",
    "description": "P1-C 对话接入层：conversation_messages + conversation_confirmation_tokens",
    "sql": [
      "CREATE TABLE IF NOT EXISTS conversation_messages (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      session_id TEXT NOT NULL,\n      message_id TEXT NOT NULL,\n      external_user_id TEXT NOT NULL,\n      user_input TEXT NOT NULL,\n      assistant_output TEXT NOT NULL,\n      memories_used_json TEXT NOT NULL DEFAULT '[]',\n      should_escalate INTEGER NOT NULL DEFAULT 0,\n      confidence_score REAL NOT NULL DEFAULT 0.5,\n      confidence_factors_json TEXT NOT NULL DEFAULT '[]',\n      guard_action TEXT,\n      guard_reason TEXT,\n      duration_ms INTEGER NOT NULL DEFAULT 0,\n      prompt_tokens INTEGER NOT NULL DEFAULT 0,\n      completion_tokens INTEGER NOT NULL DEFAULT 0,\n      encryption_key_ref TEXT,\n      input_redacted_pii_count INTEGER NOT NULL DEFAULT 0,\n      output_redacted_pii_count INTEGER NOT NULL DEFAULT 0,\n      retention_class TEXT NOT NULL DEFAULT 'standard' CHECK(retention_class IN ('standard', 'extended', 'litigation_hold')),\n      created_at INTEGER NOT NULL,\n      UNIQUE(tenant_id, persona_id, session_id, message_id)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_conv_msg_session ON conversation_messages(tenant_id, persona_id, session_id, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_conv_msg_user ON conversation_messages(tenant_id, external_user_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_conv_msg_retention ON conversation_messages(tenant_id, retention_class, created_at)",
      "CREATE TABLE IF NOT EXISTS conversation_confirmation_tokens (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      session_id TEXT NOT NULL,\n      external_user_id TEXT NOT NULL,\n      requested_topic TEXT NOT NULL,\n      requested_rule TEXT NOT NULL,\n      input_hash TEXT NOT NULL,\n      issued_at INTEGER NOT NULL,\n      expires_at INTEGER NOT NULL,\n      consumed_at INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS idx_conv_conf_token_lookup ON conversation_confirmation_tokens(tenant_id, persona_id, session_id, expires_at)",
      "CREATE INDEX IF NOT EXISTS idx_conv_conf_token_expiry ON conversation_confirmation_tokens(expires_at)"
    ]
  },
  {
    "version": "v066",
    "description": "P1-D：subscriptions 增加 trial_end / grace_period_ends_at / cancel_at_period_end / last_invoice_id",
    "sql": [
      "/* safe:add-column:subscriptions:trial_end */ ALTER TABLE subscriptions ADD COLUMN trial_end INTEGER",
      "/* safe:add-column:subscriptions:grace_period_ends_at */ ALTER TABLE subscriptions ADD COLUMN grace_period_ends_at INTEGER",
      "/* safe:add-column:subscriptions:cancel_at_period_end */ ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0",
      "/* safe:add-column:subscriptions:last_invoice_id */ ALTER TABLE subscriptions ADD COLUMN last_invoice_id TEXT"
    ]
  },
  {
    "version": "v067",
    "description": "P3：tool_permissions / agency_authorizations / tool_invocations 表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tool_permissions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      tool_id TEXT NOT NULL,\n      scope TEXT NOT NULL,\n      constraints_json TEXT NOT NULL DEFAULT '{}',\n      granted_by TEXT NOT NULL,\n      granted_at INTEGER NOT NULL,\n      expires_at INTEGER,\n      revoked_at INTEGER,\n      revocation_reason TEXT,\n      revocation_key TEXT NOT NULL UNIQUE,\n      UNIQUE(tenant_id, persona_id, tool_id)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tool_permissions_persona\n       ON tool_permissions(tenant_id, persona_id)",
      "CREATE INDEX IF NOT EXISTS idx_tool_permissions_tenant_active\n       ON tool_permissions(tenant_id) WHERE revoked_at IS NULL",
      "CREATE TABLE IF NOT EXISTS agency_authorizations (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      principal_user_id TEXT NOT NULL,\n      scope TEXT NOT NULL,\n      scope_description TEXT NOT NULL,\n      allowed_tools_json TEXT NOT NULL DEFAULT '[]',\n      denied_tools_json TEXT NOT NULL DEFAULT '[]',\n      status TEXT NOT NULL DEFAULT 'active',\n      granted_at INTEGER NOT NULL,\n      expires_at INTEGER,\n      revoked_at INTEGER,\n      revocation_reason TEXT,\n      revocation_key TEXT NOT NULL UNIQUE\n    )",
      "CREATE INDEX IF NOT EXISTS idx_agency_authorizations_persona\n       ON agency_authorizations(tenant_id, persona_id)",
      "CREATE INDEX IF NOT EXISTS idx_agency_authorizations_principal\n       ON agency_authorizations(tenant_id, principal_user_id)",
      "CREATE INDEX IF NOT EXISTS idx_agency_authorizations_status\n       ON agency_authorizations(tenant_id, status)",
      "CREATE TABLE IF NOT EXISTS tool_invocations (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      tool_id TEXT NOT NULL,\n      invoker_type TEXT NOT NULL,\n      invoker_id TEXT NOT NULL,\n      status TEXT NOT NULL,\n      input_hash TEXT NOT NULL,\n      output_size_bytes INTEGER NOT NULL DEFAULT 0,\n      error_message TEXT,\n      cost_cents INTEGER NOT NULL DEFAULT 0,\n      duration_ms INTEGER NOT NULL DEFAULT 0,\n      invoked_at INTEGER NOT NULL,\n      completed_at INTEGER,\n      confirmation_token_id TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_persona_invoked\n       ON tool_invocations(tenant_id, persona_id, invoked_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_quota_window\n       ON tool_invocations(tenant_id, persona_id, tool_id, invoked_at)\n       WHERE status = 'success'"
    ]
  },
  {
    "version": "v068",
    "description": "P3 后续：user_oauth_tokens / tool_invocations.invoker_user_id / 待确认 + 留存索引",
    "sql": [
      "CREATE TABLE IF NOT EXISTS user_oauth_tokens (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      user_id TEXT NOT NULL,\n      provider TEXT NOT NULL,\n      scope TEXT NOT NULL,\n      access_token_encrypted TEXT NOT NULL,\n      refresh_token_encrypted TEXT,\n      access_expires_at INTEGER NOT NULL,\n      granted_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL,\n      revoked_at INTEGER,\n      revocation_reason TEXT,\n      UNIQUE(tenant_id, user_id, provider, scope)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_user_oauth_tokens_lookup\n       ON user_oauth_tokens(tenant_id, user_id, provider)\n       WHERE revoked_at IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_user_oauth_tokens_expiry\n       ON user_oauth_tokens(access_expires_at)\n       WHERE revoked_at IS NULL",
      "/* safe:add-column:tool_invocations:invoker_user_id */ ALTER TABLE tool_invocations ADD COLUMN invoker_user_id TEXT",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_pending\n       ON tool_invocations(tenant_id, invoker_user_id, invoked_at DESC)\n       WHERE status = 'pending_confirmation'",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_confirmation_token\n       ON tool_invocations(tenant_id, confirmation_token_id)\n       WHERE confirmation_token_id IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_retention\n       ON tool_invocations(invoked_at)\n       WHERE status != 'pending_confirmation'"
    ]
  },
  {
    "version": "v069",
    "description": "P1.7.2: events_user_journey for onboarding + first-use telemetry",
    "sql": [
      "CREATE TABLE IF NOT EXISTS events_user_journey (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      user_id TEXT,\n      session_id TEXT,\n      name TEXT NOT NULL,\n      properties_json TEXT NOT NULL DEFAULT '{}',\n      client_ts INTEGER NOT NULL,\n      ingested_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_events_user_journey_tenant_ts\n       ON events_user_journey(tenant_id, ingested_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_events_user_journey_user_ts\n       ON events_user_journey(tenant_id, user_id, ingested_at DESC)\n       WHERE user_id IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_events_user_journey_retention\n       ON events_user_journey(ingested_at)"
    ]
  },
  {
    "version": "v070",
    "description": "P2.7 health dashboard: core_values_snapshot daily history",
    "sql": [
      "CREATE TABLE IF NOT EXISTS core_values_snapshot (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT,\n      values_json TEXT NOT NULL,\n      snapshot_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_core_values_snapshot_tenant_ts\n       ON core_values_snapshot(tenant_id, snapshot_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_core_values_snapshot_retention\n       ON core_values_snapshot(snapshot_at)"
    ]
  },
  {
    "version": "v071",
    "description": "EP-3.5 devices.is_invalid_at column for push token invalidation",
    "sql": [
      "/* safe:add-column:devices:is_invalid_at */ ALTER TABLE devices ADD COLUMN is_invalid_at INTEGER",
      "CREATE INDEX IF NOT EXISTS idx_devices_invalid ON devices(is_invalid_at) WHERE is_invalid_at IS NOT NULL"
    ]
  },
  {
    "version": "v072",
    "description": "W2.1: agent-governance onboarding (org/agent/policy/synthetic/audit)",
    "sql": [
      "/* safe:add-column:onboarding_sessions:user_id */ ALTER TABLE onboarding_sessions ADD COLUMN user_id TEXT",
      "/* safe:add-column:onboarding_sessions:organization_id */ ALTER TABLE onboarding_sessions ADD COLUMN organization_id TEXT",
      "/* safe:add-column:onboarding_sessions:agent_id */ ALTER TABLE onboarding_sessions ADD COLUMN agent_id TEXT",
      "/* safe:add-column:onboarding_sessions:completed_at */ ALTER TABLE onboarding_sessions ADD COLUMN completed_at INTEGER",
      "CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_user ON onboarding_sessions(tenant_id, user_id) WHERE user_id IS NOT NULL",
      "CREATE TABLE IF NOT EXISTS onboarding_synthetic_invocations (\n      invocation_id TEXT PRIMARY KEY REFERENCES tool_invocations(id) ON DELETE CASCADE,\n      session_id TEXT NOT NULL,\n      created_at INTEGER NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_onboarding_synthetic_session ON onboarding_synthetic_invocations(session_id)",
      "/* safe:add-column:users:onboarded_at */ ALTER TABLE users ADD COLUMN onboarded_at INTEGER"
    ]
  },
  {
    "version": "v073",
    "description": "P0-E: append-only hash chain on audit_log",
    "sql": [
      "/* safe:add-column:audit_log:chain_seq */ ALTER TABLE audit_log ADD COLUMN chain_seq INTEGER",
      "/* safe:add-column:audit_log:prev_hash */ ALTER TABLE audit_log ADD COLUMN prev_hash TEXT",
      "/* safe:add-column:audit_log:record_hash */ ALTER TABLE audit_log ADD COLUMN record_hash TEXT",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_chain_unique ON audit_log(tenant_id, chain_seq) WHERE chain_seq IS NOT NULL"
    ]
  },
  {
    "version": "v074",
    "description": "P1-F-basic: SOC2 evidence collection table",
    "sql": [
      "CREATE TABLE IF NOT EXISTS compliance_evidence (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL,\n    control_id TEXT NOT NULL,\n    evidence_type TEXT NOT NULL,\n    collector TEXT NOT NULL DEFAULT 'system',\n    payload_json TEXT NOT NULL,\n    payload_sha256 TEXT NOT NULL,\n    collected_at INTEGER NOT NULL,\n    period_start INTEGER,\n    period_end INTEGER,\n    metadata_json TEXT\n  )",
      "CREATE INDEX IF NOT EXISTS idx_compliance_evidence_lookup ON compliance_evidence(tenant_id, control_id, collected_at)",
      "CREATE INDEX IF NOT EXISTS idx_compliance_evidence_period ON compliance_evidence(tenant_id, period_start, period_end)"
    ]
  },
  {
    "version": "v075",
    "description": "P1-N: legal_holds table for litigation / regulatory hold tracking",
    "sql": [
      "CREATE TABLE IF NOT EXISTS legal_holds (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL,\n    subject TEXT NOT NULL CHECK(subject IN ('tenant','user','persona')),\n    subject_id TEXT,\n    reason TEXT NOT NULL,\n    created_by TEXT NOT NULL,\n    created_at INTEGER NOT NULL,\n    released_at INTEGER,\n    released_by TEXT\n  )",
      "CREATE INDEX IF NOT EXISTS idx_legal_holds_active ON legal_holds(tenant_id, subject, subject_id) WHERE released_at IS NULL"
    ]
  },
  {
    "version": "v076",
    "description": "P1-M v2: durable break-glass JTI consumption ledger",
    "sql": [
      "CREATE TABLE IF NOT EXISTS break_glass_jti_consumptions (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL,\n    jti TEXT NOT NULL,\n    token_scope TEXT NOT NULL,\n    consumed_at TEXT NOT NULL,\n    consumed_by TEXT,\n    request_ip TEXT,\n    audit_seq INTEGER\n  )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_break_glass_jti_unique ON break_glass_jti_consumptions(tenant_id, jti)",
      "CREATE INDEX IF NOT EXISTS idx_break_glass_jti_consumed_at ON break_glass_jti_consumptions(consumed_at)"
    ]
  },
  {
    "version": "v077",
    "description": "P0-E v2: KMS-signed audit chain tail anchors",
    "sql": [
      "CREATE TABLE IF NOT EXISTS audit_chain_anchors (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL,\n    from_seq INTEGER NOT NULL,\n    to_seq INTEGER NOT NULL,\n    tail_hash TEXT NOT NULL,\n    signature TEXT NOT NULL,\n    key_id TEXT NOT NULL,\n    alg TEXT NOT NULL,\n    signed_at TEXT NOT NULL\n  )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_chain_anchors_unique_tail ON audit_chain_anchors(tenant_id, to_seq, tail_hash)",
      "CREATE INDEX IF NOT EXISTS idx_audit_chain_anchors_latest ON audit_chain_anchors(tenant_id, to_seq)"
    ]
  },
  {
    "version": "v078",
    "description": "P0-D #2: durable jwt_signing_keys with KeyRing state machine",
    "sql": [
      "CREATE TABLE IF NOT EXISTS jwt_signing_keys (\n    kid TEXT PRIMARY KEY,\n    state TEXT NOT NULL CHECK(state IN ('active','grace','retired','compromised')),\n    algorithm TEXT NOT NULL,\n    private_key TEXT NOT NULL DEFAULT '',\n    public_key TEXT NOT NULL DEFAULT '',\n    secret TEXT NOT NULL DEFAULT '',\n    created_at TEXT NOT NULL,\n    state_changed_at TEXT NOT NULL,\n    retired_at TEXT\n  )",
      "CREATE INDEX IF NOT EXISTS idx_jwt_signing_keys_state ON jwt_signing_keys(state)"
    ]
  },
  {
    "version": "v079",
    "description": "GA §8 #1: persist KMS anchor failures as evidence rows",
    "sql": [
      "CREATE TABLE IF NOT EXISTS audit_chain_anchor_failures (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL,\n    from_seq INTEGER NOT NULL,\n    to_seq INTEGER NOT NULL,\n    tail_hash TEXT NOT NULL,\n    error_code TEXT NOT NULL,\n    error_message TEXT NOT NULL,\n    attempted_at TEXT NOT NULL,\n    recovered_at TEXT\n  )",
      "CREATE INDEX IF NOT EXISTS idx_audit_chain_anchor_failures_open ON audit_chain_anchor_failures(tenant_id, recovered_at)",
      "CREATE INDEX IF NOT EXISTS idx_audit_chain_anchor_failures_attempted ON audit_chain_anchor_failures(attempted_at)"
    ]
  },
  {
    "version": "v080",
    "description": "ADR-0047: persist distillation artifacts (gated LLM→core pipeline)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS distilled_artifacts (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    persona_id TEXT NOT NULL,\n    kind TEXT NOT NULL CHECK(kind IN ('rule', 'value_shift', 'memory_edge', 'decision_style_patch', 'cognitive_model_patch', 'response_template', 'narrative_patch')),\n    source TEXT NOT NULL CHECK(source IN ('reflection', 'conversation', 'knowledge_import', 'onboarding')),\n    payload TEXT NOT NULL,\n    confidence REAL NOT NULL DEFAULT 0,\n    evidence TEXT NOT NULL DEFAULT '[]',\n    status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'approved', 'compiled', 'rejected', 'rolled_back')),\n    reason TEXT,\n    created_at INTEGER NOT NULL,\n    compiled_at INTEGER\n  )",
      "CREATE INDEX IF NOT EXISTS idx_distilled_artifacts_persona ON distilled_artifacts(tenant_id, persona_id)",
      "CREATE INDEX IF NOT EXISTS idx_distilled_artifacts_status ON distilled_artifacts(tenant_id, persona_id, status)"
    ]
  },
  {
    "version": "v081",
    "description": "ADR-0047/0048: per-persona concurrency lease (earning cycle + compile mutex)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_leases (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    persona_id TEXT NOT NULL,\n    purpose TEXT NOT NULL CHECK(purpose IN ('earning', 'compile')),\n    holder_token TEXT NOT NULL,\n    acquired_at INTEGER NOT NULL,\n    expires_at INTEGER NOT NULL,\n    PRIMARY KEY (tenant_id, persona_id, purpose)\n  )",
      "CREATE INDEX IF NOT EXISTS idx_persona_leases_expires ON persona_leases(expires_at)"
    ]
  },
  {
    "version": "v082",
    "description": "ADR-0047: durable versioned response_templates (replaces decaying procedural memory)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS response_templates (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    persona_id TEXT NOT NULL,\n    intent TEXT NOT NULL,\n    template TEXT NOT NULL,\n    version INTEGER NOT NULL DEFAULT 1,\n    artifact_id TEXT,\n    created_at INTEGER NOT NULL,\n    updated_at INTEGER NOT NULL,\n    PRIMARY KEY (tenant_id, persona_id, intent, version)\n  )",
      "CREATE INDEX IF NOT EXISTS idx_response_templates_intent ON response_templates(tenant_id, persona_id, intent, version)"
    ]
  },
  {
    "version": "v083",
    "description": "ADR-0047: durable versioned persona rules for rule-engine adjustments",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_rules (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    persona_id TEXT NOT NULL,\n    rule_id TEXT NOT NULL,\n    condition TEXT NOT NULL,\n    action TEXT NOT NULL,\n    weight REAL NOT NULL,\n    description TEXT,\n    artifact_id TEXT,\n    version INTEGER NOT NULL DEFAULT 1,\n    created_at INTEGER NOT NULL,\n    updated_at INTEGER NOT NULL,\n    PRIMARY KEY (tenant_id, persona_id, rule_id, version),\n    CHECK(action IN ('prefer', 'avoid')),\n    CHECK(weight >= 0 AND weight <= 1)\n  )",
      "CREATE INDEX IF NOT EXISTS idx_persona_rules_rule ON persona_rules(tenant_id, persona_id, rule_id, version)"
    ]
  },
  {
    "version": "v084",
    "description": "BYOK: encrypted per-tenant LLM provider API keys (llm_provider_credentials)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS llm_provider_credentials (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    provider TEXT NOT NULL,\n    api_key_encrypted TEXT NOT NULL,\n    created_by TEXT,\n    created_at INTEGER NOT NULL,\n    updated_at INTEGER NOT NULL,\n    PRIMARY KEY (tenant_id, provider)\n  )"
    ]
  },
  {
    "version": "v085",
    "description": "BYOK: per-tenant active LLM provider preference (tenant_llm_settings)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tenant_llm_settings (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    active_provider TEXT NOT NULL,\n    model TEXT,\n    embedding_model TEXT,\n    base_url TEXT,\n    updated_by TEXT,\n    created_at INTEGER NOT NULL,\n    updated_at INTEGER NOT NULL,\n    PRIMARY KEY (tenant_id)\n  )"
    ]
  },
  {
    "version": "v086",
    "description": "ADR-0052 Edge-P5: perception media reference metadata (raw media stays in object storage)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS perception_media_refs (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    object_key TEXT NOT NULL,\n    sha256 TEXT NOT NULL,\n    mime TEXT NOT NULL,\n    size_bytes INTEGER NOT NULL DEFAULT 0,\n    duration_ms INTEGER NOT NULL DEFAULT 0,\n    retention_class TEXT NOT NULL DEFAULT 'process-and-delete',\n    delete_after INTEGER,\n    status TEXT NOT NULL DEFAULT 'pending',\n    created_at INTEGER NOT NULL\n  )",
      "CREATE INDEX IF NOT EXISTS idx_perception_media_refs_tenant ON perception_media_refs(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_perception_media_refs_expiry ON perception_media_refs(delete_after)"
    ]
  }
] as const satisfies readonly LegacySqlMigration[];

export const LEGACY_POSTGRES_MIGRATIONS = [
  {
    "version": "v001",
    "description": "初始表结构",
    "sql": [
      "CREATE TABLE IF NOT EXISTS core_values (\n    id TEXT PRIMARY KEY,\n    label TEXT NOT NULL,\n    weight DOUBLE PRECISION NOT NULL CHECK(weight >= 0 AND weight <= 1),\n    updated_at BIGINT NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS memory_nodes (\n    id TEXT PRIMARY KEY,\n    kind TEXT NOT NULL CHECK(kind IN ('episodic', 'semantic', 'procedural')),\n    content TEXT NOT NULL,\n    valence DOUBLE PRECISION NOT NULL CHECK(valence >= -1 AND valence <= 1),\n    salience DOUBLE PRECISION NOT NULL CHECK(salience >= 0 AND salience <= 1),\n    created_at BIGINT NOT NULL,\n    last_accessed_at BIGINT NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS memory_edges (\n    source TEXT NOT NULL REFERENCES memory_nodes(id),\n    target TEXT NOT NULL REFERENCES memory_nodes(id),\n    strength DOUBLE PRECISION NOT NULL CHECK(strength >= 0 AND strength <= 1),\n    relation TEXT NOT NULL,\n    PRIMARY KEY (source, target)\n  )",
      "CREATE TABLE IF NOT EXISTS narrative (\n    id INTEGER PRIMARY KEY CHECK(id = 1),\n    content TEXT NOT NULL,\n    updated_at BIGINT NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS persona_versions (\n    id TEXT PRIMARY KEY,\n    label TEXT NOT NULL,\n    values_json TEXT NOT NULL,\n    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'failed')),\n    results_json TEXT NOT NULL DEFAULT '[]',\n    resource_quota DOUBLE PRECISION NOT NULL CHECK(resource_quota >= 0 AND resource_quota <= 1),\n    created_at BIGINT NOT NULL,\n    updated_at BIGINT NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS conflicts (\n    id TEXT PRIMARY KEY,\n    kind TEXT NOT NULL,\n    severity TEXT NOT NULL,\n    involved_versions_json TEXT NOT NULL,\n    affected_values_json TEXT NOT NULL,\n    description TEXT NOT NULL,\n    detected_at BIGINT NOT NULL,\n    resolved_at BIGINT,\n    resolution TEXT\n  )",
      "CREATE TABLE IF NOT EXISTS snapshots (\n    id TEXT PRIMARY KEY,\n    data_json TEXT NOT NULL,\n    reason TEXT NOT NULL,\n    created_at BIGINT NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS evolution_records (\n    id TEXT PRIMARY KEY,\n    before_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),\n    after_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),\n    merged_version_ids_json TEXT NOT NULL,\n    value_delta_json TEXT NOT NULL,\n    evolved_at BIGINT NOT NULL\n  )",
      "CREATE INDEX IF NOT EXISTS idx_persona_status ON persona_versions(status)",
      "CREATE INDEX IF NOT EXISTS idx_conflicts_resolved_at ON conflicts(resolved_at)",
      "CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at)",
      "CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target)"
    ]
  },
  {
    "version": "v002",
    "description": "审计日志表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS audit_log (\n    id TEXT PRIMARY KEY,\n    timestamp BIGINT NOT NULL,\n    method TEXT NOT NULL,\n    path TEXT NOT NULL,\n    request_id TEXT NOT NULL,\n    status_code INTEGER NOT NULL,\n    latency_ms DOUBLE PRECISION NOT NULL\n  )",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_path ON audit_log(path)"
    ]
  },
  {
    "version": "v003",
    "description": "审计日志增加 API Key 哈希字段",
    "sql": [
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS api_key_hash TEXT"
    ]
  },
  {
    "version": "v004",
    "description": "认知记忆扩展",
    "sql": [
      "ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS decay_lambda DOUBLE PRECISION NOT NULL DEFAULT 0.0001",
      "ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS last_decayed_at BIGINT NOT NULL DEFAULT 0",
      "ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS consolidated_from TEXT REFERENCES memory_nodes(id) ON DELETE SET NULL",
      "CREATE TABLE IF NOT EXISTS working_memory (\n      memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,\n      score DOUBLE PRECISION NOT NULL,\n      entered_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_working_memory_score ON working_memory(score)",
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_salience ON memory_nodes(salience)",
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_kind_access ON memory_nodes(kind, access_count)"
    ]
  },
  {
    "version": "v005",
    "description": "P-OS v0.1 人格模型",
    "sql": [
      "CREATE TABLE IF NOT EXISTS survival_anchors (\n    id TEXT PRIMARY KEY,\n    label TEXT NOT NULL,\n    kind TEXT NOT NULL CHECK(kind IN ('constraint', 'threshold', 'must_have')),\n    value_json TEXT NOT NULL,\n    severity INTEGER NOT NULL CHECK(severity >= 1 AND severity <= 5),\n    created_at BIGINT NOT NULL,\n    updated_at BIGINT NOT NULL\n  )",
      "CREATE INDEX IF NOT EXISTS idx_survival_anchors_kind ON survival_anchors(kind)",
      "CREATE INDEX IF NOT EXISTS idx_survival_anchors_severity ON survival_anchors(severity)",
      "CREATE TABLE IF NOT EXISTS decision_style (\n    id INTEGER PRIMARY KEY CHECK(id = 1),\n    style_json TEXT NOT NULL,\n    updated_at BIGINT NOT NULL\n  )",
      "CREATE TABLE IF NOT EXISTS cognitive_model (\n    id INTEGER PRIMARY KEY CHECK(id = 1),\n    model_json TEXT NOT NULL,\n    updated_at BIGINT NOT NULL\n  )"
    ]
  },
  {
    "version": "v006",
    "description": "记忆向量索引",
    "sql": [
      "CREATE TABLE IF NOT EXISTS memory_embeddings (\n    memory_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,\n    embedding_json TEXT NOT NULL,\n    model TEXT NOT NULL,\n    updated_at BIGINT NOT NULL\n  )"
    ]
  },
  {
    "version": "v007",
    "description": "多租户隔离",
    "sql": [
      "ALTER TABLE core_values ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE memory_edges ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE persona_versions ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE evolution_records ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE survival_anchors ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE narrative DROP CONSTRAINT IF EXISTS narrative_pkey",
      "ALTER TABLE narrative DROP COLUMN IF EXISTS id",
      "ALTER TABLE narrative ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE narrative ADD PRIMARY KEY (tenant_id)",
      "ALTER TABLE decision_style DROP CONSTRAINT IF EXISTS decision_style_pkey",
      "ALTER TABLE decision_style DROP COLUMN IF EXISTS id",
      "ALTER TABLE decision_style ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE decision_style ADD PRIMARY KEY (tenant_id)",
      "ALTER TABLE cognitive_model DROP CONSTRAINT IF EXISTS cognitive_model_pkey",
      "ALTER TABLE cognitive_model DROP COLUMN IF EXISTS id",
      "ALTER TABLE cognitive_model ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'",
      "ALTER TABLE cognitive_model ADD PRIMARY KEY (tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_core_values_tenant ON core_values(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant ON memory_nodes(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_persona_versions_tenant ON persona_versions(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_snapshots_tenant ON snapshots(tenant_id)",
      "CREATE TABLE IF NOT EXISTS quota_limits (\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      max_per_window INTEGER NOT NULL,\n      window_ms BIGINT NOT NULL,\n      PRIMARY KEY (tenant_id, resource)\n    )",
      "CREATE TABLE IF NOT EXISTS quota_usage (\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      used INTEGER NOT NULL DEFAULT 0,\n      window_start BIGINT NOT NULL,\n      PRIMARY KEY (tenant_id, resource, window_start)\n    )"
    ]
  },
  {
    "version": "v008",
    "description": "异步任务队列",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tasks (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      type TEXT NOT NULL,\n      payload TEXT NOT NULL DEFAULT '{}',\n      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),\n      result TEXT,\n      error TEXT,\n      retry_count INTEGER NOT NULL DEFAULT 0,\n      max_retries INTEGER NOT NULL DEFAULT 3,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL,\n      available_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tasks_status_available ON tasks(status, available_at)",
      "CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id)"
    ]
  },
  {
    "version": "v009",
    "description": "核心价值扩展 time_discount/emotion_amplifier",
    "sql": [
      "ALTER TABLE core_values ADD COLUMN IF NOT EXISTS time_discount DOUBLE PRECISION NOT NULL DEFAULT 0.5",
      "ALTER TABLE core_values ADD COLUMN IF NOT EXISTS emotion_amplifier DOUBLE PRECISION NOT NULL DEFAULT 1.0"
    ]
  },
  {
    "version": "v010",
    "description": "更新闸门 pending_updates",
    "sql": [
      "CREATE TABLE IF NOT EXISTS pending_updates (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      layer TEXT NOT NULL CHECK(layer IN ('L0', 'L1')),\n      trigger_type TEXT NOT NULL,\n      target_id TEXT NOT NULL,\n      current_value TEXT,\n      proposed_value TEXT,\n      delta DOUBLE PRECISION NOT NULL DEFAULT 0,\n      reason TEXT,\n      created_at BIGINT NOT NULL,\n      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected'))\n    )",
      "CREATE INDEX IF NOT EXISTS idx_pending_updates_status ON pending_updates(status)",
      "CREATE INDEX IF NOT EXISTS idx_pending_updates_tenant ON pending_updates(tenant_id)"
    ]
  },
  {
    "version": "v011",
    "description": "演化差异报告",
    "sql": [
      "ALTER TABLE evolution_records ADD COLUMN IF NOT EXISTS diff_report_json TEXT"
    ]
  },
  {
    "version": "v012",
    "description": "人生模拟引擎",
    "sql": [
      "CREATE TABLE IF NOT EXISTS life_simulations (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      task_id TEXT NOT NULL,\n      base_simulation_id TEXT REFERENCES life_simulations(id) ON DELETE SET NULL,\n      config_json TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),\n      summary_json TEXT,\n      progress_json TEXT,\n      error TEXT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL,\n      completed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_life_sims_tenant ON life_simulations(tenant_id, created_at)",
      "CREATE TABLE IF NOT EXISTS life_simulation_paths (\n      id TEXT PRIMARY KEY,\n      simulation_id TEXT NOT NULL REFERENCES life_simulations(id) ON DELETE CASCADE,\n      path_id TEXT NOT NULL,\n      label TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),\n      summary_json TEXT,\n      timeline_json TEXT,\n      branches_json TEXT,\n      retrospective_json TEXT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_life_sim_paths ON life_simulation_paths(simulation_id)"
    ]
  },
  {
    "version": "v013",
    "description": "用户认证与刷新令牌",
    "sql": [
      "CREATE TABLE IF NOT EXISTS users (\n      id TEXT PRIMARY KEY,\n      email TEXT NOT NULL UNIQUE,\n      password_hash TEXT NOT NULL,\n      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member', 'viewer')),\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)",
      "CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)",
      "CREATE TABLE IF NOT EXISTS refresh_tokens (\n      id TEXT PRIMARY KEY,\n      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      token_hash TEXT NOT NULL,\n      is_revoked INTEGER NOT NULL DEFAULT 0,\n      expires_at BIGINT NOT NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)"
    ]
  },
  {
    "version": "v014",
    "description": "订阅与用量记录",
    "sql": [
      "CREATE TABLE IF NOT EXISTS subscriptions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      stripe_customer_id TEXT,\n      stripe_subscription_id TEXT,\n      plan_id TEXT NOT NULL DEFAULT 'free',\n      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'past_due', 'canceled', 'trialing')),\n      current_period_start BIGINT NOT NULL,\n      current_period_end BIGINT NOT NULL,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id)",
      "CREATE TABLE IF NOT EXISTS usage_records (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      quantity INTEGER NOT NULL DEFAULT 1,\n      recorded_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_resource ON usage_records(tenant_id, resource, recorded_at)"
    ]
  },
  {
    "version": "v015",
    "description": "协作分享模拟",
    "sql": [
      "CREATE TABLE IF NOT EXISTS shared_simulations (\n      id TEXT PRIMARY KEY,\n      simulation_id TEXT NOT NULL,\n      owner_user_id TEXT NOT NULL,\n      shared_with_user_id TEXT NOT NULL,\n      permission TEXT NOT NULL DEFAULT 'view' CHECK(permission IN ('view', 'edit')),\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_shared_sims_sim ON shared_simulations(simulation_id)",
      "CREATE INDEX IF NOT EXISTS idx_shared_sims_shared_with ON shared_simulations(shared_with_user_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_sims_unique ON shared_simulations(simulation_id, shared_with_user_id)"
    ]
  },
  {
    "version": "v016",
    "description": "Webhook 事件去重表与 LLM 用量持久化表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS webhook_events (\n      event_id TEXT PRIMARY KEY,\n      event_type TEXT NOT NULL,\n      processed_at BIGINT NOT NULL\n    )",
      "CREATE TABLE IF NOT EXISTS llm_usage (\n      id BIGSERIAL PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      provider TEXT NOT NULL,\n      model TEXT NOT NULL,\n      input_tokens INTEGER NOT NULL,\n      output_tokens INTEGER NOT NULL,\n      total_tokens INTEGER NOT NULL,\n      estimated_cost_usd DOUBLE PRECISION NOT NULL,\n      recorded_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_llm_usage_tenant ON llm_usage(tenant_id, recorded_at)"
    ]
  },
  {
    "version": "v017",
    "description": "决策案例/运行结果与引导会话持久化",
    "sql": [
      "CREATE TABLE IF NOT EXISTS decision_cases (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      title TEXT NOT NULL,\n      description TEXT NOT NULL,\n      alternatives_json TEXT NOT NULL,\n      constraints_json TEXT,\n      context_json TEXT,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_decision_cases_tenant ON decision_cases(tenant_id)",
      "CREATE TABLE IF NOT EXISTS decision_runs (\n      id TEXT PRIMARY KEY,\n      case_id TEXT NOT NULL REFERENCES decision_cases(id) ON DELETE CASCADE,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      result_json TEXT NOT NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_decision_runs_case ON decision_runs(case_id)",
      "CREATE INDEX IF NOT EXISTS idx_decision_runs_tenant ON decision_runs(tenant_id)",
      "CREATE TABLE IF NOT EXISTS decision_feedbacks (\n      id TEXT PRIMARY KEY,\n      run_id TEXT NOT NULL REFERENCES decision_runs(id) ON DELETE CASCADE,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      selected_alternative TEXT NOT NULL,\n      satisfaction INTEGER NOT NULL,\n      notes TEXT,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_decision_feedbacks_run ON decision_feedbacks(run_id)",
      "CREATE TABLE IF NOT EXISTS onboarding_sessions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL DEFAULT 'default',\n      current_step INTEGER NOT NULL DEFAULT 1,\n      completed_steps_json TEXT NOT NULL DEFAULT '[]',\n      decision_json TEXT,\n      simulation_result_json TEXT,\n      snapshot_id TEXT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_tenant ON onboarding_sessions(tenant_id)"
    ]
  },
  {
    "version": "v018",
    "description": "刷新令牌复合索引与过期清理",
    "sql": [
      "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash_revoked ON refresh_tokens(token_hash, is_revoked)"
    ]
  },
  {
    "version": "v019",
    "description": "任务队列安全 — 工作者领取标记",
    "sql": [
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_by TEXT",
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claimed_at BIGINT"
    ]
  },
  {
    "version": "v020",
    "description": "Stripe 计量发件箱 — 持久化重试",
    "sql": [
      "CREATE TABLE IF NOT EXISTS billing_outbox (\n      id SERIAL PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      customer_id TEXT NOT NULL,\n      event_name TEXT NOT NULL,\n      quantity INTEGER NOT NULL,\n      idempotency_key TEXT NOT NULL UNIQUE,\n      status TEXT NOT NULL DEFAULT 'pending',\n      attempts INTEGER NOT NULL DEFAULT 0,\n      last_error TEXT,\n      created_at BIGINT NOT NULL,\n      processed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_billing_outbox_status ON billing_outbox (status, created_at)"
    ]
  },
  {
    "version": "v021",
    "description": "任务队列优先级支持",
    "sql": [
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks (priority DESC, created_at ASC) WHERE status = 'pending'"
    ]
  },
  {
    "version": "v022",
    "description": "IVF 质心持久化与 WebSocket 持久化事件日志",
    "sql": [
      "CREATE TABLE IF NOT EXISTS ivf_centroids (\n      model TEXT PRIMARY KEY,\n      centroids_json TEXT NOT NULL,\n      num_vectors INTEGER NOT NULL DEFAULT 0,\n      built_at BIGINT NOT NULL\n    )",
      "CREATE TABLE IF NOT EXISTS ws_event_log (\n      seq BIGSERIAL PRIMARY KEY,\n      event TEXT NOT NULL,\n      data_json TEXT NOT NULL,\n      tenant_id TEXT,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_ws_event_log_tenant ON ws_event_log (tenant_id, seq)",
      "CREATE INDEX IF NOT EXISTS idx_ws_event_log_created ON ws_event_log (created_at)"
    ]
  },
  {
    "version": "v023",
    "description": "API Key 租户绑定（支持计划感知限流）",
    "sql": [
      "CREATE TABLE IF NOT EXISTS api_keys (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      key_hash TEXT NOT NULL UNIQUE,\n      plan_id TEXT NOT NULL DEFAULT 'free',\n      is_revoked INTEGER NOT NULL DEFAULT 0,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash)",
      "CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id)"
    ]
  },
  {
    "version": "v024",
    "description": "任务队列 purge 和公平调度性能索引",
    "sql": [
      "CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks (status, updated_at)",
      "CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON tasks (tenant_id, status)"
    ]
  },
  {
    "version": "v025",
    "description": "配置中心（config_items/config_audit）与附加组件（add_ons/tenant_add_ons/entitlements）",
    "sql": [
      "CREATE TABLE IF NOT EXISTS config_items (\n      key TEXT PRIMARY KEY,\n      value_json TEXT NOT NULL,\n      category TEXT NOT NULL CHECK(category IN ('public', 'protected', 'admin', 'secret')),\n      requires_restart BOOLEAN NOT NULL DEFAULT FALSE,\n      group_key TEXT NOT NULL DEFAULT 'general',\n      updated_at BIGINT NOT NULL,\n      updated_by TEXT NOT NULL\n    )",
      "CREATE TABLE IF NOT EXISTS config_audit (\n      id BIGSERIAL PRIMARY KEY,\n      config_key TEXT NOT NULL,\n      old_value TEXT,\n      new_value TEXT,\n      changed_by TEXT NOT NULL,\n      changed_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_config_audit_key ON config_audit(config_key)",
      "CREATE INDEX IF NOT EXISTS idx_config_audit_time ON config_audit(changed_at)",
      "CREATE TABLE IF NOT EXISTS add_ons (\n      id TEXT PRIMARY KEY,\n      code TEXT NOT NULL UNIQUE,\n      name TEXT NOT NULL,\n      description TEXT NOT NULL DEFAULT '',\n      stripe_price_id TEXT NOT NULL DEFAULT '',\n      resource TEXT NOT NULL,\n      quota_amount INTEGER NOT NULL,\n      is_active BOOLEAN NOT NULL DEFAULT TRUE,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_add_ons_code ON add_ons(code)",
      "CREATE TABLE IF NOT EXISTS tenant_add_ons (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      add_on_id TEXT NOT NULL REFERENCES add_ons(id),\n      stripe_subscription_item_id TEXT,\n      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'canceled')),\n      purchased_at BIGINT NOT NULL,\n      canceled_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tenant_add_ons_tenant ON tenant_add_ons(tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_tenant_add_ons_status ON tenant_add_ons(tenant_id, status)",
      "CREATE TABLE IF NOT EXISTS entitlements (\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      effective_limit INTEGER NOT NULL,\n      source TEXT NOT NULL DEFAULT 'plan',\n      updated_at BIGINT NOT NULL,\n      PRIMARY KEY (tenant_id, resource)\n    )"
    ]
  },
  {
    "version": "v026",
    "description": "移动端设备注册与推送 token 管理",
    "sql": [
      "CREATE TABLE IF NOT EXISTS devices (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      user_id TEXT NOT NULL,\n      device_uid TEXT NOT NULL,\n      platform TEXT NOT NULL CHECK(platform IN ('ios', 'android', 'web')),\n      push_token TEXT,\n      app_version TEXT,\n      last_seen_at BIGINT NOT NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_tenant_user_uid ON devices(tenant_id, user_id, device_uid)",
      "CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id)"
    ]
  },
  {
    "version": "v027",
    "description": "身份与分身系统",
    "sql": [
      "CREATE TABLE IF NOT EXISTS identities (\n      id TEXT PRIMARY KEY,\n      user_id TEXT NOT NULL UNIQUE,\n      tenant_id TEXT NOT NULL,\n      display_name TEXT NOT NULL,\n      bio TEXT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenant_id)",
      "CREATE TABLE IF NOT EXISTS avatars (\n      id TEXT PRIMARY KEY,\n      identity_id TEXT NOT NULL REFERENCES identities(id),\n      label TEXT NOT NULL,\n      kind TEXT NOT NULL DEFAULT 'general'\n        CHECK(kind IN ('general','work','social','family','creative')),\n      behavior_overrides TEXT,\n      is_default INTEGER NOT NULL DEFAULT 0,\n      is_active INTEGER NOT NULL DEFAULT 1,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_avatars_identity ON avatars(identity_id)",
      "CREATE TABLE IF NOT EXISTS device_avatars (\n      id TEXT PRIMARY KEY,\n      device_id TEXT NOT NULL REFERENCES devices(id),\n      avatar_id TEXT NOT NULL REFERENCES avatars(id),\n      is_active INTEGER NOT NULL DEFAULT 0,\n      installed_at BIGINT NOT NULL,\n      UNIQUE(device_id, avatar_id)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_device_avatars_device ON device_avatars(device_id)",
      "CREATE INDEX IF NOT EXISTS idx_device_avatars_avatar ON device_avatars(avatar_id)",
      "INSERT INTO identities (id, user_id, tenant_id, display_name, created_at, updated_at)\n     SELECT 'ident_' || REPLACE(id, 'user_', ''), id, tenant_id, email, created_at, updated_at\n     FROM users\n     ON CONFLICT DO NOTHING",
      "INSERT INTO avatars (id, identity_id, label, kind, is_default, is_active, created_at, updated_at)\n     SELECT 'avt_' || REPLACE(id, 'ident_', ''), id, '默认', 'general', 1, 1, created_at, updated_at\n     FROM identities\n     ON CONFLICT DO NOTHING"
    ]
  },
  {
    "version": "v028",
    "description": "记忆淘汰索引（salience + last_accessed_at）",
    "sql": [
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant_salience ON memory_nodes(tenant_id, salience)",
      "CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant_last_accessed ON memory_nodes(tenant_id, last_accessed_at)"
    ]
  },
  {
    "version": "v029",
    "description": "Avatar 自动运行配置、运行日志、知识源表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS avatar_autorun_config (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      avatar_id TEXT NOT NULL REFERENCES avatars(id),\n      enabled INTEGER NOT NULL DEFAULT 0,\n      interval_ms BIGINT NOT NULL,\n      next_run_at BIGINT NOT NULL,\n      knowledge_source_ids_json TEXT NOT NULL DEFAULT '[]',\n      drift_check_interval_ms BIGINT NOT NULL DEFAULT 86400000,\n      drift_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.3,\n      review_required INTEGER NOT NULL DEFAULT 0,\n      last_run_at BIGINT,\n      last_drift_check_at BIGINT,\n      last_error TEXT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_autorun_config_avatar ON avatar_autorun_config(tenant_id, avatar_id)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_config_due ON avatar_autorun_config(tenant_id, enabled, next_run_at)",
      "CREATE TABLE IF NOT EXISTS avatar_autorun_runlog (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      avatar_id TEXT NOT NULL,\n      config_id TEXT NOT NULL REFERENCES avatar_autorun_config(id),\n      task_id TEXT NOT NULL DEFAULT '',\n      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),\n      metrics_json TEXT,\n      error TEXT,\n      started_at BIGINT,\n      completed_at BIGINT,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_autorun_runlog_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, started_at)",
      "CREATE TABLE IF NOT EXISTS knowledge_sources (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      type TEXT NOT NULL CHECK(type IN ('rss','api','file','manual')),\n      name TEXT NOT NULL,\n      enabled INTEGER NOT NULL DEFAULT 1,\n      config_json TEXT NOT NULL,\n      state_json TEXT,\n      last_ingested_at BIGINT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources(tenant_id, enabled, type)"
    ]
  },
  {
    "version": "v030",
    "description": "知识源支持 LLM 类型（更新 CHECK 约束）",
    "sql": [
      "ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_type_check",
      "ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_type_check CHECK(type IN ('rss','api','file','manual','llm'))"
    ]
  },
  {
    "version": "v031",
    "description": "补充 audit_log、subscriptions、pending_updates 等表的查询索引",
    "sql": [
      "CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_timestamp ON audit_log(tenant_id, timestamp)",
      "CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_status ON subscriptions(tenant_id, status)",
      "CREATE INDEX IF NOT EXISTS idx_pending_updates_status ON pending_updates(status, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON conflicts(resolved_at, detected_at)",
      "CREATE INDEX IF NOT EXISTS idx_working_memory_score ON working_memory(score DESC)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_config_next_run ON avatar_autorun_config(enabled, next_run_at)",
      "CREATE INDEX IF NOT EXISTS idx_autorun_runlog_tenant_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, created_at DESC)"
    ]
  },
  {
    "version": "v032",
    "description": "Persona Core 2.0：核心人格、钱包、市场、治理与成长事件",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_core (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      owner_user_id TEXT NOT NULL REFERENCES users(id),\n      display_name TEXT NOT NULL,\n      profile_json TEXT NOT NULL DEFAULT '{}',\n      status TEXT NOT NULL CHECK(status IN ('active','restricted','deceased','transferred')),\n      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','shared','marketplace')),\n      growth_index DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(growth_index >= 0),\n      reputation DOUBLE PRECISION NOT NULL DEFAULT 0,\n      training_investment DOUBLE PRECISION NOT NULL DEFAULT 0,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL,\n      deceased_at BIGINT,\n      transferred_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_core_owner ON persona_core(tenant_id, owner_user_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_persona_core_status ON persona_core(tenant_id, status)",
      "CREATE TABLE IF NOT EXISTS persona_wallets (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL UNIQUE REFERENCES persona_core(id) ON DELETE CASCADE,\n      wallet_address TEXT NOT NULL UNIQUE,\n      balance DOUBLE PRECISION NOT NULL DEFAULT 0,\n      token_balance DOUBLE PRECISION NOT NULL DEFAULT 0,\n      last_settled_at BIGINT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_wallets_persona ON persona_wallets(tenant_id, persona_id)",
      "CREATE TABLE IF NOT EXISTS persona_forks (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      label TEXT NOT NULL,\n      fork_type TEXT NOT NULL CHECK(fork_type IN ('experimental','task','social','research','operations')),\n      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','recycled','archived')),\n      sync_mode TEXT NOT NULL DEFAULT 'core' CHECK(sync_mode IN ('core','isolated')),\n      experience_factor DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(experience_factor >= 0 AND experience_factor <= 2),\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL,\n      recycled_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_forks_persona ON persona_forks(tenant_id, persona_id, status)",
      "CREATE TABLE IF NOT EXISTS persona_memories (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,\n      kind TEXT NOT NULL CHECK(kind IN ('interaction','task','training','knowledge','governance')),\n      summary TEXT NOT NULL,\n      content_json TEXT NOT NULL DEFAULT '{}',\n      importance DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_memories_persona ON persona_memories(tenant_id, persona_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_knowledge_items (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      title TEXT NOT NULL,\n      content TEXT NOT NULL,\n      source TEXT NOT NULL DEFAULT 'manual',\n      tags_json TEXT NOT NULL DEFAULT '[]',\n      confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_knowledge_persona ON persona_knowledge_items(tenant_id, persona_id, updated_at DESC)",
      "CREATE TABLE IF NOT EXISTS marketplace_tasks (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      publisher_user_id TEXT NOT NULL REFERENCES users(id),\n      assignee_persona_id TEXT REFERENCES persona_core(id) ON DELETE SET NULL,\n      assignee_fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,\n      title TEXT NOT NULL,\n      description TEXT NOT NULL,\n      category TEXT NOT NULL CHECK(category IN ('writing','coding','research','operations','general')),\n      reward DOUBLE PRECISION NOT NULL DEFAULT 0,\n      currency TEXT NOT NULL DEFAULT 'CRED',\n      status TEXT NOT NULL CHECK(status IN ('open','accepted','completed','cancelled')),\n      quality_score DOUBLE PRECISION,\n      growth_delta DOUBLE PRECISION,\n      published_at BIGINT NOT NULL,\n      accepted_at BIGINT,\n      completed_at BIGINT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_marketplace_tasks_status ON marketplace_tasks(tenant_id, status, updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_marketplace_tasks_assignee ON marketplace_tasks(tenant_id, assignee_persona_id, updated_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_growth_events (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      task_id TEXT REFERENCES marketplace_tasks(id) ON DELETE SET NULL,\n      event_type TEXT NOT NULL CHECK(event_type IN ('task_completed','training','knowledge_sync','governance')),\n      growth_delta DOUBLE PRECISION NOT NULL DEFAULT 0,\n      reputation_delta DOUBLE PRECISION NOT NULL DEFAULT 0,\n      training_delta DOUBLE PRECISION NOT NULL DEFAULT 0,\n      payload_json TEXT NOT NULL DEFAULT '{}',\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_growth_events_persona ON persona_growth_events(tenant_id, persona_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_governance_events (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      event_type TEXT NOT NULL CHECK(event_type IN ('warning','reward','restriction','review','transfer','death')),\n      severity INTEGER NOT NULL CHECK(severity >= 1 AND severity <= 5),\n      summary TEXT NOT NULL,\n      payload_json TEXT NOT NULL DEFAULT '{}',\n      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_governance_events_persona ON persona_governance_events(tenant_id, persona_id, created_at DESC)"
    ]
  },
  {
    "version": "v033",
    "description": "Persona OS：persona 级认知记忆、关联边与工作记忆",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_memory_nodes (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      fork_id TEXT REFERENCES persona_forks(id) ON DELETE SET NULL,\n      source_memory_id TEXT UNIQUE REFERENCES persona_memories(id) ON DELETE SET NULL,\n      knowledge_item_id TEXT UNIQUE REFERENCES persona_knowledge_items(id) ON DELETE SET NULL,\n      kind TEXT NOT NULL CHECK(kind IN ('episodic','semantic','procedural')),\n      content TEXT NOT NULL,\n      valence DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(valence >= -1 AND valence <= 1),\n      salience DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK(salience >= 0 AND salience <= 1),\n      access_count INTEGER NOT NULL DEFAULT 0,\n      decay_lambda DOUBLE PRECISION NOT NULL DEFAULT 0.0001,\n      last_accessed_at BIGINT NOT NULL,\n      last_decayed_at BIGINT NOT NULL,\n      consolidated_from TEXT REFERENCES persona_memory_nodes(id) ON DELETE SET NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_memory_nodes_persona ON persona_memory_nodes(tenant_id, persona_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_persona_memory_nodes_kind ON persona_memory_nodes(tenant_id, persona_id, kind, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_memory_edges (\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      source TEXT NOT NULL REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,\n      target TEXT NOT NULL REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,\n      strength DOUBLE PRECISION NOT NULL CHECK(strength >= 0 AND strength <= 1),\n      relation TEXT NOT NULL,\n      PRIMARY KEY (source, target)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_memory_edges_target ON persona_memory_edges(tenant_id, persona_id, target)",
      "CREATE TABLE IF NOT EXISTS persona_working_memory (\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      memory_id TEXT PRIMARY KEY REFERENCES persona_memory_nodes(id) ON DELETE CASCADE,\n      score DOUBLE PRECISION NOT NULL,\n      entered_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_working_memory_score ON persona_working_memory(tenant_id, persona_id, score DESC)"
    ]
  },
  {
    "version": "v034",
    "description": "Persona OS v1 对齐：生命周期状态、转移记录、声誉历史与分析表",
    "sql": [
      "ALTER TABLE persona_core ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active'",
      "UPDATE persona_core SET lifecycle_status = status WHERE lifecycle_status = 'active'",
      "CREATE INDEX IF NOT EXISTS idx_persona_core_lifecycle_status ON persona_core(tenant_id, lifecycle_status, updated_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_transfers (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      from_owner_user_id TEXT NOT NULL REFERENCES users(id),\n      to_owner_user_id TEXT NOT NULL REFERENCES users(id),\n      status TEXT NOT NULL CHECK(status IN ('pending_review','approved','completed','rejected','cancelled')),\n      reason TEXT NOT NULL DEFAULT '',\n      requested_at BIGINT NOT NULL,\n      approved_at BIGINT,\n      completed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_transfers_persona ON persona_transfers(tenant_id, persona_id, requested_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_persona_transfers_target ON persona_transfers(tenant_id, to_owner_user_id, requested_at DESC)",
      "CREATE TABLE IF NOT EXISTS reputation_history (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      old_score DOUBLE PRECISION NOT NULL,\n      new_score DOUBLE PRECISION NOT NULL,\n      reason TEXT NOT NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_reputation_history_persona ON reputation_history(tenant_id, persona_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS persona_daily_metrics (\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      metric_date TEXT NOT NULL,\n      tasks_completed INTEGER NOT NULL DEFAULT 0,\n      revenue DOUBLE PRECISION NOT NULL DEFAULT 0,\n      reputation_score DOUBLE PRECISION NOT NULL DEFAULT 0,\n      growth_index DOUBLE PRECISION NOT NULL DEFAULT 0,\n      PRIMARY KEY (tenant_id, persona_id, metric_date)\n    )",
      "CREATE TABLE IF NOT EXISTS marketplace_daily_metrics (\n      tenant_id TEXT NOT NULL,\n      metric_date TEXT NOT NULL,\n      open_tasks INTEGER NOT NULL DEFAULT 0,\n      completed_tasks INTEGER NOT NULL DEFAULT 0,\n      gross_volume DOUBLE PRECISION NOT NULL DEFAULT 0,\n      active_personas INTEGER NOT NULL DEFAULT 0,\n      PRIMARY KEY (tenant_id, metric_date)\n    )"
    ]
  },
  {
    "version": "v035",
    "description": "Persona OS v1：runtime session、任务工作流与治理 case/action",
    "sql": [
      "CREATE TABLE IF NOT EXISTS task_applications (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      ranking_score DOUBLE PRECISION NOT NULL DEFAULT 0,\n      status TEXT NOT NULL CHECK(status IN ('submitted','assigned','rejected','withdrawn')),\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_applications_unique ON task_applications(tenant_id, task_id, persona_id)",
      "CREATE INDEX IF NOT EXISTS idx_task_applications_task ON task_applications(tenant_id, task_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_task_applications_persona ON task_applications(tenant_id, persona_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS task_assignments (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      application_id TEXT REFERENCES task_applications(id) ON DELETE SET NULL,\n      runtime_session_id TEXT,\n      status TEXT NOT NULL CHECK(status IN ('assigned','in_progress','submitted','accepted','rejected','disputed','completed')),\n      assigned_at BIGINT NOT NULL,\n      started_at BIGINT,\n      submitted_at BIGINT,\n      completed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(tenant_id, task_id, assigned_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_task_assignments_persona ON task_assignments(tenant_id, persona_id, assigned_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_task_assignments_status ON task_assignments(tenant_id, status, assigned_at DESC)",
      "CREATE TABLE IF NOT EXISTS runtime_sessions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,\n      state TEXT NOT NULL CHECK(state IN ('PLAN','EXECUTE','EVALUATE','MEMORY_UPDATE','REPUTATION_UPDATE','COMPLETED','ERROR')),\n      plan_json TEXT,\n      artifacts_json TEXT NOT NULL DEFAULT '[]',\n      evaluation_json TEXT,\n      result_summary_json TEXT,\n      error_json TEXT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL,\n      completed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task ON runtime_sessions(tenant_id, task_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_persona ON runtime_sessions(tenant_id, persona_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_assignment ON runtime_sessions(tenant_id, assignment_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS task_results (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,\n      result_uri TEXT NOT NULL,\n      evaluation_json TEXT NOT NULL DEFAULT '{}',\n      quality_score DOUBLE PRECISION,\n      client_rating INTEGER,\n      status TEXT NOT NULL CHECK(status IN ('submitted','accepted','rejected','disputed')),\n      rejection_reason TEXT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL,\n      accepted_at BIGINT,\n      rejected_at BIGINT,\n      disputed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_task_results_assignment ON task_results(tenant_id, assignment_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_task_results_task ON task_results(tenant_id, task_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS governance_cases (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,\n      task_id TEXT REFERENCES marketplace_tasks(id) ON DELETE SET NULL,\n      trigger_type TEXT NOT NULL,\n      severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),\n      status TEXT NOT NULL CHECK(status IN ('open','action_applied','appealed','resolved')),\n      details_json TEXT NOT NULL DEFAULT '{}',\n      appeal_json TEXT,\n      opened_at BIGINT NOT NULL,\n      resolved_at BIGINT,\n      appealed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_governance_cases_persona ON governance_cases(tenant_id, persona_id, opened_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_governance_cases_status ON governance_cases(tenant_id, status, opened_at DESC)",
      "CREATE TABLE IF NOT EXISTS governance_actions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      case_id TEXT NOT NULL REFERENCES governance_cases(id) ON DELETE CASCADE,\n      action_type TEXT NOT NULL CHECK(action_type IN ('warning','temporary_restriction','temporary_suspension','reinstate','termination')),\n      duration_seconds INTEGER,\n      details_json TEXT NOT NULL DEFAULT '{}',\n      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_governance_actions_case ON governance_actions(tenant_id, case_id, created_at DESC)"
    ]
  },
  {
    "version": "v036",
    "description": "Persona OS v1：钱包账本、提现请求与任务结算",
    "sql": [
      "ALTER TABLE persona_wallets ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CRED'",
      "ALTER TABLE persona_wallets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'",
      "CREATE TABLE IF NOT EXISTS wallet_transactions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,\n      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('task_payment','platform_fee','owner_payout','persona_reserve','refund')),\n      amount_minor BIGINT NOT NULL,\n      currency TEXT NOT NULL,\n      reference_type TEXT,\n      reference_id TEXT,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet ON wallet_transactions(tenant_id, wallet_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference ON wallet_transactions(tenant_id, reference_type, reference_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS wallet_payout_requests (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,\n      amount_minor BIGINT NOT NULL CHECK(amount_minor > 0),\n      currency TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('completed','rejected')),\n      requested_by_user_id TEXT NOT NULL REFERENCES users(id),\n      created_at BIGINT NOT NULL,\n      completed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_wallet_payout_requests_wallet ON wallet_payout_requests(tenant_id, wallet_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS wallet_settlements (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      wallet_id TEXT NOT NULL REFERENCES persona_wallets(id) ON DELETE CASCADE,\n      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,\n      assignment_id TEXT NOT NULL UNIQUE REFERENCES task_assignments(id) ON DELETE CASCADE,\n      total_amount_minor BIGINT NOT NULL CHECK(total_amount_minor > 0),\n      currency TEXT NOT NULL,\n      owner_pct INTEGER NOT NULL,\n      persona_pct INTEGER NOT NULL,\n      platform_pct INTEGER NOT NULL,\n      owner_amount_minor BIGINT NOT NULL,\n      persona_amount_minor BIGINT NOT NULL,\n      platform_amount_minor BIGINT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('completed')),\n      created_at BIGINT NOT NULL,\n      completed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_wallet_settlements_wallet ON wallet_settlements(tenant_id, wallet_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_wallet_settlements_task ON wallet_settlements(tenant_id, task_id, created_at DESC)"
    ]
  },
  {
    "version": "v037",
    "description": "Persona OS v1：敏感记忆分级与静态加密元数据",
    "sql": [
      "ALTER TABLE persona_memories ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'private'",
      "ALTER TABLE persona_memories ADD COLUMN IF NOT EXISTS is_encrypted INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE persona_memories ADD COLUMN IF NOT EXISTS owner_restricted INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX IF NOT EXISTS idx_persona_memories_sensitivity ON persona_memories(tenant_id, persona_id, sensitivity, created_at DESC)"
    ]
  },
  {
    "version": "v038",
    "description": "企业可观测性：异步观测发件箱与聚合滚动表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS observability_outbox (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      topic TEXT NOT NULL,\n      event_type TEXT NOT NULL,\n      partition_key TEXT NOT NULL,\n      payload_json TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','processing','sent','failed')),\n      attempts INTEGER NOT NULL DEFAULT 0,\n      created_at BIGINT NOT NULL,\n      processed_at BIGINT,\n      last_error TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_observability_outbox_status ON observability_outbox(status, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS idx_observability_outbox_tenant ON observability_outbox(tenant_id, status, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS idx_observability_outbox_topic ON observability_outbox(topic, partition_key, created_at ASC)",
      "CREATE TABLE IF NOT EXISTS observability_rollups (\n      tenant_id TEXT PRIMARY KEY,\n      runtime_completed_count BIGINT NOT NULL DEFAULT 0,\n      runtime_duration_total_ms BIGINT NOT NULL DEFAULT 0,\n      task_terminal_count BIGINT NOT NULL DEFAULT 0,\n      task_success_count BIGINT NOT NULL DEFAULT 0,\n      task_rejected_count BIGINT NOT NULL DEFAULT 0,\n      task_disputed_count BIGINT NOT NULL DEFAULT 0,\n      wallet_settlement_count BIGINT NOT NULL DEFAULT 0,\n      wallet_settlement_total_amount_minor BIGINT NOT NULL DEFAULT 0,\n      wallet_settlement_latency_total_ms BIGINT NOT NULL DEFAULT 0,\n      governance_case_opened_count BIGINT NOT NULL DEFAULT 0,\n      governance_case_active_count BIGINT NOT NULL DEFAULT 0,\n      governance_action_applied_count BIGINT NOT NULL DEFAULT 0,\n      persona_growth_total DOUBLE PRECISION NOT NULL DEFAULT 0,\n      persona_growth_event_count BIGINT NOT NULL DEFAULT 0,\n      persona_reputation_delta_total DOUBLE PRECISION NOT NULL DEFAULT 0,\n      updated_at BIGINT NOT NULL\n    )"
    ]
  },
  {
    "version": "v039",
    "description": "企业可靠性：通用 Idempotency-Key 响应缓存",
    "sql": [
      "CREATE TABLE IF NOT EXISTS idempotency_keys (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      scope_key TEXT NOT NULL,\n      idempotency_key TEXT NOT NULL,\n      request_hash TEXT NOT NULL,\n      request_method TEXT NOT NULL,\n      request_path TEXT NOT NULL,\n      state TEXT NOT NULL CHECK(state IN ('in_progress','completed')),\n      response_status INTEGER,\n      response_content_type TEXT,\n      response_headers_json TEXT,\n      response_body TEXT,\n      created_at BIGINT NOT NULL,\n      expires_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_scope ON idempotency_keys(tenant_id, scope_key, idempotency_key)",
      "CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expiry ON idempotency_keys(expires_at)"
    ]
  },
  {
    "version": "v040",
    "description": "企业审计：扩展 audit_log 支持业务级审计事件",
    "sql": [
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS event_kind TEXT NOT NULL DEFAULT 'request'",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_id TEXT",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_email TEXT",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS action_type TEXT DEFAULT 'other'",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type TEXT",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id TEXT",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_type TEXT",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_id TEXT",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS payload_json TEXT",
      "UPDATE audit_log SET created_at = timestamp WHERE created_at = 0",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created_at ON audit_log(tenant_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(tenant_id, actor_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(tenant_id, target_type, target_id, created_at DESC)"
    ]
  },
  {
    "version": "v041",
    "description": "企业可靠性：runtime session 超时、重试与终态恢复",
    "sql": [
      "ALTER TABLE runtime_sessions ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE runtime_sessions ADD COLUMN IF NOT EXISTS timeout_at BIGINT",
      "UPDATE runtime_sessions\n     SET state = 'FAILED'\n     WHERE state = 'ERROR'",
      "ALTER TABLE runtime_sessions DROP CONSTRAINT IF EXISTS runtime_sessions_state_check",
      "ALTER TABLE runtime_sessions\n     ADD CONSTRAINT runtime_sessions_state_check\n     CHECK (state IN ('PLAN','EXECUTE','EVALUATE','MEMORY_UPDATE','REPUTATION_UPDATE','COMPLETED','FAILED','TIMEOUT','ERROR'))",
      "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_timeout ON runtime_sessions(tenant_id, state, timeout_at)"
    ]
  },
  {
    "version": "v042",
    "description": "企业可靠性：平台 DLQ 事件持久化与 replay",
    "sql": [
      "CREATE TABLE IF NOT EXISTS platform_dlq_events (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      source_component TEXT NOT NULL,\n      source_topic TEXT NOT NULL,\n      dlq_topic TEXT NOT NULL CHECK(dlq_topic IN ('runtime.dlq','wallet.dlq','governance.dlq')),\n      event_type TEXT NOT NULL,\n      partition_key TEXT,\n      payload_json TEXT NOT NULL,\n      error_message TEXT NOT NULL,\n      status TEXT NOT NULL CHECK(status IN ('pending','replayed')),\n      created_at BIGINT NOT NULL,\n      replayed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_platform_dlq_status ON platform_dlq_events(status, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS idx_platform_dlq_tenant ON platform_dlq_events(tenant_id, status, created_at ASC)",
      "CREATE INDEX IF NOT EXISTS idx_platform_dlq_topic ON platform_dlq_events(dlq_topic, status, created_at ASC)"
    ]
  },
  {
    "version": "v043",
    "description": "企业协作：organization/workspace/membership/role_binding",
    "sql": [
      "CREATE TABLE IF NOT EXISTS organizations (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      name TEXT NOT NULL,\n      slug TEXT NOT NULL,\n      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(tenant_id, slug)",
      "CREATE INDEX IF NOT EXISTS idx_organizations_creator ON organizations(tenant_id, created_by_user_id, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS workspaces (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,\n      name TEXT NOT NULL,\n      slug TEXT NOT NULL,\n      is_default INTEGER NOT NULL DEFAULT 0,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(tenant_id, organization_id, slug)",
      "CREATE INDEX IF NOT EXISTS idx_workspaces_default ON workspaces(tenant_id, organization_id, is_default)",
      "CREATE TABLE IF NOT EXISTS organization_memberships (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,\n      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n      status TEXT NOT NULL CHECK(status IN ('active','invited','suspended')),\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_org_memberships_unique ON organization_memberships(tenant_id, organization_id, user_id)",
      "CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON organization_memberships(tenant_id, user_id, status, created_at DESC)",
      "CREATE TABLE IF NOT EXISTS organization_role_bindings (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,\n      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,\n      membership_id TEXT NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,\n      role TEXT NOT NULL CHECK(role IN ('org_admin','billing_admin','persona_operator','marketplace_manager','auditor','viewer')),\n      created_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_org_role_bindings_unique ON organization_role_bindings(tenant_id, organization_id, workspace_id, membership_id, role)",
      "CREATE INDEX IF NOT EXISTS idx_org_role_bindings_membership ON organization_role_bindings(tenant_id, membership_id, role)"
    ]
  },
  {
    "version": "v044",
    "description": "企业商用：billing catalog、invoice、usage meter",
    "sql": [
      "CREATE TABLE IF NOT EXISTS billing_plans (\n      id TEXT PRIMARY KEY,\n      name TEXT NOT NULL,\n      stripe_price_id TEXT NOT NULL DEFAULT '',\n      price_minor INTEGER NOT NULL DEFAULT 0,\n      currency TEXT NOT NULL DEFAULT 'USD',\n      billing_interval TEXT NOT NULL DEFAULT 'month',\n      limits_json TEXT NOT NULL,\n      is_active INTEGER NOT NULL DEFAULT 1,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_billing_plans_active ON billing_plans(is_active, id)",
      "CREATE TABLE IF NOT EXISTS billing_invoices (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,\n      plan_id TEXT NOT NULL REFERENCES billing_plans(id),\n      status TEXT NOT NULL CHECK(status IN ('draft','open','paid','void')),\n      amount_minor INTEGER NOT NULL DEFAULT 0,\n      currency TEXT NOT NULL DEFAULT 'USD',\n      billing_interval TEXT NOT NULL DEFAULT 'month',\n      period_start BIGINT NOT NULL,\n      period_end BIGINT NOT NULL,\n      wallet_settlement_count INTEGER NOT NULL DEFAULT 0,\n      wallet_settlement_total_minor BIGINT NOT NULL DEFAULT 0,\n      reconciliation_status TEXT NOT NULL DEFAULT 'balanced' CHECK(reconciliation_status IN ('balanced','mismatch','repair_required')),\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL,\n      paid_at BIGINT\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_period ON billing_invoices(tenant_id, subscription_id, period_start)",
      "CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant ON billing_invoices(tenant_id, status, period_start DESC)",
      "CREATE TABLE IF NOT EXISTS usage_meters (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      resource TEXT NOT NULL,\n      period_start BIGINT NOT NULL,\n      period_end BIGINT NOT NULL,\n      total_quantity INTEGER NOT NULL DEFAULT 0,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_meters_period ON usage_meters(tenant_id, resource, period_start, period_end)",
      "CREATE INDEX IF NOT EXISTS idx_usage_meters_tenant ON usage_meters(tenant_id, period_start DESC, resource)"
    ]
  },
  {
    "version": "v045",
    "description": "企业财务：settlement reconciliation runs",
    "sql": [
      "CREATE TABLE IF NOT EXISTS settlement_reconciliation_runs (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      checked_settlements INTEGER NOT NULL DEFAULT 0,\n      mismatched_settlements INTEGER NOT NULL DEFAULT 0,\n      repaired_settlements INTEGER NOT NULL DEFAULT 0,\n      deleted_transactions INTEGER NOT NULL DEFAULT 0,\n      inserted_transactions INTEGER NOT NULL DEFAULT 0,\n      orphan_transactions_removed INTEGER NOT NULL DEFAULT 0,\n      report_json TEXT NOT NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_settlement_reconciliation_runs_tenant ON settlement_reconciliation_runs(tenant_id, created_at DESC)"
    ]
  },
  {
    "version": "v046",
    "description": "企业集成：tenant enterprise profile / oidc / scim / dedicated deployment",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tenant_enterprise_profiles (\n      tenant_id TEXT PRIMARY KEY,\n      deployment_mode TEXT NOT NULL DEFAULT 'shared_cluster' CHECK(deployment_mode IN ('shared_cluster','dedicated_db')),\n      database_isolation_mode TEXT NOT NULL DEFAULT 'shared' CHECK(database_isolation_mode IN ('shared','dedicated')),\n      kafka_namespace TEXT NOT NULL DEFAULT '',\n      encryption_mode TEXT NOT NULL DEFAULT 'platform_managed' CHECK(encryption_mode IN ('platform_managed','tenant_dedicated')),\n      kms_key_ref TEXT,\n      scim_token_hash TEXT,\n      oidc_enabled INTEGER NOT NULL DEFAULT 0,\n      oidc_issuer_url TEXT NOT NULL DEFAULT '',\n      oidc_client_id TEXT NOT NULL DEFAULT '',\n      oidc_client_secret_encrypted TEXT NOT NULL DEFAULT '',\n      oidc_audience TEXT NOT NULL DEFAULT '',\n      oidc_scope TEXT NOT NULL DEFAULT 'openid profile email',\n      oidc_email_claim TEXT NOT NULL DEFAULT 'email',\n      oidc_name_claim TEXT NOT NULL DEFAULT 'name',\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_enterprise_profiles_scim_hash ON tenant_enterprise_profiles(scim_token_hash)"
    ]
  },
  {
    "version": "v047",
    "description": "身份层重构：tenant 可包含多个 identities 与独立 avatar 生命周期",
    "sql": [
      "ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_tenant_id_key",
      "DROP INDEX IF EXISTS idx_identities_tenant_user",
      "CREATE INDEX IF NOT EXISTS idx_identities_tenant_user ON identities(tenant_id, user_id)"
    ]
  },
  {
    "version": "v048",
    "description": "观测链路：为 Kafka / DB 双路径增加 rollup 幂等去重",
    "sql": [
      "CREATE TABLE IF NOT EXISTS observability_processed_events (\n      event_id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      event_type TEXT NOT NULL,\n      processed_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_observability_processed_events_tenant ON observability_processed_events(tenant_id, processed_at DESC)"
    ]
  },
  {
    "version": "v049",
    "description": "可移植性：异步导出任务状态追踪",
    "sql": [
      "CREATE TABLE IF NOT EXISTS export_jobs (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      state TEXT NOT NULL DEFAULT 'queued',\n      percent INTEGER NOT NULL DEFAULT 0,\n      eta_ms BIGINT,\n      created_at BIGINT NOT NULL,\n      completed_at BIGINT,\n      download_url TEXT,\n      error_code TEXT,\n      warnings TEXT NOT NULL DEFAULT '[]',\n      pack_json TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_export_jobs_tenant ON export_jobs(tenant_id, created_at DESC)"
    ]
  },
  {
    "version": "v050",
    "description": "KMS 密钥操作审计日志",
    "sql": [
      "CREATE TABLE IF NOT EXISTS kms_key_audit (\n      event_id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      operation TEXT NOT NULL,\n      provider TEXT NOT NULL,\n      key_ref TEXT NOT NULL,\n      performed_at TEXT NOT NULL,\n      success INTEGER NOT NULL DEFAULT 1,\n      error_code TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_kms_key_audit_tenant ON kms_key_audit(tenant_id, performed_at DESC)"
    ]
  },
  {
    "version": "v051",
    "description": "租户自带对象存储（BYOS）配置",
    "sql": [
      "ALTER TABLE tenant_enterprise_profiles ADD COLUMN IF NOT EXISTS byos_provider TEXT NOT NULL DEFAULT 'platform'",
      "ALTER TABLE tenant_enterprise_profiles ADD COLUMN IF NOT EXISTS byos_bucket TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE tenant_enterprise_profiles ADD COLUMN IF NOT EXISTS byos_key_prefix TEXT NOT NULL DEFAULT ''"
    ]
  },
  {
    "version": "v052",
    "description": "事件账本：event_ledger 主表、消费者检查点与权威模式控制表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS event_ledger (\n      event_id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      stream_id TEXT NOT NULL,\n      stream_version INTEGER NOT NULL,\n      event_type TEXT NOT NULL,\n      schema_version INTEGER NOT NULL DEFAULT 1,\n      occurred_at BIGINT NOT NULL,\n      command_id TEXT NOT NULL,\n      payload_json TEXT NOT NULL,\n      backfill_source_id TEXT,\n      UNIQUE(tenant_id, stream_id, stream_version)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_event_ledger_stream ON event_ledger(tenant_id, stream_id, stream_version)",
      "CREATE INDEX IF NOT EXISTS idx_event_ledger_tenant ON event_ledger(tenant_id, occurred_at)",
      "CREATE TABLE IF NOT EXISTS event_ledger_consumer_checkpoints (\n      consumer_id TEXT PRIMARY KEY,\n      last_event_id TEXT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE TABLE IF NOT EXISTS event_ledger_authority (\n      singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK(singleton = 1),\n      mode TEXT NOT NULL DEFAULT 'tables_primary',\n      changed_at BIGINT NOT NULL,\n      changed_reason TEXT NOT NULL DEFAULT ''\n    )",
      "INSERT INTO event_ledger_authority(singleton, mode, changed_at) VALUES(1, 'tables_primary', 0) ON CONFLICT (singleton) DO NOTHING"
    ]
  },
  {
    "version": "v053",
    "description": "persona_core 双写发件箱：暂存待追加至 event_ledger 的事件",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_core_ledger_outbox (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      stream_id TEXT NOT NULL,\n      payload_json TEXT NOT NULL,\n      event_type TEXT NOT NULL,\n      command_id TEXT NOT NULL,\n      created_at BIGINT NOT NULL,\n      attempts INTEGER NOT NULL DEFAULT 0,\n      last_attempted_at BIGINT,\n      error TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_outbox_pending ON persona_core_ledger_outbox(tenant_id, created_at) WHERE attempts < 3"
    ]
  },
  {
    "version": "v054",
    "description": "投影存储：读模型持久化，支持按租户+投影名+ID读写",
    "sql": [
      "CREATE TABLE IF NOT EXISTS projection_store (\n      tenant_id TEXT NOT NULL,\n      projection TEXT NOT NULL,\n      id TEXT NOT NULL,\n      value_json TEXT NOT NULL,\n      version INTEGER NOT NULL DEFAULT 0,\n      updated_at BIGINT NOT NULL,\n      PRIMARY KEY (tenant_id, projection, id)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_projection_store_list ON projection_store(tenant_id, projection, id)"
    ]
  },
  {
    "version": "v055",
    "description": "平台密钥撤销记录",
    "sql": [
      "CREATE TABLE IF NOT EXISTS platform_key_revocations (\n      key_ref TEXT PRIMARY KEY,\n      revoked_at BIGINT NOT NULL,\n      revoked_by TEXT\n    )"
    ]
  },
  {
    "version": "v056",
    "description": "平台运维操作日志（控制平面事件）",
    "sql": [
      "CREATE TABLE IF NOT EXISTS platform_ops_log (\n      id TEXT PRIMARY KEY,\n      event_type TEXT NOT NULL,\n      payload_json TEXT NOT NULL,\n      occurred_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_platform_ops_log_time ON platform_ops_log(occurred_at DESC)"
    ]
  },
  {
    "version": "v057",
    "description": "同步冲突收件箱",
    "sql": [
      "CREATE TABLE IF NOT EXISTS conflict_inbox (\n      conflict_id TEXT PRIMARY KEY,\n      conflict_version TEXT NOT NULL,\n      tenant_id TEXT NOT NULL,\n      entity_type TEXT NOT NULL,\n      entity_id TEXT NOT NULL,\n      command_id TEXT,\n      source_runtime TEXT NOT NULL,\n      detected_at TEXT NOT NULL,\n      severity TEXT NOT NULL DEFAULT 'warning',\n      local_summary_id TEXT NOT NULL,\n      local_summary_params TEXT NOT NULL DEFAULT '{}',\n      server_summary_id TEXT NOT NULL,\n      server_summary_params TEXT NOT NULL DEFAULT '{}',\n      suggested_actions TEXT NOT NULL DEFAULT '[\"keep_server\"]',\n      resolved_at TEXT,\n      resolution_action TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_conflict_inbox_tenant ON conflict_inbox(tenant_id, detected_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_conflict_inbox_blocking ON conflict_inbox(tenant_id, severity) WHERE resolved_at IS NULL"
    ]
  },
  {
    "version": "v058",
    "description": "可移植性：导入 commit token 与导入任务追踪",
    "sql": [
      "CREATE TABLE IF NOT EXISTS import_commit_tokens (\n      token TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      import_id TEXT NOT NULL,\n      manifest_checksum TEXT NOT NULL,\n      expires_at BIGINT NOT NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_ict_tenant ON import_commit_tokens(tenant_id)",
      "CREATE TABLE IF NOT EXISTS import_jobs (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      state TEXT NOT NULL DEFAULT 'pending',\n      manifest_checksum TEXT NOT NULL,\n      imported_count INTEGER NOT NULL DEFAULT 0,\n      skipped_count INTEGER NOT NULL DEFAULT 0,\n      created_at BIGINT NOT NULL,\n      completed_at BIGINT,\n      error_message TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_ij_tenant ON import_jobs(tenant_id)"
    ]
  },
  {
    "version": "v059",
    "description": "租户 BYOK/BYOS 密钥版本、密钥操作审计与存储绑定",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tenant_key_versions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      key_ref TEXT NOT NULL,\n      provider TEXT NOT NULL,\n      version INTEGER NOT NULL,\n      status TEXT NOT NULL DEFAULT 'active',\n      created_at BIGINT NOT NULL,\n      revoked_at BIGINT,\n      UNIQUE(tenant_id, key_ref, provider, version)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tenant_key_versions_tenant_key\n      ON tenant_key_versions(tenant_id, key_ref, provider, version DESC)",
      "CREATE TABLE IF NOT EXISTS tenant_vault_audit (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      operation TEXT NOT NULL,\n      key_ref TEXT NOT NULL,\n      key_version INTEGER,\n      outcome TEXT NOT NULL,\n      error_message TEXT,\n      performed_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tenant_vault_audit_tenant_time\n      ON tenant_vault_audit(tenant_id, performed_at DESC)",
      "CREATE TABLE IF NOT EXISTS tenant_storage_bindings (\n      tenant_id TEXT PRIMARY KEY,\n      provider TEXT NOT NULL,\n      bucket_or_path TEXT NOT NULL,\n      region TEXT,\n      encryption_key_ref TEXT,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )"
    ]
  },
  {
    "version": "v060",
    "description": "AI 安全治理：memory_nodes 置信度、来源类型与未验证标记",
    "sql": [
      "ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0.5",
      "ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS unverified INTEGER NOT NULL DEFAULT 1"
    ]
  },
  {
    "version": "v061",
    "description": "AI 安全治理：人格漂移分析日志",
    "sql": [
      "CREATE TABLE IF NOT EXISTS drift_analysis_log (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      baseline_snapshot_id TEXT,\n      analyzed_at BIGINT NOT NULL,\n      overall_drift_score DOUBLE PRECISION NOT NULL,\n      alert_level TEXT NOT NULL DEFAULT 'ok',\n      value_drifts_json TEXT NOT NULL DEFAULT '[]'\n    )",
      "CREATE INDEX IF NOT EXISTS idx_drift_analysis_log_tenant ON drift_analysis_log(tenant_id, analyzed_at DESC)"
    ]
  },
  {
    "version": "v062",
    "description": "P1-A 岗位人格模板：predefined builtin templates + custom CRUD",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_templates (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      category TEXT NOT NULL,\n      label TEXT NOT NULL,\n      description TEXT NOT NULL DEFAULT '',\n      default_values_json TEXT NOT NULL DEFAULT '[]',\n      default_narrative TEXT NOT NULL DEFAULT '',\n      behavior_boundaries_json TEXT NOT NULL DEFAULT '[]',\n      required_knowledge_categories_json TEXT NOT NULL DEFAULT '[]',\n      is_builtin INTEGER NOT NULL DEFAULT 0,\n      created_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_persona_templates_tenant_category ON persona_templates(tenant_id, category)"
    ]
  },
  {
    "version": "v063",
    "description": "P1-B 知识批量导入：fingerprint 去重 + 异步 job 跟踪",
    "sql": [
      "ALTER TABLE persona_knowledge_items ADD COLUMN IF NOT EXISTS fingerprint TEXT",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_knowledge_fp ON persona_knowledge_items(tenant_id, persona_id, fingerprint) WHERE fingerprint IS NOT NULL",
      "CREATE TABLE IF NOT EXISTS bulk_knowledge_import_jobs (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      owner_user_id TEXT NOT NULL,\n      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued', 'running', 'completed', 'failed')),\n      total_items INTEGER NOT NULL,\n      imported_count INTEGER NOT NULL DEFAULT 0,\n      skipped_count INTEGER NOT NULL DEFAULT 0,\n      failed_count INTEGER NOT NULL DEFAULT 0,\n      failures_json TEXT NOT NULL DEFAULT '[]',\n      deduplicate_strategy TEXT NOT NULL DEFAULT 'skip' CHECK(deduplicate_strategy IN ('skip', 'overwrite')),\n      created_at BIGINT NOT NULL,\n      started_at BIGINT,\n      completed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_bki_jobs_tenant_created ON bulk_knowledge_import_jobs(tenant_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_bki_jobs_persona ON bulk_knowledge_import_jobs(tenant_id, persona_id, created_at DESC)"
    ]
  },
  {
    "version": "v064",
    "description": "P1-B job 元数据：模板联动统计",
    "sql": [
      "ALTER TABLE bulk_knowledge_import_jobs ADD COLUMN IF NOT EXISTS metadata_json TEXT NOT NULL DEFAULT '{}'"
    ]
  },
  {
    "version": "v065",
    "description": "P1-C 对话接入层：conversation_messages + conversation_confirmation_tokens",
    "sql": [
      "CREATE TABLE IF NOT EXISTS conversation_messages (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      session_id TEXT NOT NULL,\n      message_id TEXT NOT NULL,\n      external_user_id TEXT NOT NULL,\n      user_input TEXT NOT NULL,\n      assistant_output TEXT NOT NULL,\n      memories_used_json TEXT NOT NULL DEFAULT '[]',\n      should_escalate INTEGER NOT NULL DEFAULT 0,\n      confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0.5,\n      confidence_factors_json TEXT NOT NULL DEFAULT '[]',\n      guard_action TEXT,\n      guard_reason TEXT,\n      duration_ms INTEGER NOT NULL DEFAULT 0,\n      prompt_tokens INTEGER NOT NULL DEFAULT 0,\n      completion_tokens INTEGER NOT NULL DEFAULT 0,\n      encryption_key_ref TEXT,\n      input_redacted_pii_count INTEGER NOT NULL DEFAULT 0,\n      output_redacted_pii_count INTEGER NOT NULL DEFAULT 0,\n      retention_class TEXT NOT NULL DEFAULT 'standard' CHECK(retention_class IN ('standard', 'extended', 'litigation_hold')),\n      created_at BIGINT NOT NULL,\n      UNIQUE(tenant_id, persona_id, session_id, message_id)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_conv_msg_session ON conversation_messages(tenant_id, persona_id, session_id, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_conv_msg_user ON conversation_messages(tenant_id, external_user_id, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_conv_msg_retention ON conversation_messages(tenant_id, retention_class, created_at)",
      "CREATE TABLE IF NOT EXISTS conversation_confirmation_tokens (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      session_id TEXT NOT NULL,\n      external_user_id TEXT NOT NULL,\n      requested_topic TEXT NOT NULL,\n      requested_rule TEXT NOT NULL,\n      input_hash TEXT NOT NULL,\n      issued_at BIGINT NOT NULL,\n      expires_at BIGINT NOT NULL,\n      consumed_at BIGINT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_conv_conf_token_lookup ON conversation_confirmation_tokens(tenant_id, persona_id, session_id, expires_at)",
      "CREATE INDEX IF NOT EXISTS idx_conv_conf_token_expiry ON conversation_confirmation_tokens(expires_at)"
    ]
  },
  {
    "version": "v066",
    "description": "P1-D：subscriptions 增加 trial_end / grace_period_ends_at / cancel_at_period_end / last_invoice_id",
    "sql": [
      "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_end BIGINT",
      "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_period_ends_at BIGINT",
      "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_invoice_id TEXT"
    ]
  },
  {
    "version": "v067",
    "description": "P3：tool_permissions / agency_authorizations / tool_invocations 表",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tool_permissions (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      tool_id TEXT NOT NULL,\n      scope TEXT NOT NULL,\n      constraints_json TEXT NOT NULL DEFAULT '{}',\n      granted_by TEXT NOT NULL,\n      granted_at BIGINT NOT NULL,\n      expires_at BIGINT,\n      revoked_at BIGINT,\n      revocation_reason TEXT,\n      revocation_key TEXT NOT NULL UNIQUE,\n      UNIQUE(tenant_id, persona_id, tool_id)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tool_permissions_persona\n       ON tool_permissions(tenant_id, persona_id)",
      "CREATE INDEX IF NOT EXISTS idx_tool_permissions_tenant_active\n       ON tool_permissions(tenant_id) WHERE revoked_at IS NULL",
      "CREATE TABLE IF NOT EXISTS agency_authorizations (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      principal_user_id TEXT NOT NULL,\n      scope TEXT NOT NULL,\n      scope_description TEXT NOT NULL,\n      allowed_tools_json TEXT NOT NULL DEFAULT '[]',\n      denied_tools_json TEXT NOT NULL DEFAULT '[]',\n      status TEXT NOT NULL DEFAULT 'active',\n      granted_at BIGINT NOT NULL,\n      expires_at BIGINT,\n      revoked_at BIGINT,\n      revocation_reason TEXT,\n      revocation_key TEXT NOT NULL UNIQUE\n    )",
      "CREATE INDEX IF NOT EXISTS idx_agency_authorizations_persona\n       ON agency_authorizations(tenant_id, persona_id)",
      "CREATE INDEX IF NOT EXISTS idx_agency_authorizations_principal\n       ON agency_authorizations(tenant_id, principal_user_id)",
      "CREATE INDEX IF NOT EXISTS idx_agency_authorizations_status\n       ON agency_authorizations(tenant_id, status)",
      "CREATE TABLE IF NOT EXISTS tool_invocations (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT NOT NULL,\n      tool_id TEXT NOT NULL,\n      invoker_type TEXT NOT NULL,\n      invoker_id TEXT NOT NULL,\n      status TEXT NOT NULL,\n      input_hash TEXT NOT NULL,\n      output_size_bytes INTEGER NOT NULL DEFAULT 0,\n      error_message TEXT,\n      cost_cents INTEGER NOT NULL DEFAULT 0,\n      duration_ms INTEGER NOT NULL DEFAULT 0,\n      invoked_at BIGINT NOT NULL,\n      completed_at BIGINT,\n      confirmation_token_id TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_persona_invoked\n       ON tool_invocations(tenant_id, persona_id, invoked_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_quota_window\n       ON tool_invocations(tenant_id, persona_id, tool_id, invoked_at)\n       WHERE status = 'success'"
    ]
  },
  {
    "version": "v068",
    "description": "P3 后续：user_oauth_tokens / tool_invocations.invoker_user_id / 待确认 + 留存索引",
    "sql": [
      "CREATE TABLE IF NOT EXISTS user_oauth_tokens (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      user_id TEXT NOT NULL,\n      provider TEXT NOT NULL,\n      scope TEXT NOT NULL,\n      access_token_encrypted TEXT NOT NULL,\n      refresh_token_encrypted TEXT,\n      access_expires_at BIGINT NOT NULL,\n      granted_at BIGINT NOT NULL,\n      updated_at BIGINT NOT NULL,\n      revoked_at BIGINT,\n      revocation_reason TEXT,\n      UNIQUE(tenant_id, user_id, provider, scope)\n    )",
      "CREATE INDEX IF NOT EXISTS idx_user_oauth_tokens_lookup\n       ON user_oauth_tokens(tenant_id, user_id, provider)\n       WHERE revoked_at IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_user_oauth_tokens_expiry\n       ON user_oauth_tokens(access_expires_at)\n       WHERE revoked_at IS NULL",
      "ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS invoker_user_id TEXT",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_pending\n       ON tool_invocations(tenant_id, invoker_user_id, invoked_at DESC)\n       WHERE status = 'pending_confirmation'",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_confirmation_token\n       ON tool_invocations(tenant_id, confirmation_token_id)\n       WHERE confirmation_token_id IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_tool_invocations_retention\n       ON tool_invocations(invoked_at)\n       WHERE status != 'pending_confirmation'"
    ]
  },
  {
    "version": "v069",
    "description": "P1.7.2: events_user_journey for onboarding + first-use telemetry",
    "sql": [
      "CREATE TABLE IF NOT EXISTS events_user_journey (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      user_id TEXT,\n      session_id TEXT,\n      name TEXT NOT NULL,\n      properties_json TEXT NOT NULL DEFAULT '{}',\n      client_ts BIGINT NOT NULL,\n      ingested_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_events_user_journey_tenant_ts\n       ON events_user_journey(tenant_id, ingested_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_events_user_journey_user_ts\n       ON events_user_journey(tenant_id, user_id, ingested_at DESC)\n       WHERE user_id IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_events_user_journey_retention\n       ON events_user_journey(ingested_at)"
    ]
  },
  {
    "version": "v070",
    "description": "P2.7 health dashboard: core_values_snapshot daily history",
    "sql": [
      "CREATE TABLE IF NOT EXISTS core_values_snapshot (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      persona_id TEXT,\n      values_json TEXT NOT NULL,\n      snapshot_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_core_values_snapshot_tenant_ts\n       ON core_values_snapshot(tenant_id, snapshot_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_core_values_snapshot_retention\n       ON core_values_snapshot(snapshot_at)"
    ]
  },
  {
    "version": "v071",
    "description": "pgvector stage 2: add embedding vector column + HNSW index + dims trigger",
    "sql": [
      "CREATE EXTENSION IF NOT EXISTS vector",
      "ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding vector(1536)",
      "ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding_model TEXT",
      "ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding_dims INTEGER",
      "CREATE OR REPLACE FUNCTION validate_embedding_dims() RETURNS TRIGGER AS $$\n       BEGIN\n         IF NEW.embedding IS NOT NULL AND vector_dims(NEW.embedding) <> NEW.embedding_dims THEN\n           RAISE EXCEPTION 'embedding_dims (%) does not match vector(%) length',\n             NEW.embedding_dims, vector_dims(NEW.embedding);\n         END IF;\n         RETURN NEW;\n       END $$ LANGUAGE plpgsql",
      "DROP TRIGGER IF EXISTS memory_embeddings_dims_check ON memory_embeddings",
      "CREATE TRIGGER memory_embeddings_dims_check\n       BEFORE INSERT OR UPDATE ON memory_embeddings\n       FOR EACH ROW EXECUTE FUNCTION validate_embedding_dims()",
      "CREATE INDEX IF NOT EXISTS memory_embeddings_vec_cos_idx\n       ON memory_embeddings\n       USING hnsw (embedding vector_cosine_ops)\n       WITH (m = 16, ef_construction = 64)",
      "CREATE INDEX IF NOT EXISTS memory_embeddings_tenant_model_idx\n       ON memory_embeddings (tenant_id, embedding_model)"
    ]
  },
  {
    "version": "v073",
    "description": "EP-3.5 devices.is_invalid_at column for push token invalidation",
    "sql": [
      "ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_invalid_at BIGINT",
      "CREATE INDEX IF NOT EXISTS idx_devices_invalid ON devices(is_invalid_at) WHERE is_invalid_at IS NOT NULL"
    ]
  },
  {
    "version": "v074",
    "description": "W2.1: agent-governance onboarding (org/agent/policy/synthetic/audit)",
    "sql": [
      "ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS user_id TEXT",
      "ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS organization_id TEXT",
      "ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS agent_id TEXT",
      "ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS completed_at BIGINT",
      "CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_user ON onboarding_sessions(tenant_id, user_id) WHERE user_id IS NOT NULL",
      "CREATE TABLE IF NOT EXISTS onboarding_synthetic_invocations (\n      invocation_id TEXT PRIMARY KEY REFERENCES tool_invocations(id) ON DELETE CASCADE,\n      session_id TEXT NOT NULL,\n      created_at BIGINT NOT NULL\n    )",
      "CREATE INDEX IF NOT EXISTS idx_onboarding_synthetic_session ON onboarding_synthetic_invocations(session_id)",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at BIGINT"
    ]
  },
  {
    "version": "v075",
    "description": "P0-E: append-only hash chain on audit_log",
    "sql": [
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS chain_seq BIGINT",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT",
      "ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS record_hash TEXT",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_chain_unique ON audit_log(tenant_id, chain_seq) WHERE chain_seq IS NOT NULL"
    ]
  },
  {
    "version": "v076",
    "description": "P1-F-basic: SOC2 evidence collection table",
    "sql": [
      "CREATE TABLE IF NOT EXISTS compliance_evidence (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      control_id TEXT NOT NULL,\n      evidence_type TEXT NOT NULL,\n      collector TEXT NOT NULL DEFAULT 'system',\n      payload_json TEXT NOT NULL,\n      payload_sha256 TEXT NOT NULL,\n      collected_at BIGINT NOT NULL,\n      period_start BIGINT,\n      period_end BIGINT,\n      metadata_json TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_compliance_evidence_lookup ON compliance_evidence(tenant_id, control_id, collected_at)",
      "CREATE INDEX IF NOT EXISTS idx_compliance_evidence_period ON compliance_evidence(tenant_id, period_start, period_end)"
    ]
  },
  {
    "version": "v077",
    "description": "P1-N: legal holds registry",
    "sql": [
      "CREATE TABLE IF NOT EXISTS legal_holds (\n      id TEXT PRIMARY KEY,\n      tenant_id TEXT NOT NULL,\n      subject TEXT NOT NULL CHECK(subject IN ('tenant','user','persona')),\n      subject_id TEXT,\n      reason TEXT NOT NULL,\n      created_by TEXT NOT NULL,\n      created_at BIGINT NOT NULL,\n      released_at BIGINT,\n      released_by TEXT\n    )",
      "CREATE INDEX IF NOT EXISTS idx_legal_holds_active ON legal_holds(tenant_id, subject, subject_id) WHERE released_at IS NULL"
    ]
  },
  {
    "version": "v078",
    "description": "P1-M v2: durable break-glass JTI consumption ledger",
    "sql": [
      "CREATE TABLE IF NOT EXISTS break_glass_jti_consumptions (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL,\n    jti TEXT NOT NULL,\n    token_scope TEXT NOT NULL,\n    consumed_at TEXT NOT NULL,\n    consumed_by TEXT,\n    request_ip TEXT,\n    audit_seq BIGINT\n  )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_break_glass_jti_unique ON break_glass_jti_consumptions (tenant_id, jti)",
      "CREATE INDEX IF NOT EXISTS idx_break_glass_jti_consumed_at ON break_glass_jti_consumptions (consumed_at)"
    ]
  },
  {
    "version": "v079",
    "description": "P0-E v2: KMS-signed audit chain tail anchors",
    "sql": [
      "CREATE TABLE IF NOT EXISTS audit_chain_anchors (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL,\n    from_seq BIGINT NOT NULL,\n    to_seq BIGINT NOT NULL,\n    tail_hash TEXT NOT NULL,\n    signature TEXT NOT NULL,\n    key_id TEXT NOT NULL,\n    alg TEXT NOT NULL,\n    signed_at TEXT NOT NULL\n  )",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_chain_anchors_unique_tail ON audit_chain_anchors (tenant_id, to_seq, tail_hash)",
      "CREATE INDEX IF NOT EXISTS idx_audit_chain_anchors_latest ON audit_chain_anchors (tenant_id, to_seq)"
    ]
  },
  {
    "version": "v080",
    "description": "P0-D #2: durable jwt_signing_keys with KeyRing state machine",
    "sql": [
      "CREATE TABLE IF NOT EXISTS jwt_signing_keys (\n    kid TEXT PRIMARY KEY,\n    state TEXT NOT NULL CHECK(state IN ('active','grace','retired','compromised')),\n    algorithm TEXT NOT NULL,\n    private_key TEXT NOT NULL DEFAULT '',\n    public_key TEXT NOT NULL DEFAULT '',\n    secret TEXT NOT NULL DEFAULT '',\n    created_at TEXT NOT NULL,\n    state_changed_at TEXT NOT NULL,\n    retired_at TEXT\n  )",
      "CREATE INDEX IF NOT EXISTS idx_jwt_signing_keys_state ON jwt_signing_keys (state)"
    ]
  },
  {
    "version": "v081",
    "description": "GA §8 #1: persist KMS anchor failures as evidence rows",
    "sql": [
      "CREATE TABLE IF NOT EXISTS audit_chain_anchor_failures (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL,\n    from_seq BIGINT NOT NULL,\n    to_seq BIGINT NOT NULL,\n    tail_hash TEXT NOT NULL,\n    error_code TEXT NOT NULL,\n    error_message TEXT NOT NULL,\n    attempted_at TEXT NOT NULL,\n    recovered_at TEXT\n  )",
      "CREATE INDEX IF NOT EXISTS idx_audit_chain_anchor_failures_open ON audit_chain_anchor_failures (tenant_id, recovered_at)",
      "CREATE INDEX IF NOT EXISTS idx_audit_chain_anchor_failures_attempted ON audit_chain_anchor_failures (attempted_at)"
    ]
  },
  {
    "version": "v082",
    "description": "ADR-0047: persist distillation artifacts (gated LLM→core pipeline)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS distilled_artifacts (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    persona_id TEXT NOT NULL,\n    kind TEXT NOT NULL CHECK(kind IN ('rule', 'value_shift', 'memory_edge', 'decision_style_patch', 'cognitive_model_patch', 'response_template', 'narrative_patch')),\n    source TEXT NOT NULL CHECK(source IN ('reflection', 'conversation', 'knowledge_import', 'onboarding')),\n    payload TEXT NOT NULL,\n    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,\n    evidence TEXT NOT NULL DEFAULT '[]',\n    status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'approved', 'compiled', 'rejected', 'rolled_back')),\n    reason TEXT,\n    created_at BIGINT NOT NULL,\n    compiled_at BIGINT\n  )",
      "CREATE INDEX IF NOT EXISTS idx_distilled_artifacts_persona ON distilled_artifacts (tenant_id, persona_id)",
      "CREATE INDEX IF NOT EXISTS idx_distilled_artifacts_status ON distilled_artifacts (tenant_id, persona_id, status)"
    ]
  },
  {
    "version": "v083",
    "description": "ADR-0047/0048: per-persona concurrency lease (earning cycle + compile mutex)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_leases (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    persona_id TEXT NOT NULL,\n    purpose TEXT NOT NULL CHECK(purpose IN ('earning', 'compile')),\n    holder_token TEXT NOT NULL,\n    acquired_at BIGINT NOT NULL,\n    expires_at BIGINT NOT NULL,\n    PRIMARY KEY (tenant_id, persona_id, purpose)\n  )",
      "CREATE INDEX IF NOT EXISTS idx_persona_leases_expires ON persona_leases (expires_at)"
    ]
  },
  {
    "version": "v084",
    "description": "ADR-0047: durable versioned response_templates (replaces decaying procedural memory)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS response_templates (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    persona_id TEXT NOT NULL,\n    intent TEXT NOT NULL,\n    template TEXT NOT NULL,\n    version INTEGER NOT NULL DEFAULT 1,\n    artifact_id TEXT,\n    created_at BIGINT NOT NULL,\n    updated_at BIGINT NOT NULL,\n    PRIMARY KEY (tenant_id, persona_id, intent, version)\n  )",
      "CREATE INDEX IF NOT EXISTS idx_response_templates_intent ON response_templates (tenant_id, persona_id, intent, version)"
    ]
  },
  {
    "version": "v085",
    "description": "ADR-0047: durable versioned persona rules for rule-engine adjustments",
    "sql": [
      "CREATE TABLE IF NOT EXISTS persona_rules (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    persona_id TEXT NOT NULL,\n    rule_id TEXT NOT NULL,\n    condition TEXT NOT NULL,\n    action TEXT NOT NULL,\n    weight DOUBLE PRECISION NOT NULL,\n    description TEXT,\n    artifact_id TEXT,\n    version INTEGER NOT NULL DEFAULT 1,\n    created_at BIGINT NOT NULL,\n    updated_at BIGINT NOT NULL,\n    PRIMARY KEY (tenant_id, persona_id, rule_id, version),\n    CHECK(action IN ('prefer', 'avoid')),\n    CHECK(weight >= 0 AND weight <= 1)\n  )",
      "CREATE INDEX IF NOT EXISTS idx_persona_rules_rule ON persona_rules (tenant_id, persona_id, rule_id, version)"
    ]
  },
  {
    "version": "v086",
    "description": "BYOK: encrypted per-tenant LLM provider API keys (llm_provider_credentials)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS llm_provider_credentials (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    provider TEXT NOT NULL,\n    api_key_encrypted TEXT NOT NULL,\n    created_by TEXT,\n    created_at BIGINT NOT NULL,\n    updated_at BIGINT NOT NULL,\n    PRIMARY KEY (tenant_id, provider)\n  )"
    ]
  },
  {
    "version": "v087",
    "description": "BYOK: per-tenant active LLM provider preference (tenant_llm_settings)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS tenant_llm_settings (\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    active_provider TEXT NOT NULL,\n    model TEXT,\n    embedding_model TEXT,\n    base_url TEXT,\n    updated_by TEXT,\n    created_at BIGINT NOT NULL,\n    updated_at BIGINT NOT NULL,\n    PRIMARY KEY (tenant_id)\n  )"
    ]
  },
  {
    "version": "v088",
    "description": "ADR-0052 Edge-P5: perception media reference metadata (raw media stays in object storage)",
    "sql": [
      "CREATE TABLE IF NOT EXISTS perception_media_refs (\n    id TEXT PRIMARY KEY,\n    tenant_id TEXT NOT NULL DEFAULT 'default',\n    object_key TEXT NOT NULL,\n    sha256 TEXT NOT NULL,\n    mime TEXT NOT NULL,\n    size_bytes BIGINT NOT NULL DEFAULT 0,\n    duration_ms BIGINT NOT NULL DEFAULT 0,\n    retention_class TEXT NOT NULL DEFAULT 'process-and-delete',\n    delete_after BIGINT,\n    status TEXT NOT NULL DEFAULT 'pending',\n    created_at BIGINT NOT NULL\n  )",
      "CREATE INDEX IF NOT EXISTS idx_perception_media_refs_tenant ON perception_media_refs (tenant_id)",
      "CREATE INDEX IF NOT EXISTS idx_perception_media_refs_expiry ON perception_media_refs (delete_after)"
    ]
  }
] as const satisfies readonly LegacySqlMigration[];
