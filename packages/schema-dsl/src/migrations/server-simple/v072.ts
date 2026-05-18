import { defineMigration, type Migration } from '../../index.js';

/**
 * W2.1 agent-governance onboarding flow schema extensions.
 *
 * The old persona-simulator onboarding (welcome/template/values/simulation/done)
 * is deprecated but its rows aren't dropped. The new flow (org/agent/policy/
 * synthetic-invocation/audit-log) reuses the same `onboarding_sessions` table
 * with three new columns and adds two supporting structures. PRD:
 * `.claude/gtm/03-onboarding-prd.md`.
 *
 * Version alias skew: PG side lands on v074 because v072 (pgvector legacy drop,
 * disabled) and v073 (push token invalidation) were already taken. SQLite never
 * had those ramps, so its onboarding-v2 lands at v072 directly.
 */
export const v072_migration: Migration = defineMigration({
  kind: 'schema',
  id: '072-onboarding-v2',
  aliases: { postgres: 'v074', 'sqlite-sql': 'v072' },
  description: 'W2.1: agent-governance onboarding (org/agent/policy/synthetic/audit)',
  operations: [
    // The PRD's "user_id" link lets the wizard resume across logins.
    // The existing session lookup was tenant-scoped only, so two users
    // inside one tenant would collide. user_id discriminates.
    {
      kind: 'add-column',
      table: 'onboarding_sessions',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'user_id', type: 'text' },
    },
    {
      kind: 'add-column',
      table: 'onboarding_sessions',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'organization_id', type: 'text' },
    },
    {
      kind: 'add-column',
      table: 'onboarding_sessions',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'agent_id', type: 'text' },
    },
    {
      kind: 'add-column',
      table: 'onboarding_sessions',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'completed_at', type: 'bigint' },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_onboarding_sessions_user',
        table: 'onboarding_sessions',
        columns: ['tenant_id', 'user_id'],
        unique: false,
        ifNotExists: true,
        where: 'user_id IS NOT NULL',
      },
    },
    // Synthetic invocation marker. The audit log can't distinguish step-4
    // generated rows from real agent calls otherwise; an admin filter UI may
    // want to hide them in dashboards once the customer has real traffic.
    // ON DELETE CASCADE keeps the table in sync if a tool_invocation is ever
    // physically deleted (rare — most flows tombstone).
    {
      kind: 'create-table',
      table: {
        name: 'onboarding_synthetic_invocations',
        ifNotExists: true,
        columns: [
          {
            name: 'invocation_id',
            type: 'text',
            primaryKey: true,
            references: { table: 'tool_invocations', column: 'id', onDelete: 'CASCADE' },
          },
          { name: 'session_id', type: 'text', nullable: false },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_onboarding_synthetic_session',
        table: 'onboarding_synthetic_invocations',
        columns: ['session_id'],
        unique: false,
        ifNotExists: true,
      },
    },
    // users.onboarded_at: app shell uses this to skip the wizard on subsequent
    // logins. NULL = wizard pending; non-NULL = either completed or explicitly
    // skipped.
    {
      kind: 'add-column',
      table: 'users',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'onboarded_at', type: 'bigint' },
    },
  ],
});
