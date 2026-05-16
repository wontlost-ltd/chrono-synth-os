import { defineMigration, type Migration } from '../../index.js';

export const v062_migration: Migration = defineMigration({
  kind: 'schema',
  id: '062',
  aliases: { postgres: 'v062', 'sqlite-sql': 'v062' },
  description: "P1-A 岗位人格模板：predefined builtin templates + custom CRUD",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "persona_templates",
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
          name: "category",
          type: "text",
          nullable: false
        },
        {
          name: "label",
          type: "text",
          nullable: false
        },
        {
          name: "description",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "default_values_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "default_narrative",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "behavior_boundaries_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "required_knowledge_categories_json",
          type: "text",
          nullable: false,
          default: "[]"
        },
        {
          name: "is_builtin",
          type: "integer",
          nullable: false,
          default: 0
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
      name: "idx_persona_templates_tenant_category",
      table: "persona_templates",
      columns: [
        "tenant_id",
        "category"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
