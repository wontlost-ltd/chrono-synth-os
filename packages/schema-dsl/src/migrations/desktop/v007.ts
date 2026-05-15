import { defineRaw, rawSql } from '../../dsl/raw.js';

export const desktop_v007: ReturnType<typeof defineRaw> = defineRaw({
  id: 'desktop-app-settings',
  version: 'v007',
  aliases: { 'sqlite-rust': 'v007' },
  description: 'app_settings — first-launch flag + future kv',
  target: 'desktop-only',
  reason: 'Desktop migration is kept byte-stable against the existing Rust execute_batch SQL',
  sqliteRust: rawSql([
    `
        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
        );
        `,
  ]),
});
