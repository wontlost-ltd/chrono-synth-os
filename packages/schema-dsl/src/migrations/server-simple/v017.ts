import { defineMigration, type Migration } from '../../index.js';

export const v017_migration: Migration = defineMigration({
  kind: 'schema',
  id: '017',
  aliases: { postgres: 'v017', 'sqlite-sql': 'v017' },
  description: "决策案例/运行结果与引导会话持久化",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "decision_cases",
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
          name: "title",
          type: "text",
          nullable: false
        },
        {
          name: "description",
          type: "text",
          nullable: false
        },
        {
          name: "alternatives_json",
          type: "text",
          nullable: false
        },
        {
          name: "constraints_json",
          type: "text"
        },
        {
          name: "context_json",
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
      name: "idx_decision_cases_tenant",
      table: "decision_cases",
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
      name: "decision_runs",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "case_id",
          type: "text",
          nullable: false,
          references: {
            table: "decision_cases",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false,
          default: "default"
        },
        {
          name: "result_json",
          type: "text",
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
      name: "idx_decision_runs_case",
      table: "decision_runs",
      columns: [
        "case_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_decision_runs_tenant",
      table: "decision_runs",
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
      name: "decision_feedbacks",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "run_id",
          type: "text",
          nullable: false,
          references: {
            table: "decision_runs",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false,
          default: "default"
        },
        {
          name: "selected_alternative",
          type: "text",
          nullable: false
        },
        {
          name: "satisfaction",
          type: "integer",
          nullable: false
        },
        {
          name: "notes",
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
      name: "idx_decision_feedbacks_run",
      table: "decision_feedbacks",
      columns: [
        "run_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "onboarding_sessions",
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
          name: "current_step",
          type: "integer",
          nullable: false,
          default: 1
        },
        {
          name: "completed_steps_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "decision_json",
          type: "text"
        },
        {
          name: "simulation_result_json",
          type: "text"
        },
        {
          name: "snapshot_id",
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
      name: "idx_onboarding_sessions_tenant",
      table: "onboarding_sessions",
      columns: [
        "tenant_id"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
