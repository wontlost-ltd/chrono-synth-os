import type { RawDialectSql, RawMigration, RendererTarget } from '../types.js';
import { defineRawMigration } from './define.js';

export interface DefineRawMigrationInput {
  readonly id: string;
  readonly version: string;
  readonly aliases: Partial<Record<RendererTarget, string>>;
  readonly description: string;
  readonly reason: string;
  readonly postgres?: RawDialectSql;
  readonly sqlite?: RawDialectSql;
  readonly sqliteRust?: RawDialectSql;
  readonly target?: RawMigration['target'];
  readonly disabled?: boolean;
}

export function rawSql(sql: readonly string[], disabled = false): RawDialectSql {
  return { sql, disabled };
}

export function defineRaw(input: DefineRawMigrationInput): RawMigration {
  return defineRawMigration({
    kind: 'raw',
    ...input,
  });
}
