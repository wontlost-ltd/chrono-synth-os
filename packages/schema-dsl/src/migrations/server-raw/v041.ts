import { defineRaw, rawSql } from '../../dsl/raw.js';

export const v041_runtime_sessions_rebuild: ReturnType<typeof defineRaw> = defineRaw({
  id: 'runtime-sessions-rebuild',
  version: 'v041',
  aliases: { postgres: 'v041', 'sqlite-sql': 'v041' },
  description: 'runtime_sessions 可靠性迁移',
  reason: 'SQLite 重建 CHECK/UPDATE；PG 原地 ALTER/UPDATE',
  postgres: rawSql([
    `ALTER TABLE runtime_sessions ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runtime_sessions ADD COLUMN IF NOT EXISTS timeout_at BIGINT`,
    `UPDATE runtime_sessions
     SET state = 'FAILED'
     WHERE state = 'ERROR'`,
    `ALTER TABLE runtime_sessions DROP CONSTRAINT IF EXISTS runtime_sessions_state_check`,
    `ALTER TABLE runtime_sessions
     ADD CONSTRAINT runtime_sessions_state_check
     CHECK (state IN ('PLAN','EXECUTE','EVALUATE','MEMORY_UPDATE','REPUTATION_UPDATE','COMPLETED','FAILED','TIMEOUT','ERROR'))`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_timeout ON runtime_sessions(tenant_id, state, timeout_at)`,
  ]),
  sqlite: rawSql([
    `ALTER TABLE runtime_sessions RENAME TO runtime_sessions_legacy_v041`,
    `CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES persona_core(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES marketplace_tasks(id) ON DELETE CASCADE,
      assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK(state IN ('PLAN','EXECUTE','EVALUATE','MEMORY_UPDATE','REPUTATION_UPDATE','COMPLETED','FAILED','TIMEOUT','ERROR')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      timeout_at INTEGER,
      plan_json TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      evaluation_json TEXT,
      result_summary_json TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
    `INSERT INTO runtime_sessions (
      id, tenant_id, persona_id, task_id, assignment_id, state, retry_count, timeout_at,
      plan_json, artifacts_json, evaluation_json, result_summary_json, error_json,
      created_at, updated_at, completed_at
    )
    SELECT
      id,
      tenant_id,
      persona_id,
      task_id,
      assignment_id,
      CASE WHEN state = 'ERROR' THEN 'FAILED' ELSE state END,
      0,
      NULL,
      plan_json,
      artifacts_json,
      evaluation_json,
      result_summary_json,
      error_json,
      created_at,
      updated_at,
      completed_at
    FROM runtime_sessions_legacy_v041`,
    `DROP TABLE runtime_sessions_legacy_v041`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task ON runtime_sessions(tenant_id, task_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_persona ON runtime_sessions(tenant_id, persona_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_assignment ON runtime_sessions(tenant_id, assignment_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_timeout ON runtime_sessions(tenant_id, state, timeout_at)`,
  ]),
});
