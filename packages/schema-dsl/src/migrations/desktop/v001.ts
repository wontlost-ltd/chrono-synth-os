import { defineRaw, rawSql } from '../../dsl/raw.js';

export const desktop_v001: ReturnType<typeof defineRaw> = defineRaw({
  id: 'desktop-personas-and-sync',
  version: 'v001',
  aliases: { 'sqlite-rust': 'v001' },
  description: 'personas + sync_state + offline_queue',
  target: 'desktop-only',
  reason: 'Desktop migration is kept byte-stable against the existing Rust execute_batch SQL',
  sqliteRust: rawSql([
    `
        CREATE TABLE IF NOT EXISTS personas (
            persona_id   TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'active',
            visibility   TEXT NOT NULL DEFAULT 'private',
            growth_index REAL NOT NULL DEFAULT 0,
            reputation   REAL NOT NULL DEFAULT 0,
            wallet_id    TEXT,
            wallet_balance REAL,
            updated_at   TEXT NOT NULL,
            synced_at    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sync_state (
            id                  TEXT PRIMARY KEY DEFAULT 'singleton',
            state               TEXT NOT NULL DEFAULT 'initial_sync',
            network_online      INTEGER NOT NULL DEFAULT 1,
            auth_valid          INTEGER NOT NULL DEFAULT 1,
            remote_reachable    INTEGER NOT NULL DEFAULT 1,
            pending_push_count  INTEGER NOT NULL DEFAULT 0,
            conflict_count      INTEGER NOT NULL DEFAULT 0,
            last_sync_at        INTEGER,
            last_error          TEXT,
            updated_at          INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
        );

        CREATE TABLE IF NOT EXISTS offline_queue (
            id          TEXT PRIMARY KEY,
            operation   TEXT NOT NULL,
            payload     TEXT NOT NULL,
            created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
            retry_count INTEGER NOT NULL DEFAULT 0
        );

        INSERT OR IGNORE INTO sync_state (id) VALUES ('singleton');
        `,
  ]),
});
