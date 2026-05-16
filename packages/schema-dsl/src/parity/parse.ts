import PgQuery from 'pg-query-emscripten';
import sqlParser from 'node-sql-parser';

export type Dialect = 'postgres' | 'sqlite';

export interface ParsedStatement {
  readonly dialect: Dialect;
  readonly ast: unknown;
  readonly sourceSql: string;
}

export interface ParseResult {
  readonly statements: readonly ParsedStatement[];
}

export class ParseError extends Error {
  readonly sql: string;
  readonly dialect: Dialect;
  readonly position?: unknown;

  constructor(message: string, options: { readonly sql: string; readonly dialect: Dialect; readonly position?: unknown }) {
    super(message);
    this.name = 'ParseError';
    this.sql = options.sql;
    this.dialect = options.dialect;
    this.position = options.position;
  }
}

interface PgParser {
  readonly parse: (sql: string) => {
    readonly parse_tree?: { readonly stmts?: readonly unknown[] };
    readonly error?: { readonly message?: string } | string | null;
    readonly stderr_buffer?: string;
  };
}

const { Parser } = sqlParser;
const sqliteParser = new Parser();
let pgParserPromise: Promise<PgParser> | undefined;
let pgParseCount = 0;

// pg-query-emscripten WASM instance accumulates internal state that, after
// roughly 300+ parse() calls, leads to "Infinity" thrown values and corrupted
// scanner state. Rebuild the instance periodically to keep it healthy.
// Threshold chosen conservatively below the observed failure point.
const PG_PARSE_REBUILD_THRESHOLD = 200;

export async function parseSql(sql: readonly string[], dialect: Dialect): Promise<ParseResult> {
  const statements: ParsedStatement[] = [];
  for (const block of sql) {
    const sanitized = stripSqlComments(block);
    if (!sanitized) continue;
    if (dialect === 'postgres') {
      statements.push(...await parsePostgres(sanitized));
    } else {
      statements.push(...parseSqlite(sanitized));
    }
  }
  return { statements };
}

function getPgParser(): Promise<PgParser> {
  if (pgParserPromise === undefined || pgParseCount >= PG_PARSE_REBUILD_THRESHOLD) {
    pgParserPromise = PgQuery() as Promise<PgParser>;
    pgParseCount = 0;
  }
  return pgParserPromise;
}

async function parsePostgres(sql: string): Promise<readonly ParsedStatement[]> {
  const parser = await getPgParser();
  pgParseCount += 1;
  let result: ReturnType<PgParser['parse']>;
  try {
    result = parser.parse(sql);
  } catch (rawError) {
    // WASM-level corruption surfaces as thrown non-Error values (e.g. Infinity,
    // TypeError on internal heap pointers). Force a rebuild on next call.
    pgParserPromise = undefined;
    pgParseCount = 0;
    const message = rawError instanceof Error ? rawError.message : `WASM parser corrupted: ${String(rawError)}`;
    throw new ParseError(message, { sql, dialect: 'postgres' });
  }
  if (result.error) {
    const message = typeof result.error === 'string' ? result.error : result.error.message ?? 'PostgreSQL parse failed';
    throw new ParseError(message, { sql, dialect: 'postgres', position: result.stderr_buffer });
  }
  return (result.parse_tree?.stmts ?? []).map(ast => ({ dialect: 'postgres' as const, ast, sourceSql: sql }));
}

function parseSqlite(sql: string): readonly ParsedStatement[] {
  try {
    const ast = sqliteParser.astify(sql, { database: 'sqlite' }) as unknown;
    const nodes = Array.isArray(ast) ? ast : [ast];
    return nodes.map(node => ({ dialect: 'sqlite' as const, ast: node, sourceSql: sql }));
  } catch (error) {
    throw new ParseError(error instanceof Error ? error.message : 'SQLite parse failed', {
      sql,
      dialect: 'sqlite',
      position: error,
    });
  }
}

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*\s*safe:[\s\S]*?\*\//g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .trim();
}
