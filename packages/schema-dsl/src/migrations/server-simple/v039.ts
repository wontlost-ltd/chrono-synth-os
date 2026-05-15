import { defineMigration, type Migration } from '../../index.js';

export const v039_migration: Migration = defineMigration({
  kind: 'schema',
  id: '039',
  aliases: { postgres: 'v039', 'sqlite-sql': 'v039' },
  description: "企业可靠性：通用 Idempotency-Key 响应缓存",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "idempotency_keys",
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
          name: "scope_key",
          type: "text",
          nullable: false
        },
        {
          name: "idempotency_key",
          type: "text",
          nullable: false
        },
        {
          name: "request_hash",
          type: "text",
          nullable: false
        },
        {
          name: "request_method",
          type: "text",
          nullable: false
        },
        {
          name: "request_path",
          type: "text",
          nullable: false
        },
        {
          name: "state",
          type: "text",
          nullable: false,
          check: "state IN ('in_progress', 'completed')"
        },
        {
          name: "response_status",
          type: "integer"
        },
        {
          name: "response_content_type",
          type: "text"
        },
        {
          name: "response_headers_json",
          type: "text"
        },
        {
          name: "response_body",
          type: "text"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "expires_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_idempotency_keys_scope",
      table: "idempotency_keys",
      columns: [
        "tenant_id",
        "scope_key",
        "idempotency_key"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_idempotency_keys_expiry",
      table: "idempotency_keys",
      columns: [
        "expires_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
