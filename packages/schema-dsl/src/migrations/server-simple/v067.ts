import { defineMigration, type Migration } from '../../index.js';

export const v067_migration: Migration = defineMigration({
  kind: 'schema',
  id: '067',
  aliases: { postgres: 'v067', 'sqlite-sql': 'v067' },
  description: "P3：tool_permissions / agency_authorizations / tool_invocations 表",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "tool_permissions",
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
          name: "persona_id",
          type: "text",
          nullable: false
        },
        {
          name: "tool_id",
          type: "text",
          nullable: false
        },
        {
          name: "scope",
          type: "text",
          nullable: false
        },
        {
          name: "constraints_json",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "granted_by",
          type: "text",
          nullable: false
        },
        {
          name: "granted_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "expires_at",
          type: "bigint"
        },
        {
          name: "revoked_at",
          type: "bigint"
        },
        {
          name: "revocation_reason",
          type: "text"
        },
        {
          name: "revocation_key",
          type: "text",
          unique: true,
          nullable: false
        }
      ],
      constraints: [
        {
          kind: "unique",
          columns: [
            "tenant_id",
            "persona_id",
            "tool_id"
          ]
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tool_permissions_persona",
      table: "tool_permissions",
      columns: [
        "tenant_id",
        "persona_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tool_permissions_tenant_active",
      table: "tool_permissions",
      columns: [
        "tenant_id"
      ],
      unique: false,
      ifNotExists: true,
      where: "revoked_at IS NULL"
    }
  },
  {
    kind: "create-table",
    table: {
      name: "agency_authorizations",
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
          name: "persona_id",
          type: "text",
          nullable: false
        },
        {
          name: "principal_user_id",
          type: "text",
          nullable: false
        },
        {
          name: "scope",
          type: "text",
          nullable: false
        },
        {
          name: "scope_description",
          type: "text",
          nullable: false
        },
        {
          name: "allowed_tools_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "denied_tools_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          default: "active"
        },
        {
          name: "granted_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "expires_at",
          type: "bigint"
        },
        {
          name: "revoked_at",
          type: "bigint"
        },
        {
          name: "revocation_reason",
          type: "text"
        },
        {
          name: "revocation_key",
          type: "text",
          unique: true,
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_agency_authorizations_persona",
      table: "agency_authorizations",
      columns: [
        "tenant_id",
        "persona_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_agency_authorizations_principal",
      table: "agency_authorizations",
      columns: [
        "tenant_id",
        "principal_user_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_agency_authorizations_status",
      table: "agency_authorizations",
      columns: [
        "tenant_id",
        "status"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "tool_invocations",
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
          name: "persona_id",
          type: "text",
          nullable: false
        },
        {
          name: "tool_id",
          type: "text",
          nullable: false
        },
        {
          name: "invoker_type",
          type: "text",
          nullable: false
        },
        {
          name: "invoker_id",
          type: "text",
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false
        },
        {
          name: "input_hash",
          type: "text",
          nullable: false
        },
        {
          name: "output_size_bytes",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "error_message",
          type: "text"
        },
        {
          name: "cost_cents",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "duration_ms",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "invoked_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "completed_at",
          type: "bigint"
        },
        {
          name: "confirmation_token_id",
          type: "text"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tool_invocations_persona_invoked",
      table: "tool_invocations",
      columns: [
        "tenant_id",
        "persona_id",
        "invoked_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tool_invocations_quota_window",
      table: "tool_invocations",
      columns: [
        "tenant_id",
        "persona_id",
        "tool_id",
        "invoked_at"
      ],
      unique: false,
      ifNotExists: true,
      where: "status = 'success'"
    }
  }
],
});
