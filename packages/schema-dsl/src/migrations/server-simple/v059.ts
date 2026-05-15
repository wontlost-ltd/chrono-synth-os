import { defineMigration, type Migration } from '../../index.js';

export const v059_migration: Migration = defineMigration({
  kind: 'schema',
  id: '059',
  aliases: { postgres: 'v059', 'sqlite-sql': 'v059' },
  description: "租户 BYOK/BYOS 密钥版本、密钥操作审计与存储绑定",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "tenant_key_versions",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "key_ref",
          type: "text",
          nullable: false
        },
        {
          name: "provider",
          type: "text",
          nullable: false
        },
        {
          name: "version",
          type: "integer",
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          default: "active"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "revoked_at",
          type: "bigint"
        }
      ],
      constraints: [
        {
          kind: "unique",
          columns: [
            "tenant_id",
            "key_ref",
            "provider",
            "version"
          ]
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tenant_key_versions_tenant_key",
      table: "tenant_key_versions",
      columns: [
        "tenant_id",
        "key_ref",
        "provider",
        "version DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "tenant_vault_audit",
      ifNotExists: true,
      columns: [
        {
          name: "id",
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
          name: "key_ref",
          type: "text",
          nullable: false
        },
        {
          name: "key_version",
          type: "integer"
        },
        {
          name: "outcome",
          type: "text",
          nullable: false
        },
        {
          name: "error_message",
          type: "text"
        },
        {
          name: "performed_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tenant_vault_audit_tenant_time",
      table: "tenant_vault_audit",
      columns: [
        "tenant_id",
        "performed_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "tenant_storage_bindings",
      ifNotExists: true,
      columns: [
        {
          name: "tenant_id",
          type: "text",
          primaryKey: true
        },
        {
          name: "provider",
          type: "text",
          nullable: false
        },
        {
          name: "bucket_or_path",
          type: "text",
          nullable: false
        },
        {
          name: "region",
          type: "text"
        },
        {
          name: "encryption_key_ref",
          type: "text"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  }
],
});
