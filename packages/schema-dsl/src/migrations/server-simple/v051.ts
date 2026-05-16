import { defineMigration, type Migration } from '../../index.js';

export const v051_migration: Migration = defineMigration({
  kind: 'schema',
  id: '051',
  aliases: { postgres: 'v051', 'sqlite-sql': 'v051' },
  description: "租户自带对象存储（BYOS）配置",
  operations: [
  {
    kind: "add-column",
    table: "tenant_enterprise_profiles",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "byos_provider",
      type: "text",
      nullable: false,
      default: "platform"
    }
  },
  {
    kind: "add-column",
    table: "tenant_enterprise_profiles",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "byos_bucket",
      type: "text",
      nullable: false,
      default: ""
    }
  },
  {
    kind: "add-column",
    table: "tenant_enterprise_profiles",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "byos_key_prefix",
      type: "text",
      nullable: false,
      default: ""
    }
  }
],
});
