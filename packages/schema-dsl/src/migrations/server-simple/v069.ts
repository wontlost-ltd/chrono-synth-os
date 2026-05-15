import { defineMigration, type Migration } from '../../index.js';

export const v069_migration: Migration = defineMigration({
  kind: 'schema',
  id: '069',
  aliases: { postgres: 'v069', 'sqlite-sql': 'v069' },
  description: "P1.7.2: events_user_journey for onboarding + first-use telemetry",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "events_user_journey",
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
          name: "user_id",
          type: "text"
        },
        {
          name: "session_id",
          type: "text"
        },
        {
          name: "name",
          type: "text",
          nullable: false
        },
        {
          name: "properties_json",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "client_ts",
          type: "bigint",
          nullable: false
        },
        {
          name: "ingested_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_events_user_journey_tenant_ts",
      table: "events_user_journey",
      columns: [
        "tenant_id",
        "ingested_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_events_user_journey_user_ts",
      table: "events_user_journey",
      columns: [
        "tenant_id",
        "user_id",
        "ingested_at DESC"
      ],
      unique: false,
      ifNotExists: true,
      where: "user_id IS NOT NULL"
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_events_user_journey_retention",
      table: "events_user_journey",
      columns: [
        "ingested_at"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
