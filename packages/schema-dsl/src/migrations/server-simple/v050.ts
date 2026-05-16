import { defineMigration, type Migration } from '../../index.js';

export const v050_migration: Migration = defineMigration({
  kind: 'schema',
  id: '050',
  aliases: { postgres: 'v050', 'sqlite-sql': 'v050' },
  description: "KMS 密钥操作审计日志",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "kms_key_audit",
      ifNotExists: true,
      columns: [
        {
          name: "event_id",
          type: "text",
          primaryKey: true
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "operation",
          type: "text",
          nullable: false
        },
        {
          name: "provider",
          type: "text",
          nullable: false
        },
        {
          name: "key_ref",
          type: "text",
          nullable: false
        },
        {
          name: "performed_at",
          type: "text",
          nullable: false
        },
        {
          name: "success",
          type: "integer",
          nullable: false,
          default: 1
        },
        {
          name: "error_code",
          type: "text"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_kms_key_audit_tenant",
      table: "kms_key_audit",
      columns: [
        "tenant_id",
        "performed_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
