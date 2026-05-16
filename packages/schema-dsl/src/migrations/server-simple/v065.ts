import { defineMigration, type Migration } from '../../index.js';

export const v065_migration: Migration = defineMigration({
  kind: 'schema',
  id: '065',
  aliases: { postgres: 'v065', 'sqlite-sql': 'v065' },
  description: "P1-C 对话接入层：conversation_messages + conversation_confirmation_tokens",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "conversation_messages",
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
          name: "session_id",
          type: "text",
          nullable: false
        },
        {
          name: "message_id",
          type: "text",
          nullable: false
        },
        {
          name: "external_user_id",
          type: "text",
          nullable: false
        },
        {
          name: "user_input",
          type: "text",
          nullable: false
        },
        {
          name: "assistant_output",
          type: "text",
          nullable: false
        },
        {
          name: "memories_used_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "should_escalate",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "confidence_score",
          type: "real",
          nullable: false,
          default: 0.5
        },
        {
          name: "confidence_factors_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "guard_action",
          type: "text"
        },
        {
          name: "guard_reason",
          type: "text"
        },
        {
          name: "duration_ms",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "prompt_tokens",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "completion_tokens",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "encryption_key_ref",
          type: "text"
        },
        {
          name: "input_redacted_pii_count",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "output_redacted_pii_count",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "retention_class",
          type: "text",
          nullable: false,
          default: "standard",
          check: "retention_class IN ('standard', 'extended', 'litigation_hold')"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        }
      ],
      constraints: [
        {
          kind: "unique",
          columns: [
            "tenant_id",
            "persona_id",
            "session_id",
            "message_id"
          ]
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_conv_msg_session",
      table: "conversation_messages",
      columns: [
        "tenant_id",
        "persona_id",
        "session_id",
        "created_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_conv_msg_user",
      table: "conversation_messages",
      columns: [
        "tenant_id",
        "external_user_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_conv_msg_retention",
      table: "conversation_messages",
      columns: [
        "tenant_id",
        "retention_class",
        "created_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "conversation_confirmation_tokens",
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
          name: "session_id",
          type: "text",
          nullable: false
        },
        {
          name: "external_user_id",
          type: "text",
          nullable: false
        },
        {
          name: "requested_topic",
          type: "text",
          nullable: false
        },
        {
          name: "requested_rule",
          type: "text",
          nullable: false
        },
        {
          name: "input_hash",
          type: "text",
          nullable: false
        },
        {
          name: "issued_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "expires_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "consumed_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_conv_conf_token_lookup",
      table: "conversation_confirmation_tokens",
      columns: [
        "tenant_id",
        "persona_id",
        "session_id",
        "expires_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_conv_conf_token_expiry",
      table: "conversation_confirmation_tokens",
      columns: [
        "expires_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
