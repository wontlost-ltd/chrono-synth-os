import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v052_event_ledger_authority_seed: ReturnType<typeof defineRaw> = defineRaw({
  id: 'event-ledger-authority-seed',
  version: 'v052',
  aliases: { postgres: 'v052', 'sqlite-sql': 'v052' },
  description: 'event_ledger authority 单例 seed',
  reason: '包含 event_ledger_authority 单例种子数据',
  postgres: rawSql([
    `CREATE TABLE IF NOT EXISTS event_ledger (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      occurred_at BIGINT NOT NULL,
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
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS event_ledger_authority (
      singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK(singleton = 1),
      mode TEXT NOT NULL DEFAULT 'tables_primary',
      changed_at BIGINT NOT NULL,
      changed_reason TEXT NOT NULL DEFAULT ''
    )`,
    `INSERT INTO event_ledger_authority(singleton, mode, changed_at) VALUES(1, 'tables_primary', 0) ON CONFLICT (singleton) DO NOTHING`,
  ]),
  sqlite: rawSql([
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
  ]),
});
