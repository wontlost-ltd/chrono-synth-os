import { defineRaw, rawSql } from '../../dsl/raw.js';

export const desktop_v006: ReturnType<typeof defineRaw> = defineRaw({
  id: 'desktop-crdt-state',
  version: 'v006',
  aliases: { 'sqlite-rust': 'v006' },
  description: 'crdt_state — Yrs persona field merge',
  target: 'desktop-only',
  reason: 'Desktop migration is kept byte-stable against the existing Rust execute_batch SQL',
  sqliteRust: rawSql([
    `
        CREATE TABLE IF NOT EXISTS crdt_state (
            persona_id TEXT PRIMARY KEY,
            doc_state  BLOB NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
        );
        `,
  ]),
});
