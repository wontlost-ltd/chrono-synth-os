import { defineMigration, type Migration } from '../../index.js';

export const v012_migration: Migration = defineMigration({
  kind: 'schema',
  id: '012',
  aliases: { postgres: 'v012', 'sqlite-sql': 'v012' },
  description: "人生模拟引擎",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "life_simulations",
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
          nullable: false,
          default: "default"
        },
        {
          name: "task_id",
          type: "text",
          nullable: false
        },
        {
          name: "base_simulation_id",
          type: "text",
          references: {
            table: "life_simulations",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "config_json",
          type: "text",
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('pending', 'running', 'completed', 'failed', 'cancelled')"
        },
        {
          name: "summary_json",
          type: "text"
        },
        {
          name: "progress_json",
          type: "text"
        },
        {
          name: "error",
          type: "text"
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
      name: "idx_life_sims_tenant",
      table: "life_simulations",
      columns: [
        "tenant_id",
        "created_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "life_simulation_paths",
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
          nullable: false,
          references: {
            table: "life_simulations",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "path_id",
          type: "text",
          nullable: false
        },
        {
          name: "label",
          type: "text",
          nullable: false
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('pending', 'running', 'completed', 'failed')"
        },
        {
          name: "summary_json",
          type: "text"
        },
        {
          name: "timeline_json",
          type: "text"
        },
        {
          name: "branches_json",
          type: "text"
        },
        {
          name: "retrospective_json",
          type: "text"
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
      name: "idx_life_sim_paths",
      table: "life_simulation_paths",
      columns: [
        "simulation_id"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
