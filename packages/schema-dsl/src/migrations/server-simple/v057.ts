import { defineMigration, type Migration } from '../../index.js';

export const v057_migration: Migration = defineMigration({
  kind: 'schema',
  id: '057',
  aliases: { postgres: 'v057', 'sqlite-sql': 'v057' },
  description: "同步冲突收件箱",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "conflict_inbox",
      ifNotExists: true,
      columns: [
        {
          name: "conflict_id",
          type: "text",
          primaryKey: true
        },
        {
          name: "conflict_version",
          type: "text",
          nullable: false
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "entity_type",
          type: "text",
          nullable: false
        },
        {
          name: "entity_id",
          type: "text",
          nullable: false
        },
        {
          name: "command_id",
          type: "text"
        },
        {
          name: "source_runtime",
          type: "text",
          nullable: false
        },
        {
          name: "detected_at",
          type: "text",
          nullable: false
        },
        {
          name: "severity",
          type: "text",
          nullable: false,
          default: "warning"
        },
        {
          name: "local_summary_id",
          type: "text",
          nullable: false
        },
        {
          name: "local_summary_params",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "server_summary_id",
          type: "text",
          nullable: false
        },
        {
          name: "server_summary_params",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "suggested_actions",
          type: "text",
          nullable: false,
          default: "[\"keep_server\"]"
        },
        {
          name: "resolved_at",
          type: "text"
        },
        {
          name: "resolution_action",
          type: "text"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_conflict_inbox_tenant",
      table: "conflict_inbox",
      columns: [
        "tenant_id",
        "detected_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_conflict_inbox_blocking",
      table: "conflict_inbox",
      columns: [
        "tenant_id",
        "severity"
      ],
      unique: false,
      ifNotExists: true,
      where: "resolved_at IS NULL"
    }
  }
],
});
