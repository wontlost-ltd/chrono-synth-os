import { defineMigration, type Migration } from '../../index.js';

export const v015_migration: Migration = defineMigration({
  kind: 'schema',
  id: '015',
  aliases: { postgres: 'v015', 'sqlite-sql': 'v015' },
  description: "协作分享模拟",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "shared_simulations",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "simulation_id",
          type: "text",
          nullable: false
        },
        {
          name: "owner_user_id",
          type: "text",
          nullable: false
        },
        {
          name: "shared_with_user_id",
          type: "text",
          nullable: false
        },
        {
          name: "permission",
          type: "text",
          nullable: false,
          default: "view",
          check: "permission IN ('view', 'edit')"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_shared_sims_sim",
      table: "shared_simulations",
      columns: [
        "simulation_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_shared_sims_shared_with",
      table: "shared_simulations",
      columns: [
        "shared_with_user_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_shared_sims_unique",
      table: "shared_simulations",
      columns: [
        "simulation_id",
        "shared_with_user_id"
      ],
      unique: true,
      ifNotExists: true
    }
  }
],
});
