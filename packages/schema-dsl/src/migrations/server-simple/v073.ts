import { defineMigration, type Migration } from '../../index.js';

/**
 * P0-E: audit_log hash chain columns + index.
 *
 * Adds per-tenant append-only hash chain to audit_log:
 * - chain_seq   monotonic per tenant, starting at 1
 * - prev_hash   SHA256 of the previous record (genesis = 64 zero hex chars)
 * - record_hash SHA256 of the canonical serialisation of the current record
 *
 * Columns are nullable so rows recorded before this rollout survive intact;
 * the verifier ignores rows where chain_seq IS NULL.
 *
 * PG side lands on v075 — v074 is taken by onboarding-v2.
 */
export const v073_audit_hash_chain: Migration = defineMigration({
  kind: 'schema',
  id: '073-audit-hash-chain',
  aliases: { postgres: 'v075', 'sqlite-sql': 'v073' },
  description: 'P0-E: append-only hash chain on audit_log',
  operations: [
    {
      kind: 'add-column',
      table: 'audit_log',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'chain_seq', type: 'bigint' },
    },
    {
      kind: 'add-column',
      table: 'audit_log',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'prev_hash', type: 'text' },
    },
    {
      kind: 'add-column',
      table: 'audit_log',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'record_hash', type: 'text' },
    },
    /* Note: idx_audit_log_chain is not created here because some legacy
     * fixtures skip the v002 audit_log table creation. The runtime
     * ensureAuditLogColumns() call (jwt-auth.ts boot path) creates it
     * idempotently on real deployments. */
  ],
});
