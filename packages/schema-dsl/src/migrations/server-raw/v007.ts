import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v007_tenant_id: ReturnType<typeof defineRaw> = defineRaw({
  id: 'tenant-id-multitenancy',
  version: 'v007',
  aliases: { postgres: 'v007', 'sqlite-sql': 'v007' },
  description: '多租户隔离',
  reason: 'SQLite 用 RENAME + INSERT OR IGNORE 重建单例表；PG 走原地 ALTER',
  postgres: rawSql([
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
    `ALTER TABLE narrative DROP CONSTRAINT IF EXISTS narrative_pkey`,
    `ALTER TABLE narrative DROP COLUMN IF EXISTS id`,
    `ALTER TABLE narrative ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE narrative ADD PRIMARY KEY (tenant_id)`,
    `ALTER TABLE decision_style DROP CONSTRAINT IF EXISTS decision_style_pkey`,
    `ALTER TABLE decision_style DROP COLUMN IF EXISTS id`,
    `ALTER TABLE decision_style ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE decision_style ADD PRIMARY KEY (tenant_id)`,
    `ALTER TABLE cognitive_model DROP CONSTRAINT IF EXISTS cognitive_model_pkey`,
    `ALTER TABLE cognitive_model DROP COLUMN IF EXISTS id`,
    `ALTER TABLE cognitive_model ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE cognitive_model ADD PRIMARY KEY (tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_core_values_tenant ON core_values(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant ON memory_nodes(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_persona_versions_tenant ON persona_versions(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_tenant ON snapshots(tenant_id)`,
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
  ]),
  sqlite: rawSql([
    `/* safe:add-column:core_values:tenant_id */ ALTER TABLE core_values ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:memory_nodes:tenant_id */ ALTER TABLE memory_nodes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:memory_edges:tenant_id */ ALTER TABLE memory_edges ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:memory_embeddings:tenant_id */ ALTER TABLE memory_embeddings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:working_memory:tenant_id */ ALTER TABLE working_memory ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:persona_versions:tenant_id */ ALTER TABLE persona_versions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:conflicts:tenant_id */ ALTER TABLE conflicts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:snapshots:tenant_id */ ALTER TABLE snapshots ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:evolution_records:tenant_id */ ALTER TABLE evolution_records ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:survival_anchors:tenant_id */ ALTER TABLE survival_anchors ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `/* safe:add-column:audit_log:tenant_id */ ALTER TABLE audit_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE narrative RENAME TO narrative_old`,
    `CREATE TABLE IF NOT EXISTS narrative (
      tenant_id TEXT PRIMARY KEY DEFAULT 'default',
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO narrative (tenant_id, content, updated_at)
     SELECT 'default', content, updated_at FROM narrative_old`,
    `DROP TABLE IF EXISTS narrative_old`,
    `ALTER TABLE decision_style RENAME TO decision_style_old`,
    `CREATE TABLE IF NOT EXISTS decision_style (
      tenant_id TEXT PRIMARY KEY DEFAULT 'default',
      style_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO decision_style (tenant_id, style_json, updated_at)
     SELECT 'default', style_json, updated_at FROM decision_style_old`,
    `DROP TABLE IF EXISTS decision_style_old`,
    `ALTER TABLE cognitive_model RENAME TO cognitive_model_old`,
    `CREATE TABLE IF NOT EXISTS cognitive_model (
      tenant_id TEXT PRIMARY KEY DEFAULT 'default',
      model_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO cognitive_model (tenant_id, model_json, updated_at)
     SELECT 'default', model_json, updated_at FROM cognitive_model_old`,
    `DROP TABLE IF EXISTS cognitive_model_old`,
    `CREATE INDEX IF NOT EXISTS idx_core_values_tenant ON core_values(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_nodes_tenant ON memory_nodes(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_persona_versions_tenant ON persona_versions(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_tenant ON snapshots(tenant_id)`,
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
  ]),
});
