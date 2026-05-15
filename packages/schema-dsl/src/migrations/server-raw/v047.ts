import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v047_identity_avatar_rebuild: ReturnType<typeof defineRaw> = defineRaw({
  id: 'identity-avatar-rebuild',
  version: 'v047',
  aliases: { postgres: 'v047', 'sqlite-sql': 'v047' },
  description: 'identity/avatar 多表重建',
  reason: 'SQLite 多表重建；PG 使用约束与索引变更',
  postgres: rawSql([
    `ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_tenant_id_key`,
    `DROP INDEX IF EXISTS idx_identities_tenant_user`,
    `CREATE INDEX IF NOT EXISTS idx_identities_tenant_user ON identities(tenant_id, user_id)`,
  ]),
  sqlite: rawSql([
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
    `DROP TABLE IF EXISTS avatar_autorun_runlog`,
    `DROP TABLE IF EXISTS avatar_autorun_config`,
    `DROP TABLE IF EXISTS device_avatars`,
    `DROP TABLE IF EXISTS avatars`,
    `DROP TABLE IF EXISTS identities`,
    `ALTER TABLE identities_new RENAME TO identities`,
    `ALTER TABLE avatars_new RENAME TO avatars`,
    `ALTER TABLE device_avatars_new RENAME TO device_avatars`,
    `ALTER TABLE avatar_autorun_config_new RENAME TO avatar_autorun_config`,
    `ALTER TABLE avatar_autorun_runlog_new RENAME TO avatar_autorun_runlog`,
    `CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_identities_tenant_user ON identities(tenant_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_avatars_identity ON avatars(identity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_device_avatars_device ON device_avatars(device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_device_avatars_avatar ON device_avatars(avatar_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_autorun_config_avatar ON avatar_autorun_config(tenant_id, avatar_id)`,
    `CREATE INDEX IF NOT EXISTS idx_autorun_config_due ON avatar_autorun_config(tenant_id, enabled, next_run_at)`,
    `CREATE INDEX IF NOT EXISTS idx_autorun_config_next_run ON avatar_autorun_config(enabled, next_run_at)`,
    `CREATE INDEX IF NOT EXISTS idx_autorun_runlog_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_autorun_runlog_tenant_avatar ON avatar_autorun_runlog(tenant_id, avatar_id, created_at DESC)`,
  ]),
});
