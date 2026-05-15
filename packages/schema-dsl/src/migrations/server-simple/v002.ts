import { defineMigration, type Migration } from '../../index.js';

export const v002_audit_log: Migration = defineMigration({
  kind: 'schema',
  id: 'audit-log',
  aliases: { postgres: 'v002', 'sqlite-sql': 'v002' },
  description: '审计日志表',
  operations: [
    { kind: 'create-table', table: { name: 'audit_log', ifNotExists: true, columns: [
      { name: 'id', type: 'text', primaryKey: true },
      { name: 'timestamp', type: 'bigint', nullable: false },
      { name: 'method', type: 'text', nullable: false },
      { name: 'path', type: 'text', nullable: false },
      { name: 'request_id', type: 'text', nullable: false },
      { name: 'status_code', type: 'integer', nullable: false },
      { name: 'latency_ms', type: 'real', nullable: false },
    ] } },
    { kind: 'create-index', index: { name: 'idx_audit_log_timestamp', table: 'audit_log', columns: ['timestamp'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_audit_log_path', table: 'audit_log', columns: ['path'], ifNotExists: true } },
  ],
});
