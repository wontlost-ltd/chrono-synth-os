import { defineMigration, type Migration } from '../../index.js';

export const v058_migration: Migration = defineMigration({
  kind: 'schema',
  id: '058',
  aliases: { postgres: 'v058', 'sqlite-sql': 'v058' },
  description: "可移植性：导入 commit token 与导入任务追踪",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "import_commit_tokens",
      ifNotExists: true,
      columns: [
        {
          name: "token",
          type: "text",
          primaryKey: true
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "import_id",
          type: "text",
          nullable: false
        },
        {
          name: "manifest_checksum",
          type: "text",
          nullable: false
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
      name: "idx_ict_tenant",
      table: "import_commit_tokens",
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
      name: "import_jobs",
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
          name: "state",
          type: "text",
          nullable: false,
          default: "pending"
        },
        {
          name: "manifest_checksum",
          type: "text",
          nullable: false
        },
        {
          name: "imported_count",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "skipped_count",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "completed_at",
          type: "bigint"
        },
        {
          name: "error_message",
          type: "text"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_ij_tenant",
      table: "import_jobs",
      columns: [
        "tenant_id"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
