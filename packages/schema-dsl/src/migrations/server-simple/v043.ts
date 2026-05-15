import { defineMigration, type Migration } from '../../index.js';

export const v043_migration: Migration = defineMigration({
  kind: 'schema',
  id: '043',
  aliases: { postgres: 'v043', 'sqlite-sql': 'v043' },
  description: "企业协作：organization/workspace/membership/role_binding",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "organizations",
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
          name: "name",
          type: "text",
          nullable: false
        },
        {
          name: "slug",
          type: "text",
          nullable: false
        },
        {
          name: "created_by_user_id",
          type: "text",
          nullable: false,
          references: {
            table: "users",
            column: "id",
            onDelete: "CASCADE"
          }
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
      name: "idx_organizations_slug",
      table: "organizations",
      columns: [
        "tenant_id",
        "slug"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_organizations_creator",
      table: "organizations",
      columns: [
        "tenant_id",
        "created_by_user_id",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "workspaces",
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
          name: "organization_id",
          type: "text",
          nullable: false,
          references: {
            table: "organizations",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "name",
          type: "text",
          nullable: false
        },
        {
          name: "slug",
          type: "text",
          nullable: false
        },
        {
          name: "is_default",
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
      name: "idx_workspaces_slug",
      table: "workspaces",
      columns: [
        "tenant_id",
        "organization_id",
        "slug"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_workspaces_default",
      table: "workspaces",
      columns: [
        "tenant_id",
        "organization_id",
        "is_default"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "organization_memberships",
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
          name: "organization_id",
          type: "text",
          nullable: false,
          references: {
            table: "organizations",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "user_id",
          type: "text",
          nullable: false,
          references: {
            table: "users",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          check: "status IN ('active', 'invited', 'suspended')"
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
      name: "idx_org_memberships_unique",
      table: "organization_memberships",
      columns: [
        "tenant_id",
        "organization_id",
        "user_id"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_org_memberships_user",
      table: "organization_memberships",
      columns: [
        "tenant_id",
        "user_id",
        "status",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "organization_role_bindings",
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
          name: "organization_id",
          type: "text",
          nullable: false,
          references: {
            table: "organizations",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "workspace_id",
          type: "text",
          references: {
            table: "workspaces",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "membership_id",
          type: "text",
          nullable: false,
          references: {
            table: "organization_memberships",
            column: "id",
            onDelete: "CASCADE"
          }
        },
        {
          name: "role",
          type: "text",
          nullable: false,
          check: "role IN ('org_admin', 'billing_admin', 'persona_operator', 'marketplace_manager', 'auditor', 'viewer')"
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
      name: "idx_org_role_bindings_unique",
      table: "organization_role_bindings",
      columns: [
        "tenant_id",
        "organization_id",
        "workspace_id",
        "membership_id",
        "role"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_org_role_bindings_membership",
      table: "organization_role_bindings",
      columns: [
        "tenant_id",
        "membership_id",
        "role"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
