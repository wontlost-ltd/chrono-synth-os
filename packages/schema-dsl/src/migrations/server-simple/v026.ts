import { defineMigration, type Migration } from '../../index.js';

export const v026_migration: Migration = defineMigration({
  kind: 'schema',
  id: '026',
  aliases: { postgres: 'v026', 'sqlite-sql': 'v026' },
  description: "移动端设备注册与推送 token 管理",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "devices",
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
          type: "text",
          nullable: false
        },
        {
          name: "device_uid",
          type: "text",
          nullable: false
        },
        {
          name: "platform",
          type: "text",
          nullable: false,
          check: "platform IN ('ios', 'android', 'web')"
        },
        {
          name: "push_token",
          type: "text"
        },
        {
          name: "app_version",
          type: "text"
        },
        {
          name: "last_seen_at",
          type: "bigint",
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
      name: "idx_devices_tenant_user_uid",
      table: "devices",
      columns: [
        "tenant_id",
        "user_id",
        "device_uid"
      ],
      unique: true,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_devices_user",
      table: "devices",
      columns: [
        "user_id"
      ],
      unique: false,
      ifNotExists: true
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_devices_tenant",
      table: "devices",
      columns: [
        "tenant_id"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
