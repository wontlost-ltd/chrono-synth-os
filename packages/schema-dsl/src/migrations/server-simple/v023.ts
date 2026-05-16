import { defineMigration, type Migration } from '../../index.js';

export const v023_migration: Migration = defineMigration({
  kind: 'schema',
  id: '023',
  aliases: { postgres: 'v023', 'sqlite-sql': 'v023' },
  description: "API Key 租户绑定（支持计划感知限流）",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "api_keys",
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
          name: "key_hash",
          type: "text",
          unique: true,
          nullable: false
        },
        {
          name: "plan_id",
          type: "text",
          nullable: false,
          default: "free"
        },
        {
          name: "is_revoked",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_api_keys_hash",
      table: "api_keys",
      columns: [
        "key_hash"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_api_keys_tenant",
      table: "api_keys",
      columns: [
        "tenant_id"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
