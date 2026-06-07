import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { type IDatabase, type IPreparedStatement, type SqlValue } from '../../storage/database.js';
import { runDslPostgresMigrations, runDslSqliteMigrations } from '../../storage/dsl-migrations-runner.js';
import { PostgresDatabase } from '../../storage/postgres-database.js';
import { LEGACY_POSTGRES_MIGRATIONS, LEGACY_SQLITE_MIGRATIONS } from './fixtures/legacy-migrations.js';

interface PgColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
}

interface PgConstraintRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly constraint_type: string;
  readonly columns: string | null;
  readonly definition: string;
}

interface PgIndexRow {
  readonly tablename: string;
  readonly indexname: string;
  readonly indexdef: string;
}

interface PgMigrationRow {
  readonly version: string;
}

interface PgSchemaDump {
  readonly columns: readonly PgColumnRow[];
  readonly constraints: readonly PgConstraintRow[];
  readonly indexes: readonly PgIndexRow[];
  readonly migrations: readonly PgMigrationRow[];
}

interface SqliteSchemaRow {
  readonly name: string;
  readonly type: string;
}

interface SqliteTableColumnRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface SqliteForeignKeyRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
}

interface SqliteIndexRow {
  readonly seq: number;
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

interface SqliteIndexColumnRow {
  readonly seqno: number;
  readonly cid: number;
  readonly name: string;
}

interface SqliteMigrationRow {
  readonly version: string;
}

interface SqliteSchemaDump {
  readonly tables: readonly SqliteSchemaRow[];
  readonly columns: readonly {
    readonly table: string;
    readonly columns: readonly SqliteTableColumnRow[];
  }[];
  readonly foreignKeys: readonly {
    readonly table: string;
    readonly foreignKeys: readonly SqliteForeignKeyRow[];
  }[];
  readonly indexes: readonly {
    readonly table: string;
    readonly name: string;
    readonly unique: number;
    readonly origin: string;
    readonly partial: number;
    readonly columns: readonly SqliteIndexColumnRow[];
  }[];
  readonly migrations: readonly SqliteMigrationRow[];
}

class BetterSqliteDatabaseAdapter implements IDatabase {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: BetterSqliteDatabase) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare<T = unknown>(sql: string): IPreparedStatement<T> {
    const stmt = this.db.prepare<T>(sql);
    return {
      run: (...params: SqlValue[]) => stmt.run(...params),
      get: (...params: SqlValue[]) => stmt.get(...params),
      all: (...params: SqlValue[]) => stmt.all(...params),
    };
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  queryOne<TResult>(): TResult | null {
    throw new Error('queryOne is not used by migration runner tests');
  }

  queryMany<TResult>(): readonly TResult[] {
    throw new Error('queryMany is not used by migration runner tests');
  }

  execute(): never {
    throw new Error('execute is not used by migration runner tests');
  }
}

async function createDatabase(adminClient: Client, database: string): Promise<void> {
  await adminClient.query(`DROP DATABASE IF EXISTS ${database}`);
  await adminClient.query(`CREATE DATABASE ${database}`);
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function connectionUriForDatabase(container: StartedPostgreSqlContainer, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${database}`;
  return url.toString();
}

async function dumpPgSchema(client: Client): Promise<PgSchemaDump> {
  const columns = await client.query<PgColumnRow>(`
    SELECT
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  const constraints = await client.query<PgConstraintRow>(`
    SELECT
      rel.relname AS table_name,
      con.conname AS constraint_name,
      CASE con.contype
        WHEN 'c' THEN 'CHECK'
        WHEN 'f' THEN 'FOREIGN KEY'
        WHEN 'p' THEN 'PRIMARY KEY'
        WHEN 'u' THEN 'UNIQUE'
        ELSE con.contype::text
      END AS constraint_type,
      string_agg(att.attname, ',' ORDER BY key.ord) AS columns,
      pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    LEFT JOIN unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord) ON true
    LEFT JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key.attnum
    WHERE nsp.nspname = 'public'
    GROUP BY rel.relname, con.conname, con.contype, con.oid
    ORDER BY rel.relname, con.conname
  `);

  const indexes = await client.query<PgIndexRow>(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `);

  const migrations = await client.query<PgMigrationRow>(`
    SELECT version
    FROM schema_migrations
    ORDER BY version
  `);

  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    migrations: migrations.rows,
  };
}

function runWithPostgresDatabase(connectionString: string, fn: (db: PostgresDatabase) => void): void {
  const db = new PostgresDatabase(connectionString);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function runLegacyPostgresFixtureMigrations(connectionString: string): void {
  runWithPostgresDatabase(connectionString, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )`);

    for (const migration of LEGACY_POSTGRES_MIGRATIONS) {
      db.transaction(() => {
        for (const sql of migration.sql) {
          db.exec(sql);
        }
        db.prepare<void>(
          'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
        ).run(migration.version, migration.description, Date.now());
      });
    }
  });
}

function runLegacySqliteFixtureMigrations(db: BetterSqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  for (const migration of LEGACY_SQLITE_MIGRATIONS) {
    db.transaction(() => {
      for (const sql of migration.sql) {
        db.exec(sql);
      }
      db.prepare(
        'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.description, Date.now());
    })();
  }
}

function dumpSqliteSchema(db: BetterSqliteDatabase): SqliteSchemaDump {
  const tables = db.prepare<SqliteSchemaRow>(`
    SELECT name, type
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name, type
  `).all();
  const tableNames = tables.map(table => table.name);
  const columns = tableNames.map(table => ({
    table,
    columns: db.prepare<SqliteTableColumnRow>(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`).all(),
  }));
  const foreignKeys = tableNames.map(table => ({
    table,
    foreignKeys: db.prepare<SqliteForeignKeyRow>(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(table)})`).all(),
  }));
  const indexes = tableNames.flatMap(table => db
    .prepare<SqliteIndexRow>(`PRAGMA index_list(${quoteSqliteIdentifier(table)})`)
    .all()
    .map(index => ({
      table,
      name: index.origin === 'c' ? index.name : `${table}:${index.origin}:${index.seq}`,
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      columns: db.prepare<SqliteIndexColumnRow>(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`).all(),
    })))
    .sort((a, b) => `${a.table}:${a.name}`.localeCompare(`${b.table}:${b.name}`));
  const migrations = db.prepare<SqliteMigrationRow>(`
    SELECT version
    FROM schema_migrations
    ORDER BY version
  `).all();

  return { tables, columns, foreignKeys, indexes, migrations };
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

describe('DSL PostgreSQL migration runner roundtrip', () => {
  let container: StartedPostgreSqlContainer;

  before(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('test')
      .withUsername('test')
      .withPassword('test')
      .withStartupTimeout(60_000)
      .start();
  });

  after(async () => {
    await container?.stop();
  });

  it('runs the DSL PostgreSQL runner to the same schema as the legacy runner', async () => {
    await withClient(container.getConnectionUri(), async adminClient => {
      await createDatabase(adminClient, 'runner_old');
      await createDatabase(adminClient, 'runner_new');
    });

    const oldConnectionString = connectionUriForDatabase(container, 'runner_old');
    const newConnectionString = connectionUriForDatabase(container, 'runner_new');

    runLegacyPostgresFixtureMigrations(oldConnectionString);
    runWithPostgresDatabase(newConnectionString, runDslPostgresMigrations);

    const oldDump = await withClient(oldConnectionString, dumpPgSchema);
    const newDump = await withClient(newConnectionString, dumpPgSchema);

    assert.deepEqual(
      newDump.migrations.map(migration => migration.version),
      LEGACY_POSTGRES_MIGRATIONS.map(migration => migration.version),
    );
    assert.deepEqual(newDump, oldDump);
  });
});

describe('DSL SQLite migration runner roundtrip', () => {
  const sqliteDatabases: BetterSqliteDatabase[] = [];

  after(() => {
    for (const db of sqliteDatabases) db.close();
  });

  it('runs the DSL SQLite runner to the same schema as the legacy runner', () => {
    const oldDb = new Database(':memory:');
    const newDb = new Database(':memory:');
    sqliteDatabases.push(oldDb, newDb);

    runLegacySqliteFixtureMigrations(oldDb);
    runDslSqliteMigrations(new BetterSqliteDatabaseAdapter(newDb));

    const oldDump = dumpSqliteSchema(oldDb);
    const newDump = dumpSqliteSchema(newDb);

    assert.deepEqual(
      newDump.migrations.map(migration => migration.version),
      LEGACY_SQLITE_MIGRATIONS.map(migration => migration.version),
    );
    assert.deepEqual(newDump, oldDump);
  });
});
