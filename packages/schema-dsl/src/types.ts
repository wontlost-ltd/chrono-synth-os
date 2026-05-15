export type RendererTarget = 'postgres' | 'sqlite-sql' | 'sqlite-rust';

export type MigrationTarget = 'server' | 'desktop-only';

export type ColumnType =
  | 'text'
  | 'integer'
  | 'bigint'
  | 'real'
  | 'double'
  | 'boolean'
  | 'timestamp'
  | 'vector';

export interface CheckConstraint {
  readonly kind: 'check';
  readonly expression: string;
}

export interface ForeignKey {
  readonly table: string;
  readonly column?: string;
  readonly onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

export interface Column {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
  readonly autoIncrement?: boolean;
  readonly default?: string | number | boolean | null;
  readonly check?: string;
  readonly references?: ForeignKey;
  readonly vectorDimensions?: number;
  readonly comment?: string;
}

export interface TableConstraint {
  readonly name?: string;
  readonly kind: 'primary-key' | 'unique' | 'check' | 'foreign-key';
  readonly columns?: readonly string[];
  readonly expression?: string;
  readonly references?: ForeignKey;
}

export interface Table {
  readonly name: string;
  readonly ifNotExists?: boolean;
  readonly columns: readonly Column[];
  readonly constraints?: readonly TableConstraint[];
  readonly target?: MigrationTarget;
}

export interface Index {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly ifNotExists?: boolean;
  readonly where?: string;
  readonly method?: 'btree' | 'hnsw' | 'ivfflat';
  readonly opclass?: string;
  readonly with?: Readonly<Record<string, string | number | boolean>>;
  readonly target?: MigrationTarget;
}

export interface AddColumnOperation {
  readonly kind: 'add-column';
  readonly table: string;
  readonly column: Column;
  readonly ifNotExists?: boolean;
  readonly safeIfTableExists?: boolean;
}

export interface CreateTableOperation {
  readonly kind: 'create-table';
  readonly table: Table;
}

export interface CreateIndexOperation {
  readonly kind: 'create-index';
  readonly index: Index;
}

export interface DropTableOperation {
  readonly kind: 'drop-table';
  readonly table: string;
  readonly ifExists?: boolean;
}

export interface RenameTableOperation {
  readonly kind: 'rename-table';
  readonly from: string;
  readonly to: string;
}

export type SchemaOperation =
  | CreateTableOperation
  | CreateIndexOperation
  | AddColumnOperation
  | DropTableOperation
  | RenameTableOperation;

export interface SchemaMigration {
  readonly kind: 'schema';
  readonly id: string;
  readonly aliases: Partial<Record<RendererTarget, string>>;
  readonly description: string;
  readonly target?: MigrationTarget;
  readonly disabled?: boolean;
  readonly operations: readonly SchemaOperation[];
}

export interface RawDialectSql {
  readonly sql: readonly string[];
  readonly disabled?: boolean;
}

export interface RawMigration {
  readonly kind: 'raw';
  readonly id: string;
  readonly version: string;
  readonly aliases: Partial<Record<RendererTarget, string>>;
  readonly description: string;
  readonly postgres?: RawDialectSql;
  readonly sqlite?: RawDialectSql;
  readonly sqliteRust?: RawDialectSql;
  readonly target?: MigrationTarget;
  readonly disabled?: boolean;
  readonly reason: string;
}

export type Migration = SchemaMigration | RawMigration;

export interface RenderedMigration {
  readonly version: string;
  readonly description: string;
  readonly sql: readonly string[];
  readonly disabled?: boolean;
}

export interface RenderContext {
  readonly target: RendererTarget;
  readonly includeDisabled?: boolean;
}

export interface Renderer<TTarget extends RendererTarget = RendererTarget> {
  readonly target: TTarget;
  renderMigration(migration: Migration, context?: RenderContext): RenderedMigration | null;
  renderOperation(operation: SchemaOperation): string[];
  renderColumn(column: Column): string;
  renderTable(table: Table): string;
  renderIndex(index: Index): string;
}
