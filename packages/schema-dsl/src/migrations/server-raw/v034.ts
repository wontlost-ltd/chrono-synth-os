import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v034_lifecycle_status_backfill: ReturnType<typeof defineRaw> = defineRaw({
  id: 'lifecycle-status-backfill',
  version: 'v034',
  aliases: { postgres: 'v034', 'sqlite-sql': 'v034' },
  description: 'Persona OS 生命周期状态回填',
  reason: '保留旧 SQL 的 NULL 语义差异',
  postgres: rawSql([
    `ALTER TABLE persona_core ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active'`,
    `UPDATE persona_core SET lifecycle_status = status WHERE lifecycle_status = 'active'`,
    `CREATE INDEX IF NOT EXISTS idx_persona_core_lifecycle_status ON persona_core(tenant_id, lifecycle_status, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS persona_transfers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      from_owner_user_id TEXT NOT NULL REFERENCES users(id),
      to_owner_user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('pending_review','approved','completed','rejected','cancelled')),
      reason TEXT NOT NULL DEFAULT '',
      requested_at BIGINT NOT NULL,
      approved_at BIGINT,
      completed_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_persona_transfers_persona ON persona_transfers(tenant_id, persona_id, requested_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_persona_transfers_target ON persona_transfers(tenant_id, to_owner_user_id, requested_at DESC)`,
    `CREATE TABLE IF NOT EXISTS reputation_history (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      old_score DOUBLE PRECISION NOT NULL,
      new_score DOUBLE PRECISION NOT NULL,
      reason TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reputation_history_persona ON reputation_history(tenant_id, persona_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS persona_daily_metrics (
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      metric_date TEXT NOT NULL,
      tasks_completed INTEGER NOT NULL DEFAULT 0,
      revenue DOUBLE PRECISION NOT NULL DEFAULT 0,
      reputation_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      growth_index DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, persona_id, metric_date)
    )`,
    `CREATE TABLE IF NOT EXISTS marketplace_daily_metrics (
      tenant_id TEXT NOT NULL,
      metric_date TEXT NOT NULL,
      open_tasks INTEGER NOT NULL DEFAULT 0,
      completed_tasks INTEGER NOT NULL DEFAULT 0,
      gross_volume DOUBLE PRECISION NOT NULL DEFAULT 0,
      active_personas INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, metric_date)
    )`,
  ]),
  sqlite: rawSql([
    `/* safe:add-column:persona_core:lifecycle_status */ ALTER TABLE persona_core ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'`,
    `UPDATE persona_core SET lifecycle_status = status WHERE lifecycle_status IS NULL OR lifecycle_status = 'active'`,
    `CREATE INDEX IF NOT EXISTS idx_persona_core_lifecycle_status ON persona_core(tenant_id, lifecycle_status, updated_at DESC)`,
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
    `CREATE INDEX IF NOT EXISTS idx_persona_transfers_persona ON persona_transfers(tenant_id, persona_id, requested_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_persona_transfers_target ON persona_transfers(tenant_id, to_owner_user_id, requested_at DESC)`,
    `CREATE TABLE IF NOT EXISTS reputation_history (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      old_score REAL NOT NULL,
      new_score REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reputation_history_persona ON reputation_history(tenant_id, persona_id, created_at DESC)`,
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
  ]),
});
