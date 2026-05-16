import type {
  Column,
  ColumnType,
  Index,
  Migration,
  RenderContext,
  RenderedMigration,
  Renderer,
  SchemaOperation,
  Table,
  TableConstraint,
} from '../types.js';

export class SqliteSqlRenderer implements Renderer<'sqlite-sql'> {
  public readonly target = 'sqlite-sql' as const;

  renderMigration(migration: Migration, context?: RenderContext): RenderedMigration | null {
    if (migration.disabled && context?.includeDisabled !== true) return null;
    if (migration.kind === 'raw') {
      const sql = migration.sqlite;
      if (!sql) return null;
      if ((sql.disabled || migration.disabled) && context?.includeDisabled !== true) return null;
      const version = migration.aliases['sqlite-sql'];
      if (!version) return null;
      return {
        version,
        description: migration.description,
        sql: sql.sql,
        disabled: migration.disabled || sql.disabled || undefined,
      };
    }
    const version = migration.aliases['sqlite-sql'];
    if (!version) return null;
    return {
      version,
      description: migration.description,
      sql: migration.operations.flatMap(operation => this.renderOperation(operation)),
    };
  }

  renderOperation(operation: SchemaOperation): string[] {
    if (operation.kind === 'create-table') return [this.renderTable(operation.table)];
    if (operation.kind === 'create-index') return [this.renderIndex(operation.index)];
    if (operation.kind === 'add-column') {
      return [`ALTER TABLE ${operation.table} ADD COLUMN ${this.renderColumn(operation.column)}`];
    }
    if (operation.kind === 'drop-table') {
      return [`DROP TABLE${operation.ifExists ? ' IF EXISTS' : ''} ${operation.table}`];
    }
    if (operation.kind === 'rename-table') {
      return [`ALTER TABLE ${operation.from} RENAME TO ${operation.to}`];
    }
    return exhaustive(operation);
  }

  renderColumn(column: Column): string {
    const parts = [column.name, renderType(column)];
    if (column.primaryKey) parts.push('PRIMARY KEY');
    if (column.autoIncrement) parts.push('AUTOINCREMENT');
    if (column.unique) parts.push('UNIQUE');
    if (column.nullable === false) parts.push('NOT NULL');
    if (column.default !== undefined) parts.push(`DEFAULT ${renderDefault(column.default)}`);
    if (column.check) parts.push(`CHECK(${column.check})`);
    if (column.references) {
      parts.push(`REFERENCES ${column.references.table}${column.references.column ? `(${column.references.column})` : ''}`);
      if (column.references.onDelete) parts.push(`ON DELETE ${column.references.onDelete}`);
    }
    return parts.join(' ');
  }

  renderTable(table: Table): string {
    const entries = [
      ...table.columns.map(column => `    ${this.renderColumn(column)}`),
      ...(table.constraints ?? []).map(constraint => `    ${renderTableConstraint(constraint)}`),
    ];
    return `CREATE TABLE${table.ifNotExists ? ' IF NOT EXISTS' : ''} ${table.name} (\n${entries.join(',\n')}\n  )`;
  }

  renderIndex(index: Index): string {
    if (index.method && index.method !== 'btree') throw new Error(`${index.method} indexes are not supported by sqlite-sql`);
    const unique = index.unique ? 'UNIQUE ' : '';
    const ifNotExists = index.ifNotExists ? ' IF NOT EXISTS' : '';
    const columns = index.columns.join(', ');
    const where = index.where ? ` WHERE ${index.where}` : '';
    return `CREATE ${unique}INDEX${ifNotExists} ${index.name} ON ${index.table}(${columns})${where}`;
  }
}

function renderType(column: Column): string {
  if (column.type === 'boolean') return 'INTEGER';
  if (column.type === 'vector') throw new Error(`vector type is not supported by sqlite-sql column ${column.name}`);
  return typeMap[column.type];
}

const typeMap: Record<Exclude<ColumnType, 'boolean' | 'vector'>, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  bigint: 'INTEGER',
  real: 'REAL',
  double: 'REAL',
  timestamp: 'INTEGER',
};

function renderDefault(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return value;
  return `'${value.replaceAll("'", "''")}'`;
}

function renderTableConstraint(constraint: TableConstraint): string {
  const prefix = constraint.name ? `CONSTRAINT ${constraint.name} ` : '';
  if (constraint.kind === 'primary-key') return `${prefix}PRIMARY KEY (${(constraint.columns ?? []).join(', ')})`;
  if (constraint.kind === 'unique') return `${prefix}UNIQUE(${(constraint.columns ?? []).join(', ')})`;
  if (constraint.kind === 'check') return `${prefix}CHECK(${constraint.expression ?? ''})`;
  if (constraint.kind === 'foreign-key') {
    const refs = constraint.references;
    if (!refs) throw new Error('foreign-key table constraint requires references');
    return `${prefix}FOREIGN KEY (${(constraint.columns ?? []).join(', ')}) REFERENCES ${refs.table}${refs.column ? `(${refs.column})` : ''}`;
  }
  return exhaustive(constraint.kind);
}

function exhaustive(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}

export function renderToSqlite(migration: Migration, context?: Omit<RenderContext, 'target'>): readonly string[] {
  return new SqliteSqlRenderer().renderMigration(migration, { target: 'sqlite-sql', ...context })?.sql ?? [];
}
