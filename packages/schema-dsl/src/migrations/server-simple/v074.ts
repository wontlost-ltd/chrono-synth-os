import { defineMigration, type Migration } from '../../index.js';

/**
 * P1-F-basic: SOC2 evidence collection table.
 *
 * Stores audit-ready evidence for SOC2 Type II controls (CC1–CC9 + A1).
 * Each row is a discrete artifact: a query result, log excerpt, key
 * rotation event, backup hash, incident report, etc. The auditor (or
 * P1-F-ext exporter) reads these by control_id within a reporting
 * period and verifies the chain via payload_sha256 + KMS signature.
 *
 * - control_id     "CC6.1" / "A1.2" / "CC7.3" etc.
 * - evidence_type  application-specific kind discriminator
 * - tenant_id      per-tenant evidence (auditor may bundle by tenant)
 * - collector      'system' (automated job) | 'manual' (operator upload)
 * - payload_json   the actual evidence body, application-specific shape
 * - payload_sha256 fingerprint for tamper detection + dedup
 * - collected_at   UTC ms of the collection event
 * - period_start/end optional reporting window the evidence belongs to
 * - metadata_json  per-collector extras; reserved for v2 KMS signatures,
 *                  S3 Object Lock anchors, attestation chain refs
 *
 * Alias: SQLite v074 / Postgres v076 (v075 is P0-E hash chain).
 */
export const v074_soc2_evidence: Migration = defineMigration({
  kind: 'schema',
  id: '074-soc2-evidence',
  aliases: { postgres: 'v076', 'sqlite-sql': 'v074' },
  description: 'P1-F-basic: SOC2 evidence collection table',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'compliance_evidence',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false },
          { name: 'control_id', type: 'text', nullable: false },
          { name: 'evidence_type', type: 'text', nullable: false },
          { name: 'collector', type: 'text', nullable: false, default: 'system' },
          { name: 'payload_json', type: 'text', nullable: false },
          { name: 'payload_sha256', type: 'text', nullable: false },
          { name: 'collected_at', type: 'bigint', nullable: false },
          { name: 'period_start', type: 'bigint' },
          { name: 'period_end', type: 'bigint' },
          { name: 'metadata_json', type: 'text' },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_compliance_evidence_lookup',
        table: 'compliance_evidence',
        columns: ['tenant_id', 'control_id', 'collected_at'],
        ifNotExists: true,
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_compliance_evidence_period',
        table: 'compliance_evidence',
        columns: ['tenant_id', 'period_start', 'period_end'],
        ifNotExists: true,
      },
    },
  ],
});
