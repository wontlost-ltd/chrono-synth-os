import type { Column, Index, Migration, RenderContext, RenderedMigration, Renderer, SchemaOperation, Table } from '../types.js';
import { SqliteSqlRenderer } from './sqlite-sql.js';

export class SqliteRustRenderer implements Renderer<'sqlite-rust'> {
  public readonly target = 'sqlite-rust' as const;
  private readonly inner = new SqliteSqlRenderer();

  renderMigration(migration: Migration, context?: RenderContext): RenderedMigration | null {
    if (migration.disabled && context?.includeDisabled !== true) return null;
    const version = migration.aliases['sqlite-rust'];
    if (!version) return null;

    if (migration.kind === 'raw') {
      const sql = migration.sqliteRust ?? migration.sqlite;
      if (!sql) return null;
      if ((sql.disabled || migration.disabled) && context?.includeDisabled !== true) return null;
      return {
        version,
        description: migration.description,
        sql: sql.sql,
        disabled: migration.disabled || sql.disabled || undefined,
      };
    }

    const innerResult = this.inner.renderMigration({
      ...migration,
      aliases: { ...migration.aliases, 'sqlite-sql': version },
    }, {
      target: 'sqlite-sql',
      includeDisabled: context?.includeDisabled,
    });
    if (!innerResult) return null;
    return {
      version,
      description: migration.description,
      sql: innerResult.sql,
    };
  }

  renderOperation(operation: SchemaOperation): string[] { return this.inner.renderOperation(operation); }
  renderColumn(column: Column): string { return this.inner.renderColumn(column); }
  renderTable(table: Table): string { return this.inner.renderTable(table); }
  renderIndex(index: Index): string { return this.inner.renderIndex(index); }
}

export function renderToRust(migration: Migration, context?: Omit<RenderContext, 'target'>): readonly string[] {
  return new SqliteRustRenderer().renderMigration(migration, { target: 'sqlite-rust', ...context })?.sql ?? [];
}
