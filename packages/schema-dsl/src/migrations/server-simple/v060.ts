import { defineMigration, type Migration } from '../../index.js';

export const v060_migration: Migration = defineMigration({
  kind: 'schema',
  id: '060',
  aliases: { postgres: 'v060', 'sqlite-sql': 'v060' },
  description: "AI 安全治理：memory_nodes 置信度、来源类型与未验证标记",
  operations: [
  {
    kind: "add-column",
    table: "memory_nodes",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "confidence_score",
      type: "real",
      nullable: false,
      default: 0.5
    }
  },
  {
    kind: "add-column",
    table: "memory_nodes",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "source_kind",
      type: "text",
      nullable: false,
      default: "unknown"
    }
  },
  {
    kind: "add-column",
    table: "memory_nodes",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "unverified",
      type: "integer",
      nullable: false,
      default: 1
    }
  }
],
});
