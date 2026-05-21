import { defineMigration, type Migration } from '../../index.js';

/**
 * P1-N — Legal hold registry.
 *
 * A legal hold blocks any privacy-deletion action (DSAR, tenant
 * offboarding, retention sweeps) for the named scope. Created in
 * response to litigation, regulator inquiry, or subpoena.
 *
 * Schema:
 *   tenant_id    scope of the hold
 *   subject      'tenant' | 'user' | 'persona' — what's being preserved
 *   subject_id   the id of the entity (when subject != 'tenant')
 *   reason       free-form, audit-readable why
 *   created_by   actor who placed the hold
 *   created_at   ms
 *   released_at  ms (NULL while active)
 *   released_by  actor who released (NULL while active)
 *
 * Active hold = released_at IS NULL. UI surfaces this state; the
 * deletion service refuses to delete anything that overlaps.
 *
 * Alias: SQLite v075 / Postgres v077.
 */
export const v075_legal_holds: Migration = defineMigration({
  kind: 'schema',
  id: '075-legal-holds',
  aliases: { postgres: 'v077', 'sqlite-sql': 'v075' },
  description: 'P1-N: legal_holds table for litigation / regulatory hold tracking',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'legal_holds',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false },
          { name: 'subject', type: 'text', nullable: false, check: "subject IN ('tenant','user','persona')" },
          { name: 'subject_id', type: 'text' },
          { name: 'reason', type: 'text', nullable: false },
          { name: 'created_by', type: 'text', nullable: false },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'released_at', type: 'bigint' },
          { name: 'released_by', type: 'text' },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_legal_holds_active',
        table: 'legal_holds',
        columns: ['tenant_id', 'subject', 'subject_id'],
        ifNotExists: true,
        where: 'released_at IS NULL',
      },
    },
  ],
});
