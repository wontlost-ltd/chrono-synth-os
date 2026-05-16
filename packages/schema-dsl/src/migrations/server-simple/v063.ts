import { defineMigration, type Migration } from '../../index.js';

export const v063_migration: Migration = defineMigration({
  kind: 'schema',
  id: '063',
  aliases: { postgres: 'v063', 'sqlite-sql': 'v063' },
  description: "P1-B 知识批量导入：fingerprint 去重 + 异步 job 跟踪",
  operations: [
  {
    kind: "add-column",
    table: "persona_knowledge_items",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "fingerprint",
      type: "text"
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_persona_knowledge_fp",
      table: "persona_knowledge_items",
      columns: [
        "tenant_id",
        "persona_id",
        "fingerprint"
      ],
      unique: true,
      ifNotExists: true,
      where: "fingerprint IS NOT NULL"
    }
  },
  {
    kind: "create-table",
    table: {
      name: "bulk_knowledge_import_jobs",
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
          name: "owner_user_id",
          type: "text",
          nullable: false
        },
        {
          name: "state",
          type: "text",
          nullable: false,
          default: "queued",
          check: "state IN ('queued', 'running', 'completed', 'failed')"
        },
        {
          name: "total_items",
          type: "integer",
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
          name: "failed_count",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "failures_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "deduplicate_strategy",
          type: "text",
          nullable: false,
          default: "skip",
          check: "deduplicate_strategy IN ('skip', 'overwrite')"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "started_at",
          type: "bigint"
        },
        {
          name: "completed_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_bki_jobs_tenant_created",
      table: "bulk_knowledge_import_jobs",
      columns: [
        "tenant_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_bki_jobs_persona",
      table: "bulk_knowledge_import_jobs",
      columns: [
        "tenant_id",
        "persona_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
