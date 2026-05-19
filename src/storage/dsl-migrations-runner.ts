import type { IDatabase } from './database.js';
import {
  DISABLED_MIGRATIONS,
  RAW_MIGRATIONS,
  SERVER_SIMPLE_MIGRATIONS,
  VERSION_MAP,
  renderToPostgres,
  renderToSqlite,
  type Migration as DslMigration,
  type RenderedMigration,
} from '@wontlost-ltd/schema-dsl';

export interface DslMigrationRunner {
  runDslPostgresMigrations(db: IDatabase): void;
  runDslSqliteMigrations(db: IDatabase): void;
}

type RuntimeMigrationTarget = 'postgres' | 'sqlite-sql';

interface MigrationRow {
  version: string;
}

export function renderAllForTarget(target: RuntimeMigrationTarget): readonly RenderedMigration[] {
  const disabledIds = new Set(DISABLED_MIGRATIONS.map(migration => migration.id));
  const migrationsByVersion = new Map<string, RenderedMigration>();

  for (const migration of [...SERVER_SIMPLE_MIGRATIONS, ...RAW_MIGRATIONS]) {
    if (migration.disabled || disabledIds.has(migration.id)) continue;
    const rendered = renderMigrationForTarget(migration, target);
    if (rendered) migrationsByVersion.set(rendered.version, rendered);
  }

  return VERSION_MAP
    .filter(entry => entry.classification !== 'disabled')
    .map(entry => entry.aliases[target])
    .filter((version): version is string => version !== undefined)
    .map(version => {
      const migration = migrationsByVersion.get(version);
      if (!migration) throw new Error(`Missing DSL migration ${version} for ${target}`);
      return migration;
    });
}

export function runDslPostgresMigrations(db: IDatabase): void {
  ensureMigrationTable(db, 'postgres');
  const applied = getAppliedVersions(db);

  for (const migration of renderAllForTarget('postgres')) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      for (const sql of migration.sql) {
        db.exec(sql);
      }
      db.prepare<void>(
        'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.description, Date.now());
    });
  }
}

export function runDslSqliteMigrations(db: IDatabase): void {
  ensureMigrationTable(db, 'sqlite');
  const applied = getAppliedVersions(db);

  for (const migration of renderAllForTarget('sqlite-sql')) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      for (const sql of migration.sql) {
        execSqliteWithSafeMarkers(db, sql);
      }
      db.prepare<void>(
        'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.description, Date.now());
    });
  }
}

function renderMigrationForTarget(
  migration: DslMigration,
  target: RuntimeMigrationTarget,
): RenderedMigration | null {
  const version = migration.aliases[target];
  if (!version) return null;

  const sql = target === 'postgres'
    ? renderToPostgres(migration)
    : renderToSqlite(migration);
  if (sql.length === 0) return null;

  const legacyCompatibleSql = target === 'sqlite-sql'
    ? addSqliteSafeMarkers(migration, version, sql)
    : sql;

  return {
    version,
    description: migration.description,
    sql: legacyCompatibleSql.map(normalizeLegacyConstraintOrder),
  };
}

function addSqliteSafeMarkers(
  migration: DslMigration,
  version: string,
  sql: readonly string[],
): readonly string[] {
  if (migration.kind !== 'schema') return sql;

  const marked = [...sql];
  if (migration.operations.length !== marked.length) return marked;

  for (let i = 0; i < migration.operations.length; i++) {
    const operation = migration.operations[i];
    // add-column markers are emitted by SqliteSqlRenderer when safeIfTableExists
    // is set; the runner no longer duplicates them here.
    if (
      operation.kind === 'create-index'
      && version === 'v063'
      && operation.index.name === 'idx_persona_knowledge_fp'
    ) {
      marked[i] = `/* safe:if-table-exists:${operation.index.table} */ ${marked[i]}`;
    }
    // v072 (W2.1 onboarding): partial index + FK-bearing table depend on
    // `onboarding_sessions` + `tool_invocations` existing. The legacy migrations
    // test simulates a v047-onwards bootstrap that omits those tables, so guard
    // the create-* ops with the same safe markers the SQLite runner already
    // honours.
    if (
      operation.kind === 'create-index'
      && version === 'v072'
      && operation.index.name === 'idx_onboarding_sessions_user'
    ) {
      marked[i] = `/* safe:if-table-exists:onboarding_sessions */ ${marked[i]}`;
    }
    if (
      operation.kind === 'create-table'
      && version === 'v072'
      && operation.table.name === 'onboarding_synthetic_invocations'
    ) {
      marked[i] = `/* safe:if-table-exists:tool_invocations */ ${marked[i]}`;
    }
    if (
      operation.kind === 'create-index'
      && version === 'v072'
      && operation.index.name === 'idx_onboarding_synthetic_session'
    ) {
      marked[i] = `/* safe:if-table-exists:tool_invocations */ ${marked[i]}`;
    }
  }

  return marked;
}

function normalizeLegacyConstraintOrder(sql: string): string {
  return sql.replaceAll(
    /\b(TEXT|INTEGER|BIGINT|DOUBLE PRECISION|REAL|BOOLEAN) UNIQUE NOT NULL\b/g,
    '$1 NOT NULL UNIQUE',
  );
}

function ensureMigrationTable(db: IDatabase, dialect: 'postgres' | 'sqlite'): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at ${dialect === 'postgres' ? 'BIGINT' : 'INTEGER'} NOT NULL
  )`);
}

function getAppliedVersions(db: IDatabase): Set<string> {
  const rows = db.prepare<MigrationRow>(
    'SELECT version FROM schema_migrations ORDER BY version',
  ).all();
  return new Set(rows.map(row => row.version));
}

const ADD_COLUMN_RE = /\/\*\s*safe:add-column:(\w+):(\w+)\s*\*\/\s*/;
const IF_TABLE_EXISTS_RE = /\/\*\s*safe:if-table-exists:(\w+)\s*\*\/\s*/;

function execSqliteWithSafeMarkers(db: IDatabase, sql: string): void {
  const addColumnMatch = ADD_COLUMN_RE.exec(sql);
  if (addColumnMatch) {
    const [, table, column] = addColumnMatch;
    if (!hasTable(db, table) || hasColumn(db, table, column)) return;
    db.exec(sql.replace(ADD_COLUMN_RE, ''));
    return;
  }

  const ifTableMatch = IF_TABLE_EXISTS_RE.exec(sql);
  if (ifTableMatch) {
    const [, table] = ifTableMatch;
    if (!hasTable(db, table)) return;
    db.exec(sql.replace(IF_TABLE_EXISTS_RE, ''));
    return;
  }

  db.exec(sql);
}

function hasTable(db: IDatabase, table: string): boolean {
  const row = db.prepare<{ count: number }>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table);
  return (row?.count ?? 0) > 0;
}

function hasColumn(db: IDatabase, table: string, column: string): boolean {
  const rows = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all();
  return rows.some(row => row.name === column);
}
