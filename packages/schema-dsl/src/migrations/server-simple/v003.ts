import { defineMigration, type Migration } from '../../index.js';

export const v003_audit_api_key: Migration = defineMigration({
  kind: 'schema',
  id: 'audit-api-key',
  aliases: { postgres: 'v003', 'sqlite-sql': 'v003' },
  description: '审计日志增加 API Key 哈希字段',
  operations: [
    { kind: 'add-column', table: 'audit_log', ifNotExists: true, safeIfTableExists: true, column: { name: 'api_key_hash', type: 'text' } },
  ],
});
