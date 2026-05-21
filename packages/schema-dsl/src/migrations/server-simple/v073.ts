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
    /* Partial UNIQUE index on (tenant_id, chain_seq) enforces no-duplicate
     * sequence numbers per tenant — the only DB-level safeguard against
     * the read-tail-then-insert race under concurrent writers. WHERE
     * chain_seq IS NOT NULL leaves legacy rows alone. The runner tags
     * this op with safe:if-table-exists in case the legacy bootstrap
     * fixture skipped v002. */
    {
      kind: 'create-index',
      index: {
        name: 'idx_audit_log_chain_unique',
        table: 'audit_log',
        columns: ['tenant_id', 'chain_seq'],
        unique: true,
        ifNotExists: true,
        where: 'chain_seq IS NOT NULL',
      },
    },
  ],
});
