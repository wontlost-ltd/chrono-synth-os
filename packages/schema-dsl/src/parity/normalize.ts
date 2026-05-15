/**
 * AST-based normalization for migration parity validation.
 *
 * Inputs: ParsedStatement (with parser-specific AST) + Migration (for typeHints).
 * Output: NormalizedStatement[] in canonical structure.
 *
 * For unknown AST node types, throws UnnormalizableDiff — the harness will
 * report the diff to the user. Do NOT silently fall back to string processing.
 */
import type { ColumnType, Migration, SchemaOperation } from '../types.js';
import type { ParseResult, ParsedStatement } from './parse.js';

type CanonicalColumnType =
  | 'text'
  | 'integer'
  | 'bigint'
  | 'real'
  | 'double'
  | 'boolean'
  | 'timestamp'
  | 'vector'
  | 'unknown';

interface CanonicalReference {
  readonly table: string;
  readonly column?: string;
  readonly onDelete?: string;
}

interface CanonicalColumn {
  readonly name: string;
  readonly type: CanonicalColumnType;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly autoIncrement: boolean;
  readonly default?: string;
  readonly check?: string;
  readonly references?: CanonicalReference;
}

interface CanonicalTableConstraint {
  readonly kind: 'primary-key' | 'unique' | 'check' | 'foreign-key';
  readonly columns?: readonly string[];
  readonly expression?: string;
  readonly references?: CanonicalReference;
}

interface CanonicalStatement {
  readonly kind: 'create-table' | 'create-index' | 'alter-table-add-column' | 'drop-table' | 'rename-table';
  readonly target: { readonly table: string; readonly index?: string };
  readonly ifNotExists?: boolean;
  readonly unique?: boolean;
  readonly method?: string;
  readonly columns?: readonly CanonicalColumn[];
  readonly constraints?: readonly CanonicalTableConstraint[];
  readonly indexedColumns?: readonly string[];
  readonly where?: string;
  readonly addedColumn?: CanonicalColumn;
  readonly renameTo?: string;
}

export interface NormalizedStatement {
  readonly canonical: string;
  readonly meta: { readonly kind: string; readonly name: string };
}

export class UnnormalizableDiff extends Error {
  readonly statement: ParsedStatement;

  constructor(message: string, statement: ParsedStatement) {
    super(message);
    this.name = 'UnnormalizableDiff';
    this.statement = statement;
  }
}

interface TypeHint {
  readonly type: ColumnType;
}

type TypeHints = ReadonlyMap<string, TypeHint>;
type RecordValue = Record<string, unknown>;

export function normalizeAst(result: ParseResult, migration: Migration): readonly NormalizedStatement[] {
  const typeHints = collectTypeHints(migration);
  return result.statements.map(statement => {
    const canonical = statement.dialect === 'postgres'
      ? normalizePgAst(statement, typeHints)
      : normalizeSqliteAst(statement, typeHints);
    return {
      canonical: stableStringify(canonical),
      meta: inferMeta(canonical),
    };
  });
}

function normalizePgAst(statement: ParsedStatement, typeHints: TypeHints): CanonicalStatement {
  const stmt = asRecord(asRecord(statement.ast, statement, 'PostgreSQL statement').stmt, statement, 'PostgreSQL stmt');
  if ('CreateStmt' in stmt) return normalizePgCreateTable(asRecord(stmt.CreateStmt, statement, 'CreateStmt'), statement, typeHints);
  if ('IndexStmt' in stmt) return normalizePgCreateIndex(asRecord(stmt.IndexStmt, statement, 'IndexStmt'), statement);
  if ('AlterTableStmt' in stmt) return normalizePgAlterTable(asRecord(stmt.AlterTableStmt, statement, 'AlterTableStmt'), statement, typeHints);
  if ('DropStmt' in stmt) return normalizePgDrop(stmt.DropStmt, statement);
  throw new UnnormalizableDiff(`Unsupported PostgreSQL AST node: ${Object.keys(stmt).join(', ')}`, statement);
}

function normalizeSqliteAst(statement: ParsedStatement, typeHints: TypeHints): CanonicalStatement {
  const ast = asRecord(statement.ast, statement, 'SQLite statement');
  const type = lowerString(ast.type);
  if (type === 'create' && lowerString(ast.keyword) === 'table') return normalizeSqliteCreateTable(ast, statement, typeHints);
  if (type === 'create' && lowerString(ast.keyword) === 'index') return normalizeSqliteCreateIndex(ast, statement);
  if (type === 'alter') return normalizeSqliteAlterTable(ast, statement, typeHints);
  if (type === 'drop' && lowerString(ast.keyword) === 'table') return normalizeSqliteDrop(ast, statement);
  throw new UnnormalizableDiff(`Unsupported SQLite AST node: ${String(ast.type)} ${String(ast.keyword)}`, statement);
}

function normalizePgCreateTable(create: RecordValue, statement: ParsedStatement, typeHints: TypeHints): CanonicalStatement {
  const table = pgRangeVarName(create.relation, statement);
  const columns: CanonicalColumn[] = [];
  const constraints: CanonicalTableConstraint[] = [];
  for (const entry of arrayOfRecords(create.tableElts, statement, 'CreateStmt.tableElts')) {
    if ('ColumnDef' in entry) columns.push(normalizePgColumn(table, asRecord(entry.ColumnDef, statement, 'ColumnDef'), statement, typeHints));
    else if ('Constraint' in entry) constraints.push(normalizePgTableConstraint(asRecord(entry.Constraint, statement, 'table Constraint'), statement));
    else throw new UnnormalizableDiff(`Unsupported PostgreSQL table element: ${Object.keys(entry).join(', ')}`, statement);
  }
  return {
    kind: 'create-table',
    target: { table },
    ifNotExists: Boolean(create.if_not_exists),
    columns,
    constraints,
  };
}

function normalizePgCreateIndex(index: RecordValue, statement: ParsedStatement): CanonicalStatement {
  const table = pgRangeVarName(index.relation, statement);
  return {
    kind: 'create-index',
    target: { table, index: normalizeIdentifier(requiredString(index.idxname, statement, 'IndexStmt.idxname')) },
    ifNotExists: Boolean(index.if_not_exists),
    unique: Boolean(index.unique),
    method: lowerString(index.accessMethod) || 'btree',
    indexedColumns: arrayOfRecords(index.indexParams, statement, 'IndexStmt.indexParams').map(param => {
      const elem = asRecord(param.IndexElem, statement, 'IndexElem');
      if (typeof elem.name !== 'string') throw new UnnormalizableDiff('Unsupported PostgreSQL expression index parameter', statement);
      return normalizeIdentifier(elem.name);
    }),
    where: index.whereClause ? normalizePgExpr(index.whereClause, statement) : undefined,
  };
}

function normalizePgAlterTable(alter: RecordValue, statement: ParsedStatement, typeHints: TypeHints): CanonicalStatement {
  const table = pgRangeVarName(alter.relation, statement);
  const commands = arrayOfRecords(alter.cmds, statement, 'AlterTableStmt.cmds');
  if (commands.length !== 1) throw new UnnormalizableDiff('Only one PostgreSQL ALTER TABLE command is supported', statement);
  const command = asRecord(commands[0]?.AlterTableCmd, statement, 'AlterTableCmd');
  if (command.subtype === 'AT_AddColumn') {
    const columnDef = asRecord(asRecord(command.def, statement, 'AlterTableCmd.def').ColumnDef, statement, 'ColumnDef');
    return {
      kind: 'alter-table-add-column',
      target: { table },
      ifNotExists: Boolean(command.missing_ok),
      addedColumn: normalizePgColumn(table, columnDef, statement, typeHints),
    };
  }
  throw new UnnormalizableDiff(`Unsupported PostgreSQL ALTER TABLE subtype: ${String(command.subtype)}`, statement);
}

function normalizePgDrop(drop: unknown, statement: ParsedStatement): CanonicalStatement {
  const dropStmt = asRecord(drop, statement, 'DropStmt');
  const objects = arrayOfRecords(dropStmt.objects, statement, 'DropStmt.objects');
  const first = objects[0];
  const names = first ? arrayOfRecords(first.List ? asRecord(first.List, statement, 'DropStmt.objects.List').items : [], statement, 'DropStmt.objects.items') : [];
  const table = names.length > 0 ? normalizeIdentifier(pgString(names[names.length - 1], statement)) : 'unknown';
  return { kind: 'drop-table', target: { table } };
}

function normalizePgColumn(
  table: string,
  column: RecordValue,
  statement: ParsedStatement,
  typeHints: TypeHints,
): CanonicalColumn {
  const name = normalizeIdentifier(requiredString(column.colname, statement, 'ColumnDef.colname'));
  const hint = typeHints.get(`${table}.${name}`);
  const constraints = arrayOfRecords(column.constraints, statement, 'ColumnDef.constraints', true);
  let primaryKey = false;
  let unique = false;
  let notNull = false;
  let defaultValue: string | undefined;
  let check: string | undefined;
  let references: CanonicalReference | undefined;

  for (const wrapper of constraints) {
    const constraint = asRecord(wrapper.Constraint, statement, 'ColumnDef.Constraint');
    switch (constraint.contype) {
      case 'CONSTR_PRIMARY':
        primaryKey = true;
        break;
      case 'CONSTR_UNIQUE':
        unique = true;
        break;
      case 'CONSTR_NOTNULL':
        notNull = true;
        break;
      case 'CONSTR_DEFAULT':
        defaultValue = normalizePgExpr(constraint.raw_expr, statement);
        break;
      case 'CONSTR_CHECK':
        check = normalizePgExpr(constraint.raw_expr, statement);
        break;
      case 'CONSTR_FOREIGN':
        references = normalizePgReference(constraint, statement);
        break;
      default:
        throw new UnnormalizableDiff(`Unsupported PostgreSQL column constraint: ${String(constraint.contype)}`, statement);
    }
  }

  const pgType = normalizePgType(column.typeName, hint, statement);
  return {
    name,
    type: pgType.type,
    nullable: !(notNull || primaryKey),
    primaryKey,
    unique,
    autoIncrement: pgType.autoIncrement,
    default: defaultValue,
    check,
    references,
  };
}

function normalizePgTableConstraint(constraint: RecordValue, statement: ParsedStatement): CanonicalTableConstraint {
  if (constraint.contype === 'CONSTR_PRIMARY') {
    return { kind: 'primary-key', columns: pgStringArray(constraint.keys, statement) };
  }
  if (constraint.contype === 'CONSTR_UNIQUE') {
    return { kind: 'unique', columns: pgStringArray(constraint.keys, statement) };
  }
  if (constraint.contype === 'CONSTR_CHECK') {
    return { kind: 'check', expression: normalizePgExpr(constraint.raw_expr, statement) };
  }
  if (constraint.contype === 'CONSTR_FOREIGN') {
    return {
      kind: 'foreign-key',
      columns: pgStringArray(constraint.fk_attrs, statement),
      references: normalizePgReference(constraint, statement),
    };
  }
  throw new UnnormalizableDiff(`Unsupported PostgreSQL table constraint: ${String(constraint.contype)}`, statement);
}

function normalizePgReference(constraint: RecordValue, statement: ParsedStatement): CanonicalReference {
  const table = pgRangeVarName(constraint.pktable, statement);
  const columns = pgStringArray(constraint.pk_attrs, statement, true);
  const onDelete = pgAction(constraint.fk_del_action);
  return {
    table,
    column: columns[0],
    onDelete,
  };
}

function normalizeSqliteCreateTable(ast: RecordValue, statement: ParsedStatement, typeHints: TypeHints): CanonicalStatement {
  const table = sqliteTableName(ast.table, statement);
  const columns: CanonicalColumn[] = [];
  const constraints: CanonicalTableConstraint[] = [];
  for (const definition of arrayOfRecords(ast.create_definitions, statement, 'create_definitions')) {
    if (definition.resource === 'column') columns.push(normalizeSqliteColumn(table, definition, statement, typeHints));
    else if (definition.resource === 'constraint') constraints.push(normalizeSqliteTableConstraint(definition, statement));
    else throw new UnnormalizableDiff(`Unsupported SQLite create definition: ${String(definition.resource)}`, statement);
  }
  return {
    kind: 'create-table',
    target: { table },
    ifNotExists: Boolean(ast.if_not_exists),
    columns,
    constraints,
  };
}

function normalizeSqliteCreateIndex(ast: RecordValue, statement: ParsedStatement): CanonicalStatement {
  const index = asRecord(ast.index, statement, 'create index.index');
  return {
    kind: 'create-index',
    target: {
      table: sqliteSingleTableName(ast.table, statement),
      index: normalizeIdentifier(requiredString(index.name, statement, 'create index.name')),
    },
    ifNotExists: Boolean(ast.if_not_exists),
    unique: lowerString(ast.index_type) === 'unique',
    method: 'btree',
    indexedColumns: arrayOfRecords(ast.index_columns, statement, 'index_columns').map(column => sqliteColumnRef(column, statement)),
    where: ast.where ? normalizeSqliteExpr(ast.where, statement) : undefined,
  };
}

function normalizeSqliteAlterTable(ast: RecordValue, statement: ParsedStatement, typeHints: TypeHints): CanonicalStatement {
  const table = sqliteTableName(ast.table, statement);
  const expr = arrayOfRecords(ast.expr, statement, 'alter.expr');
  if (expr.length !== 1) throw new UnnormalizableDiff('Only one SQLite ALTER TABLE command is supported', statement);
  const command = expr[0];
  if (command?.action === 'add' && command.resource === 'column') {
    return {
      kind: 'alter-table-add-column',
      target: { table },
      addedColumn: normalizeSqliteColumn(table, command, statement, typeHints),
    };
  }
  if (command?.action === 'rename' && command.resource === 'table') {
    return {
      kind: 'rename-table',
      target: { table },
      renameTo: normalizeIdentifier(requiredString(command.table, statement, 'rename table target')),
    };
  }
  throw new UnnormalizableDiff(`Unsupported SQLite ALTER TABLE action: ${String(command?.action)}`, statement);
}

function normalizeSqliteDrop(ast: RecordValue, statement: ParsedStatement): CanonicalStatement {
  return { kind: 'drop-table', target: { table: sqliteTableName(ast.name, statement) } };
}

function normalizeSqliteColumn(
  table: string,
  column: RecordValue,
  statement: ParsedStatement,
  typeHints: TypeHints,
): CanonicalColumn {
  const name = sqliteColumnRef(asRecord(column.column, statement, 'column.column'), statement);
  const hint = typeHints.get(`${table}.${name}`);
  const primaryKey = Boolean(column.primary_key);
  const unique = Boolean(column.unique);
  const notNull = Boolean(column.nullable && lowerString(asRecord(column.nullable, statement, 'nullable').type) === 'not null');
  const autoIncrement = Boolean(column.auto_increment);
  return {
    name,
    type: normalizeSqliteType(column.definition, hint, statement),
    nullable: !(notNull || primaryKey),
    primaryKey,
    unique,
    autoIncrement,
    default: column.default_val ? normalizeSqliteDefault(column.default_val, statement) : undefined,
    check: column.check ? normalizeSqliteCheck(column.check, statement) : undefined,
    references: column.reference_definition ? normalizeSqliteReference(column.reference_definition, statement) : undefined,
  };
}

function normalizeSqliteTableConstraint(definition: RecordValue, statement: ParsedStatement): CanonicalTableConstraint {
  const constraintType = lowerString(definition.constraint_type);
  if (constraintType === 'primary key') {
    return { kind: 'primary-key', columns: sqliteColumnRefs(definition.definition, statement) };
  }
  if (constraintType === 'unique') {
    return { kind: 'unique', columns: sqliteColumnRefs(definition.definition, statement) };
  }
  if (constraintType === 'check') {
    return { kind: 'check', expression: normalizeSqliteCheck(definition, statement) };
  }
  if (constraintType === 'foreign key') {
    return {
      kind: 'foreign-key',
      columns: sqliteColumnRefs(definition.definition, statement),
      references: definition.reference_definition ? normalizeSqliteReference(definition.reference_definition, statement) : undefined,
    };
  }
  throw new UnnormalizableDiff(`Unsupported SQLite table constraint: ${String(definition.constraint_type)}`, statement);
}

function normalizePgType(
  typeName: unknown,
  hint: TypeHint | undefined,
  statement: ParsedStatement,
): { readonly type: CanonicalColumnType; readonly autoIncrement: boolean } {
  const type = asRecord(typeName, statement, 'TypeName');
  const names = pgStringArray(type.names, statement, true);
  const pgType = names[names.length - 1] ?? 'unknown';
  const hinted = hint?.type;
  if (pgType === 'int8' && (hinted === 'bigint' || hinted === 'timestamp')) return { type: hinted, autoIncrement: false };
  if (pgType === 'float8' && (hinted === 'real' || hinted === 'double')) return { type: hinted, autoIncrement: false };
  if (pgType === 'bool' && hinted === 'boolean') return { type: 'boolean', autoIncrement: false };
  if (pgType === 'serial4' && (hinted === 'integer' || hinted === 'bigint')) return { type: hinted, autoIncrement: true };
  if (pgType === 'serial8' && (hinted === 'bigint' || hinted === 'timestamp')) return { type: hinted, autoIncrement: true };
  if (pgType === 'text') return { type: 'text', autoIncrement: false };
  if (pgType === 'int4') return { type: 'integer', autoIncrement: false };
  if (pgType === 'int8') return { type: 'bigint', autoIncrement: false };
  if (pgType === 'float8') return { type: 'double', autoIncrement: false };
  if (pgType === 'bool') return { type: 'boolean', autoIncrement: false };
  if (pgType === 'vector') return { type: 'vector', autoIncrement: false };
  if (pgType === 'serial4') return { type: 'integer', autoIncrement: true };
  if (pgType === 'serial8') return { type: 'bigint', autoIncrement: true };
  return { type: 'unknown', autoIncrement: false };
}

function normalizeSqliteType(typeDef: unknown, hint: TypeHint | undefined, statement: ParsedStatement): CanonicalColumnType {
  const def = asRecord(typeDef, statement, 'column.definition');
  const sqliteType = lowerString(def.dataType);

  // First infer the actual canonical type from the parser output. This is what
  // the legacy SQLite migration really wrote on disk.
  let actual: CanonicalColumnType;
  if (sqliteType === 'text') actual = 'text';
  else if (sqliteType === 'integer') actual = 'integer';
  else if (sqliteType === 'real') actual = 'real';
  else if (sqliteType === 'boolean') actual = 'boolean';
  else actual = 'unknown';

  // No hint: trust the parser output. Used when DSL has no matching column.
  if (!hint) return actual;

  // With a hint, cross-validate: the DSL declaration must be compatible with
  // what the parser actually saw. Mismatch indicates a real bug in the DSL
  // rewrite (e.g. declaring a TEXT column as bigint), so refuse to normalize.
  if (isCompatibleSqliteType(actual, hint.type)) return hint.type;
  throw new UnnormalizableDiff(
    `SQLite column type mismatch: parser saw ${sqliteType.toUpperCase()} but DSL declared ${hint.type}`,
    statement,
  );
}

function isCompatibleSqliteType(actual: CanonicalColumnType, hinted: CanonicalColumnType): boolean {
  if (actual === hinted) return true;
  // SQLite stores BIGINT, TIMESTAMP, and historical booleans as INTEGER.
  if (actual === 'integer' && (hinted === 'bigint' || hinted === 'timestamp' || hinted === 'boolean')) {
    return true;
  }
  // SQLite stores DOUBLE as REAL.
  if (actual === 'real' && hinted === 'double') return true;
  // SQLite parser sometimes recognizes BOOLEAN — accept it under boolean or integer hints.
  if (actual === 'boolean' && (hinted === 'boolean' || hinted === 'integer')) return true;
  return false;
}

function normalizePgExpr(expr: unknown, statement: ParsedStatement): string {
  const node = asRecord(expr, statement, 'PostgreSQL expression');
  if ('A_Const' in node) return normalizePgConst(asRecord(node.A_Const, statement, 'A_Const'), statement);
  if ('ColumnRef' in node) return pgColumnRef(asRecord(node.ColumnRef, statement, 'ColumnRef'), statement);
  if ('A_Expr' in node) {
    const aExpr = asRecord(node.A_Expr, statement, 'A_Expr');
    const op = pgOperator(aExpr.name, statement);
    if (aExpr.kind === 'AEXPR_IN') {
      return `${normalizePgExpr(aExpr.lexpr, statement)} in ${normalizePgExpr(aExpr.rexpr, statement)}`;
    }
    return `${normalizePgExpr(aExpr.lexpr, statement)} ${op} ${normalizePgExpr(aExpr.rexpr, statement)}`;
  }
  if ('BoolExpr' in node) {
    const boolExpr = asRecord(node.BoolExpr, statement, 'BoolExpr');
    const op = boolExpr.boolop === 'AND_EXPR' ? 'and' : boolExpr.boolop === 'OR_EXPR' ? 'or' : undefined;
    if (!op) throw new UnnormalizableDiff(`Unsupported PostgreSQL BoolExpr: ${String(boolExpr.boolop)}`, statement);
    return arrayOfRecords(boolExpr.args, statement, 'BoolExpr.args').map(arg => normalizePgExpr(arg, statement)).join(` ${op} `);
  }
  if ('List' in node) {
    const list = asRecord(node.List, statement, 'List');
    return `(${arrayOfRecords(list.items, statement, 'List.items').map(item => normalizePgExpr(item, statement)).join(', ')})`;
  }
  if ('NullTest' in node) {
    const nullTest = asRecord(node.NullTest, statement, 'NullTest');
    const op = nullTest.nulltesttype === 'IS_NOT_NULL' ? 'is not null' : nullTest.nulltesttype === 'IS_NULL' ? 'is null' : undefined;
    if (!op) throw new UnnormalizableDiff(`Unsupported PostgreSQL NullTest: ${String(nullTest.nulltesttype)}`, statement);
    return `${normalizePgExpr(nullTest.arg, statement)} ${op}`;
  }
  throw new UnnormalizableDiff(`Unsupported PostgreSQL expression node: ${Object.keys(node).join(', ')}`, statement);
}

function normalizePgConst(node: RecordValue, _statement: ParsedStatement): string {
  if ('sval' in node) return quoteString(requiredString(asRecord(node.sval as unknown as RecordValue, _statement, 'A_Const.sval').sval, _statement, 'A_Const.sval.sval'));
  if ('ival' in node) {
    const ival = asRecord(node.ival, _statement, 'A_Const.ival');
    return String(typeof ival.ival === 'number' ? ival.ival : 0);
  }
  if ('fval' in node) {
    const fval = asRecord(node.fval, _statement, 'A_Const.fval');
    return normalizeNumericString(requiredString(fval.fval, _statement, 'A_Const.fval.fval'));
  }
  if ('boolval' in node) {
    const boolval = asRecord(node.boolval, _statement, 'A_Const.boolval');
    return boolval.boolval ? 'true' : 'false';
  }
  if ('isnull' in node) return 'null';
  return 'unknown';
}

function normalizeSqliteDefault(defaultValue: unknown, statement: ParsedStatement): string {
  const wrapper = asRecord(defaultValue, statement, 'default_val');
  return normalizeSqliteExpr(wrapper.value, statement);
}

function normalizeSqliteCheck(check: unknown, statement: ParsedStatement): string {
  const wrapper = asRecord(check, statement, 'check');
  const definitions = Array.isArray(wrapper.definition) ? wrapper.definition : [wrapper.definition];
  return definitions.map(definition => normalizeSqliteExpr(definition, statement)).join(' and ');
}

function normalizeSqliteExpr(expr: unknown, statement: ParsedStatement): string {
  const node = asRecord(expr, statement, 'SQLite expression');
  const type = lowerString(node.type);
  if (type === 'column_ref') return sqliteColumnRef(node, statement);
  if (type === 'number') return normalizeNumericString(String(node.value));
  if (type === 'single_quote_string' || type === 'string') return quoteString(requiredString(node.value, statement, 'string.value'));
  if (type === 'null') return 'null';
  if (type === 'origin') return lowerString(node.value);
  if (type === 'binary_expr') {
    return `${normalizeSqliteExpr(node.left, statement)} ${lowerOperator(requiredString(node.operator, statement, 'binary_expr.operator'))} ${normalizeSqliteExpr(node.right, statement)}`;
  }
  if (type === 'expr_list') {
    return `(${arrayOfRecords(node.value, statement, 'expr_list.value').map(item => normalizeSqliteExpr(item, statement)).join(', ')})`;
  }
  throw new UnnormalizableDiff(`Unsupported SQLite expression node: ${String(node.type)}`, statement);
}

function normalizeSqliteReference(reference: unknown, statement: ParsedStatement): CanonicalReference {
  const ref = asRecord(reference, statement, 'reference_definition');
  const columns = sqliteColumnRefs(ref.definition, statement);
  const actions = arrayOfRecords(ref.on_action, statement, 'reference_definition.on_action', true);
  const onDelete = actions.find(action => lowerString(action.type) === 'on delete');
  return {
    table: sqliteTableName(ref.table, statement),
    column: columns[0],
    onDelete: onDelete ? normalizeSqliteExpr(onDelete.value, statement).toUpperCase() : undefined,
  };
}

function collectTypeHints(migration: Migration): TypeHints {
  const hints = new Map<string, TypeHint>();
  if (migration.kind !== 'schema') return hints;
  for (const operation of migration.operations) collectOperationHints(operation, hints);
  return hints;
}

function collectOperationHints(operation: SchemaOperation, hints: Map<string, TypeHint>): void {
  if (operation.kind === 'create-table') {
    for (const column of operation.table.columns) {
      hints.set(`${normalizeIdentifier(operation.table.name)}.${normalizeIdentifier(column.name)}`, { type: column.type });
    }
  }
  if (operation.kind === 'add-column') {
    hints.set(`${normalizeIdentifier(operation.table)}.${normalizeIdentifier(operation.column.name)}`, { type: operation.column.type });
  }
}

function inferMeta(canonical: CanonicalStatement): { readonly kind: string; readonly name: string } {
  return { kind: canonical.kind, name: canonical.target.index ?? canonical.target.table };
}

function pgRangeVarName(value: unknown, statement: ParsedStatement): string {
  const range = asRecord(value, statement, 'RangeVar');
  return normalizeIdentifier(requiredString(range.relname, statement, 'RangeVar.relname'));
}

function pgColumnRef(value: RecordValue, statement: ParsedStatement): string {
  const parts = pgStringArray(value.fields, statement);
  return normalizeIdentifier(parts[parts.length - 1] ?? 'unknown');
}

function pgOperator(value: unknown, statement: ParsedStatement): string {
  const operators = pgStringArray(value, statement);
  return lowerOperator(operators[operators.length - 1] ?? '');
}

function pgStringArray(value: unknown, statement: ParsedStatement, optional = false): readonly string[] {
  return arrayOfRecords(value, statement, 'PostgreSQL string array', optional).map(item => normalizeIdentifier(pgString(item, statement)));
}

function pgString(value: unknown, statement: ParsedStatement): string {
  const node = asRecord(value, statement, 'PostgreSQL String wrapper');
  const stringNode = asRecord(node.String, statement, 'PostgreSQL String');
  return requiredString(stringNode.sval, statement, 'String.sval');
}

function pgAction(action: unknown): string | undefined {
  if (action === 'c') return 'CASCADE';
  if (action === 'n') return 'SET NULL';
  if (action === 'r') return 'RESTRICT';
  if (action === 'a') return undefined;
  return undefined;
}

function sqliteTableName(value: unknown, statement: ParsedStatement): string {
  if (Array.isArray(value)) return sqliteSingleTableName(value[0], statement);
  return sqliteSingleTableName(value, statement);
}

function sqliteSingleTableName(value: unknown, statement: ParsedStatement): string {
  const table = asRecord(value, statement, 'SQLite table');
  return normalizeIdentifier(requiredString(table.table, statement, 'SQLite table.table'));
}

function sqliteColumnRefs(value: unknown, statement: ParsedStatement): readonly string[] {
  return arrayOfRecords(value, statement, 'SQLite column refs').map(ref => sqliteColumnRef(ref, statement));
}

function sqliteColumnRef(value: RecordValue, statement: ParsedStatement): string {
  if (value.type !== 'column_ref') throw new UnnormalizableDiff(`Expected SQLite column_ref, got ${String(value.type)}`, statement);
  return normalizeIdentifier(requiredString(value.column, statement, 'column_ref.column'));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => sortObjectKeys(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortObjectKeys(child);
    }
    return out as T;
  }
  return value;
}

function asRecord(value: unknown, statement: ParsedStatement, label: string): RecordValue {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as RecordValue;
  throw new UnnormalizableDiff(`Expected object for ${label}`, statement);
}

function arrayOfRecords(value: unknown, statement: ParsedStatement, label: string, optional = false): readonly RecordValue[] {
  if ((value === undefined || value === null) && optional) return [];
  if (!Array.isArray(value)) throw new UnnormalizableDiff(`Expected array for ${label}`, statement);
  return value.map(item => asRecord(item, statement, label));
}

function requiredString(value: unknown, statement: ParsedStatement, label: string): string {
  if (typeof value === 'string') return value;
  throw new UnnormalizableDiff(`Expected string for ${label}`, statement);
}

function normalizeIdentifier(value: string): string {
  return value.replace(/^["`]|["`]$/g, '').toLowerCase();
}

function lowerString(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function lowerOperator(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeNumericString(value: string): string {
  return value.replace(/\.0+$/, '');
}
