import { defineMigration, type Migration } from '../../index.js';

export const v055_migration: Migration = defineMigration({
  kind: 'schema',
  id: '055',
  aliases: { postgres: 'v055', 'sqlite-sql': 'v055' },
  description: "平台密钥撤销记录",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "platform_key_revocations",
      ifNotExists: true,
      columns: [
        {
          name: "key_ref",
          type: "text",
          primaryKey: true
        },
        {
          name: "revoked_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "revoked_by",
          type: "text"
        }
      ]
    }
  }
],
});
