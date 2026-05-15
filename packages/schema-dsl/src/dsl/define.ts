import type { RawMigration, SchemaMigration } from '../types.js';

export function defineMigration(migration: SchemaMigration): SchemaMigration {
  return migration;
}

export function defineRawMigration(migration: RawMigration): RawMigration {
  return migration;
}
