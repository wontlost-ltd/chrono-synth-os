import { defineMigration, type Migration } from '../../index.js';

export const v033_migration: Migration = defineMigration({
  kind: 'schema',
  id: '033',
  aliases: { postgres: 'v033', 'sqlite-sql': 'v033' },
  description: "Persona OS：persona 级认知记忆、关联边与工作记忆",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "persona_memory_nodes",
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
          name: "fork_id",
          type: "text",
          references: {
            table: "persona_forks",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "source_memory_id",
          type: "text",
          unique: true,
          references: {
            table: "persona_memories",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "knowledge_item_id",
          type: "text",
          unique: true,
          references: {
            table: "persona_knowledge_items",
            column: "id",
            onDelete: "SET NULL"
          }
        },
        {
          name: "kind",
          type: "text",
          nullable: false,
          check: "kind IN ('episodic', 'semantic', 'procedural')"
        },
        {
          name: "content",
          type: "text",
          nullable: false
        },
        {
          name: "valence",
          type: "real",
          nullable: false,
          default: 0,
          check: "valence >= -1 AND valence <= 1"
        },
        {
          name: "salience",
          type: "real",
          nullable: false,
          default: 0.5,
          check: "salience >= 0 AND salience <= 1"
        },
        {
          name: "access_count",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "decay_lambda",
          type: "real",
          nullable: false,
          default: 0.0001
        },
        {
          name: "last_accessed_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "last_decayed_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "consolidated_from",
          type: "text",
          references: {
            table: "persona_memory_nodes",
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
      name: "idx_persona_memory_nodes_persona",
      table: "persona_memory_nodes",
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
      name: "idx_persona_memory_nodes_kind",
      table: "persona_memory_nodes",
      columns: [
        "tenant_id",
        "persona_id",
        "kind",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "persona_memory_edges",
      ifNotExists: true,
      columns: [
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
          name: "source",
          type: "text",
          nullable: false,
          references: {
            table: "persona_memory_nodes",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "target",
          type: "text",
          nullable: false,
          references: {
            table: "persona_memory_nodes",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "strength",
          type: "real",
          nullable: false,
          check: "strength >= 0 AND strength <= 1"
        },
        {
          name: "relation",
          type: "text",
          nullable: false
        }
      ],
      constraints: [
        {
          kind: "primary-key",
          columns: [
            "source",
            "target"
          ]
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_persona_memory_edges_target",
      table: "persona_memory_edges",
      columns: [
        "tenant_id",
        "persona_id",
        "target"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "persona_working_memory",
      ifNotExists: true,
      columns: [
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
          name: "memory_id",
          type: "text",
          primaryKey: true,
          references: {
            table: "persona_memory_nodes",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "score",
          type: "real",
          nullable: false
        },
        {
          name: "entered_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_persona_working_memory_score",
      table: "persona_working_memory",
      columns: [
        "tenant_id",
        "persona_id",
        "score DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
