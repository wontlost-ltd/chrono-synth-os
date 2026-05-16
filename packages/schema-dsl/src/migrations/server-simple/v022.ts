import { defineMigration, type Migration } from '../../index.js';

export const v022_migration: Migration = defineMigration({
  kind: 'schema',
  id: '022',
  aliases: { postgres: 'v022', 'sqlite-sql': 'v022' },
  description: "IVF 质心持久化与 WebSocket 持久化事件日志",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "ivf_centroids",
      ifNotExists: true,
      columns: [
        {
          name: "model",
          type: "text",
          primaryKey: true
        },
        {
          name: "centroids_json",
          type: "text",
          nullable: false
        },
        {
          name: "num_vectors",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "built_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-table",
    table: {
      name: "ws_event_log",
      ifNotExists: true,
      columns: [
        {
          name: "seq",
          type: "bigint",
          primaryKey: true,
          autoIncrement: true
        },
        {
          name: "event",
          type: "text",
          nullable: false
        },
        {
          name: "data_json",
          type: "text",
          nullable: false
        },
        {
          name: "tenant_id",
          type: "text"
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
      name: "idx_ws_event_log_tenant",
      table: "ws_event_log",
      columns: [
        "tenant_id",
        "seq"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_ws_event_log_created",
      table: "ws_event_log",
      columns: [
        "created_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
