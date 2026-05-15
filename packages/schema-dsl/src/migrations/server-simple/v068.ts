import { defineMigration, type Migration } from '../../index.js';

export const v068_migration: Migration = defineMigration({
  kind: 'schema',
  id: '068',
  aliases: { postgres: 'v068', 'sqlite-sql': 'v068' },
  description: "P3 后续：user_oauth_tokens / tool_invocations.invoker_user_id / 待确认 + 留存索引",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "user_oauth_tokens",
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
          name: "user_id",
          type: "text",
          nullable: false
        },
        {
          name: "provider",
          type: "text",
          nullable: false
        },
        {
          name: "scope",
          type: "text",
          nullable: false
        },
        {
          name: "access_token_encrypted",
          type: "text",
          nullable: false
        },
        {
          name: "refresh_token_encrypted",
          type: "text"
        },
        {
          name: "access_expires_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "granted_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "revoked_at",
          type: "bigint"
        },
        {
          name: "revocation_reason",
          type: "text"
        }
      ],
      constraints: [
        {
          kind: "unique",
          columns: [
            "tenant_id",
            "user_id",
            "provider",
            "scope"
          ]
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_user_oauth_tokens_lookup",
      table: "user_oauth_tokens",
      columns: [
        "tenant_id",
        "user_id",
        "provider"
      ],
      unique: false,
      ifNotExists: true,
      where: "revoked_at IS NULL"
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_user_oauth_tokens_expiry",
      table: "user_oauth_tokens",
      columns: [
        "access_expires_at"
      ],
      unique: false,
      ifNotExists: true,
      where: "revoked_at IS NULL"
    }
  },
  {
    kind: "add-column",
    table: "tool_invocations",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "invoker_user_id",
      type: "text"
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tool_invocations_pending",
      table: "tool_invocations",
      columns: [
        "tenant_id",
        "invoker_user_id",
        "invoked_at DESC"
      ],
      unique: false,
      ifNotExists: true,
      where: "status = 'pending_confirmation'"
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tool_invocations_confirmation_token",
      table: "tool_invocations",
      columns: [
        "tenant_id",
        "confirmation_token_id"
      ],
      unique: false,
      ifNotExists: true,
      where: "confirmation_token_id IS NOT NULL"
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tool_invocations_retention",
      table: "tool_invocations",
      columns: [
        "invoked_at"
      ],
      unique: false,
      ifNotExists: true,
      where: "status != 'pending_confirmation'"
    }
  }
],
});
