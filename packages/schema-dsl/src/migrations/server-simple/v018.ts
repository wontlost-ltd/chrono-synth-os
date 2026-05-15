import { defineMigration, type Migration } from '../../index.js';

export const v018_migration: Migration = defineMigration({
  kind: 'schema',
  id: '018',
  aliases: { postgres: 'v018', 'sqlite-sql': 'v018' },
  description: "刷新令牌复合索引与过期清理",
  operations: [
  {
    kind: "create-index",
    index: {
      name: "idx_refresh_tokens_hash_revoked",
      table: "refresh_tokens",
      columns: [
        "token_hash",
        "is_revoked"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
