import { defineMigration, type Migration } from '../../index.js';

export const v048_migration: Migration = defineMigration({
  kind: 'schema',
  id: '048',
  aliases: { postgres: 'v048', 'sqlite-sql': 'v048' },
  description: "观测链路：为 Kafka / DB 双路径增加 rollup 幂等去重",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "observability_processed_events",
      ifNotExists: true,
      columns: [
        {
          name: "event_id",
          type: "text",
          primaryKey: true
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "event_type",
          type: "text",
          nullable: false
        },
        {
          name: "processed_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_observability_processed_events_tenant",
      table: "observability_processed_events",
      columns: [
        "tenant_id",
        "processed_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
