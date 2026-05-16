import { defineMigration, type Migration } from '../../index.js';

export const v054_migration: Migration = defineMigration({
  kind: 'schema',
  id: '054',
  aliases: { postgres: 'v054', 'sqlite-sql': 'v054' },
  description: "投影存储：读模型持久化，支持按租户+投影名+ID读写",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "projection_store",
      ifNotExists: true,
      columns: [
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "projection",
          type: "text",
          nullable: false
        },
        {
          name: "id",
          type: "text",
          nullable: false
        },
        {
          name: "value_json",
          type: "text",
          nullable: false
        },
        {
          name: "version",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        }
      ],
      constraints: [
        {
          kind: "primary-key",
          columns: [
            "tenant_id",
            "projection",
            "id"
          ]
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_projection_store_list",
      table: "projection_store",
      columns: [
        "tenant_id",
        "projection",
        "id"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
