import { defineMigration, type Migration } from '../../index.js';

export const v049_migration: Migration = defineMigration({
  kind: 'schema',
  id: '049',
  aliases: { postgres: 'v049', 'sqlite-sql': 'v049' },
  description: "可移植性：异步导出任务状态追踪",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "export_jobs",
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
          default: "queued"
        },
        {
          name: "percent",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "eta_ms",
          type: "bigint"
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
          name: "download_url",
          type: "text"
        },
        {
          name: "error_code",
          type: "text"
        },
        {
          name: "warnings",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "pack_json",
          type: "text"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_export_jobs_tenant",
      table: "export_jobs",
      columns: [
        "tenant_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
