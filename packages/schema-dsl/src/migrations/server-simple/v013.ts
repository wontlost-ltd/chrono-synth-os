import { defineMigration, type Migration } from '../../index.js';

export const v013_migration: Migration = defineMigration({
  kind: 'schema',
  id: '013',
  aliases: { postgres: 'v013', 'sqlite-sql': 'v013' },
  description: "用户认证与刷新令牌",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "users",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "email",
          type: "text",
          unique: true,
          nullable: false
        },
        {
          name: "password_hash",
          type: "text",
          nullable: false
        },
        {
          name: "role",
          type: "text",
          nullable: false,
          default: "member",
          check: "role IN ('admin', 'member', 'viewer')"
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false,
          default: "default"
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
  },
  {
    kind: "create-index",
    index: {
      name: "idx_users_email",
      table: "users",
      columns: [
        "email"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_users_tenant",
      table: "users",
      columns: [
        "tenant_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "refresh_tokens",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "user_id",
          type: "text",
          nullable: false,
          references: {
            table: "users",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "token_hash",
          type: "text",
          nullable: false
        },
        {
          name: "is_revoked",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "expires_at",
          type: "bigint",
          nullable: false
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
      name: "idx_refresh_tokens_user",
      table: "refresh_tokens",
      columns: [
        "user_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_refresh_tokens_hash",
      table: "refresh_tokens",
      columns: [
        "token_hash"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
