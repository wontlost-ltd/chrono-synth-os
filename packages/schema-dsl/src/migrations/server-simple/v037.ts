import { defineMigration, type Migration } from '../../index.js';

export const v037_migration: Migration = defineMigration({
  kind: 'schema',
  id: '037',
  aliases: { postgres: 'v037', 'sqlite-sql': 'v037' },
  description: "Persona OS v1：敏感记忆分级与静态加密元数据",
  operations: [
  {
    kind: "add-column",
    table: "persona_memories",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "sensitivity",
      type: "text",
      nullable: false,
      default: "private"
    }
  },
  {
    kind: "add-column",
    table: "persona_memories",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "is_encrypted",
      type: "integer",
      nullable: false,
      default: 0
    }
  },
  {
    kind: "add-column",
    table: "persona_memories",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "owner_restricted",
      type: "integer",
      nullable: false,
      default: 0
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_persona_memories_sensitivity",
      table: "persona_memories",
      columns: [
        "tenant_id",
        "persona_id",
        "sensitivity",
        "created_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});
