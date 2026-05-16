import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v030_check_rewrite: ReturnType<typeof defineRaw> = defineRaw({
  id: 'knowledge-source-check-rewrite',
  version: 'v030',
  aliases: { postgres: 'v030', 'sqlite-sql': 'v030' },
  description: '知识源 CHECK 约束改写',
  reason: 'SQLite 重建表更新 CHECK；PG drop/add CHECK 约束',
  postgres: rawSql([
    `ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_type_check`,
    `ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_type_check CHECK(type IN ('rss','api','file','manual','llm'))`,
  ]),
  sqlite: rawSql([
    `CREATE TABLE IF NOT EXISTS knowledge_sources_new (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('rss','api','file','manual','llm')),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL,
      state_json TEXT,
      last_ingested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT OR IGNORE INTO knowledge_sources_new
     SELECT id, tenant_id, type, name, enabled, config_json, state_json, last_ingested_at, created_at, updated_at
     FROM knowledge_sources`,
    `DROP TABLE IF EXISTS knowledge_sources`,
    `ALTER TABLE knowledge_sources_new RENAME TO knowledge_sources`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources(tenant_id, enabled, type)`,
  ]),
});
