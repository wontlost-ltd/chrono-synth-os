import { defineMigration, type Migration } from '../../index.js';

export const v035_migration: Migration = defineMigration({
  kind: 'schema',
  id: '035',
  aliases: { postgres: 'v035', 'sqlite-sql': 'v035' },
  description: "Persona OS v1：runtime session、任务工作流与治理 case/action",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "task_applications",
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
          name: "task_id",
          type: "text",
          nullable: false,
          references: {
            table: "marketplace_tasks",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "persona_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "ranking_score",
          type: "real",
          nullable: false,
          default: 0
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('submitted', 'assigned', 'rejected', 'withdrawn')"
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
      name: "idx_task_applications_unique",
      table: "task_applications",
      columns: [
        "tenant_id",
        "task_id",
        "persona_id"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_task_applications_task",
      table: "task_applications",
      columns: [
        "tenant_id",
        "task_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_task_applications_persona",
      table: "task_applications",
      columns: [
        "tenant_id",
        "persona_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "task_assignments",
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
          name: "task_id",
          type: "text",
          nullable: false,
          references: {
            table: "marketplace_tasks",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "persona_id",
          type: "text",
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "application_id",
          type: "text",
          references: {
            table: "task_applications",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "runtime_session_id",
          type: "text"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('assigned', 'in_progress', 'submitted', 'accepted', 'rejected', 'disputed', 'completed')"
        },
        {
          name: "assigned_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "started_at",
          type: "bigint"
        },
        {
          name: "submitted_at",
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
      name: "idx_task_assignments_task",
      table: "task_assignments",
      columns: [
        "tenant_id",
        "task_id",
        "assigned_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_task_assignments_persona",
      table: "task_assignments",
      columns: [
        "tenant_id",
        "persona_id",
        "assigned_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_task_assignments_status",
      table: "task_assignments",
      columns: [
        "tenant_id",
        "status",
        "assigned_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "runtime_sessions",
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
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "task_id",
          type: "text",
          nullable: false,
          references: {
            table: "marketplace_tasks",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "assignment_id",
          type: "text",
          references: {
            table: "task_assignments",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "state",
          type: "text",
          nullable: false,
          check: "state IN ('PLAN', 'EXECUTE', 'EVALUATE', 'MEMORY_UPDATE', 'REPUTATION_UPDATE', 'COMPLETED', 'ERROR')"
        },
        {
          name: "plan_json",
          type: "text"
        },
        {
          name: "artifacts_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "evaluation_json",
          type: "text"
        },
        {
          name: "result_summary_json",
          type: "text"
        },
        {
          name: "error_json",
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
      name: "idx_runtime_sessions_task",
      table: "runtime_sessions",
      columns: [
        "tenant_id",
        "task_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_runtime_sessions_persona",
      table: "runtime_sessions",
      columns: [
        "tenant_id",
        "persona_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_runtime_sessions_assignment",
      table: "runtime_sessions",
      columns: [
        "tenant_id",
        "assignment_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "task_results",
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
          name: "task_id",
          type: "text",
          nullable: false,
          references: {
            table: "marketplace_tasks",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "assignment_id",
          type: "text",
          nullable: false,
          references: {
            table: "task_assignments",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "result_uri",
          type: "text",
          nullable: false
        },
        {
          name: "evaluation_json",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "quality_score",
          type: "real"
        },
        {
          name: "client_rating",
          type: "integer"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('submitted', 'accepted', 'rejected', 'disputed')"
        },
        {
          name: "rejection_reason",
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
          name: "accepted_at",
          type: "bigint"
        },
        {
          name: "rejected_at",
          type: "bigint"
        },
        {
          name: "disputed_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_task_results_assignment",
      table: "task_results",
      columns: [
        "tenant_id",
        "assignment_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_task_results_task",
      table: "task_results",
      columns: [
        "tenant_id",
        "task_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "governance_cases",
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
          nullable: false,
          references: {
            table: "persona_core",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "task_id",
          type: "text",
          references: {
            table: "marketplace_tasks",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "trigger_type",
          type: "text",
          nullable: false
        },
        {
          name: "severity",
          type: "text",
          nullable: false,
          check: "severity IN ('low', 'medium', 'high', 'critical')"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('open', 'action_applied', 'appealed', 'resolved')"
        },
        {
          name: "details_json",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "appeal_json",
          type: "text"
        },
        {
          name: "opened_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "resolved_at",
          type: "bigint"
        },
        {
          name: "appealed_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_governance_cases_persona",
      table: "governance_cases",
      columns: [
        "tenant_id",
        "persona_id",
        "opened_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_governance_cases_status",
      table: "governance_cases",
      columns: [
        "tenant_id",
        "status",
        "opened_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "governance_actions",
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
          name: "case_id",
          type: "text",
          nullable: false,
          references: {
            table: "governance_cases",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "action_type",
          type: "text",
          nullable: false,
          check: "action_type IN ('warning', 'temporary_restriction', 'temporary_suspension', 'reinstate', 'termination')"
        },
        {
          name: "duration_seconds",
          type: "integer"
        },
        {
          name: "details_json",
          type: "text",
          nullable: false,
          default: "{}"
        },
        {
          name: "actor_user_id",
          type: "text",
          references: {
            table: "users",
            column: "id",
            onDelete: "SET NULL"
          }
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
      name: "idx_governance_actions_case",
      table: "governance_actions",
      columns: [
        "tenant_id",
        "case_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
