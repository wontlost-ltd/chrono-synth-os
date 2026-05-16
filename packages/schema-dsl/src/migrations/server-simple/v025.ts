import { defineMigration, type Migration } from '../../index.js';

export const v025_migration: Migration = defineMigration({
  kind: 'schema',
  id: '025',
  aliases: { postgres: 'v025', 'sqlite-sql': 'v025' },
  description: "配置中心（config_items/config_audit）与附加组件（add_ons/tenant_add_ons/entitlements）",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "config_items",
      ifNotExists: true,
      columns: [
        {
          name: "key",
          type: "text",
          primaryKey: true
        },
        {
          name: "value_json",
          type: "text",
          nullable: false
        },
        {
          name: "category",
          type: "text",
          nullable: false,
          check: "category IN ('public', 'protected', 'admin', 'secret')"
        },
        {
          name: "requires_restart",
          type: "boolean",
          nullable: false,
          default: false
        },
        {
          name: "group_key",
          type: "text",
          nullable: false,
          default: "general"
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "updated_by",
          type: "text",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-table",
    table: {
      name: "config_audit",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "bigint",
          primaryKey: true,
          autoIncrement: true
        },
        {
          name: "config_key",
          type: "text",
          nullable: false
        },
        {
          name: "old_value",
          type: "text"
        },
        {
          name: "new_value",
          type: "text"
        },
        {
          name: "changed_by",
          type: "text",
          nullable: false
        },
        {
          name: "changed_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_config_audit_key",
      table: "config_audit",
      columns: [
        "config_key"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_config_audit_time",
      table: "config_audit",
      columns: [
        "changed_at"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "add_ons",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "code",
          type: "text",
          unique: true,
          nullable: false
        },
        {
          name: "name",
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
          name: "stripe_price_id",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "resource",
          type: "text",
          nullable: false
        },
        {
          name: "quota_amount",
          type: "integer",
          nullable: false
        },
        {
          name: "is_active",
          type: "boolean",
          nullable: false,
          default: true
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
      name: "idx_add_ons_code",
      table: "add_ons",
      columns: [
        "code"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "tenant_add_ons",
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
          name: "add_on_id",
          type: "text",
          nullable: false,
          references: {
            table: "add_ons",
            column: "id"
          }
        },
        {
          name: "stripe_subscription_item_id",
          type: "text"
        },
        {
          name: "status",
          type: "text",
          nullable: false,
          default: "active",
          check: "status IN ('active', 'canceled')"
        },
        {
          name: "purchased_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "canceled_at",
          type: "bigint"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tenant_add_ons_tenant",
      table: "tenant_add_ons",
      columns: [
        "tenant_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tenant_add_ons_status",
      table: "tenant_add_ons",
      columns: [
        "tenant_id",
        "status"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-table",
    table: {
      name: "entitlements",
      ifNotExists: true,
      columns: [
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "resource",
          type: "text",
          nullable: false
        },
        {
          name: "effective_limit",
          type: "integer",
          nullable: false
        },
        {
          name: "source",
          type: "text",
          nullable: false,
          default: "plan"
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        }
      ],
      constraints: [
        {
          kind: "primary-key",
          columns: [
            "tenant_id",
            "resource"
          ]
        }
      ]
    }
  }
],
});
