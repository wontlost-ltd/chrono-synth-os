import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  RAW_MIGRATIONS,
  SERVER_SIMPLE_MIGRATIONS,
  SqliteSqlRenderer,
  VERSION_MAP,
  type RenderedMigration,
} from '../../../packages/schema-dsl/src/index.js';
import { LEGACY_SQLITE_MIGRATIONS } from './fixtures/legacy-migrations.js';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

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
}

function renderDslSqliteMigrations(): readonly RenderedMigration[] {
  const renderer = new SqliteSqlRenderer();
  const migrationsByVersion = new Map<string, RenderedMigration>();

  for (const migration of [...SERVER_SIMPLE_MIGRATIONS, ...RAW_MIGRATIONS]) {
    const rendered = renderer.renderMigration(migration, { target: 'sqlite-sql' });
    if (rendered) migrationsByVersion.set(rendered.version, rendered);
  }

  return VERSION_MAP
    .filter(entry => entry.classification !== 'disabled')
    .map(entry => entry.aliases['sqlite-sql'])
    .filter((version): version is string => version !== undefined)
    .map(version => {
      const migration = migrationsByVersion.get(version);
      if (!migration) throw new Error(`Missing rendered SQLite DSL migration ${version}`);
      return migration;
    });
}

function runDslSqliteMigrations(db: BetterSqliteDatabase): void {
  for (const migration of renderDslSqliteMigrations()) {
    for (const sql of migration.sql) {
      db.exec(sql);
    }
  }
}

function runLegacySqliteFixtureMigrations(db: BetterSqliteDatabase): void {
  for (const migration of LEGACY_SQLITE_MIGRATIONS) {
    for (const sql of migration.sql) {
      db.exec(sql);
    }
  }
}

function dumpSqliteSchema(db: BetterSqliteDatabase): SqliteSchemaDump {
  const tables = db.prepare<SqliteSchemaRow>(`
    SELECT name, type
    FROM sqlite_master
    WHERE type = 'table'
      AND name <> 'schema_migrations'
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

  return { tables, columns, foreignKeys, indexes };
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

describe('schema-dsl SQLite migration parity', () => {
  const opened: BetterSqliteDatabase[] = [];

  after(() => {
    for (const db of opened) db.close();
  });

  it('renders executable SQLite SQL equivalent to the legacy runner schema', () => {
    const oldDb = new Database(':memory:');
    const newDb = new Database(':memory:');
    opened.push(oldDb, newDb);

    runLegacySqliteFixtureMigrations(oldDb);
    runDslSqliteMigrations(newDb);

    assert.deepEqual(
      renderDslSqliteMigrations().map(migration => migration.version),
      LEGACY_SQLITE_MIGRATIONS.map(migration => migration.version),
    );
    assert.deepEqual(dumpSqliteSchema(newDb), dumpSqliteSchema(oldDb));
  });
});
