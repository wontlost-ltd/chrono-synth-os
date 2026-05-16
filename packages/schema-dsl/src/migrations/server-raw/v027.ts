import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v027_identities_avatars_backfill: ReturnType<typeof defineRaw> = defineRaw({
  id: 'identities-avatars-backfill',
  version: 'v027',
  aliases: { postgres: 'v027', 'sqlite-sql': 'v027' },
  description: 'identities/avatars 回填 DML',
  reason: '身份与分身系统包含 DML 回填，按旧 SQL 原样执行',
  postgres: rawSql([
    `CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenant_id)`,
    `CREATE TABLE IF NOT EXISTS avatars (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES identities(id),
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'general'
        CHECK(kind IN ('general','work','social','family','creative')),
      behavior_overrides TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_avatars_identity ON avatars(identity_id)`,
    `CREATE TABLE IF NOT EXISTS device_avatars (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      is_active INTEGER NOT NULL DEFAULT 0,
      installed_at BIGINT NOT NULL,
      UNIQUE(device_id, avatar_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_device_avatars_device ON device_avatars(device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_device_avatars_avatar ON device_avatars(avatar_id)`,
    `INSERT INTO identities (id, user_id, tenant_id, display_name, created_at, updated_at)
     SELECT 'ident_' || REPLACE(id, 'user_', ''), id, tenant_id, email, created_at, updated_at
     FROM users
     ON CONFLICT DO NOTHING`,
    `INSERT INTO avatars (id, identity_id, label, kind, is_default, is_active, created_at, updated_at)
     SELECT 'avt_' || REPLACE(id, 'ident_', ''), id, '默认', 'general', 1, 1, created_at, updated_at
     FROM identities
     ON CONFLICT DO NOTHING`,
  ]),
  sqlite: rawSql([
    `CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      bio TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_identities_tenant ON identities(tenant_id)`,
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
    `CREATE INDEX IF NOT EXISTS idx_avatars_identity ON avatars(identity_id)`,
    `CREATE TABLE IF NOT EXISTS device_avatars (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      avatar_id TEXT NOT NULL REFERENCES avatars(id),
      is_active INTEGER NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL,
      UNIQUE(device_id, avatar_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_device_avatars_device ON device_avatars(device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_device_avatars_avatar ON device_avatars(avatar_id)`,
    `INSERT OR IGNORE INTO identities (id, user_id, tenant_id, display_name, created_at, updated_at)
     SELECT 'ident_' || REPLACE(id, 'user_', ''), id, tenant_id, email, created_at, updated_at
     FROM users`,
    `INSERT OR IGNORE INTO avatars (id, identity_id, label, kind, is_default, is_active, created_at, updated_at)
     SELECT 'avt_' || REPLACE(id, 'ident_', ''), id, '默认', 'general', 1, 1, created_at, updated_at
     FROM identities`,
  ]),
});
