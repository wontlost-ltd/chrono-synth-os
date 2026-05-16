import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import {
  RAW_MIGRATIONS,
  SERVER_SIMPLE_MIGRATIONS,
  PostgresRenderer,
  VERSION_MAP,
  type RenderedMigration,
} from '../../../packages/schema-dsl/src/index.js';
import { LEGACY_POSTGRES_MIGRATIONS } from './fixtures/legacy-migrations.js';

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
}

interface ConstraintRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly constraint_type: string;
  readonly columns: string | null;
  readonly definition: string;
}

interface IndexRow {
  readonly tablename: string;
  readonly indexname: string;
  readonly indexdef: string;
}

interface PgSchemaDump {
  readonly columns: readonly ColumnRow[];
  readonly constraints: readonly ConstraintRow[];
  readonly indexes: readonly IndexRow[];
}

function renderDslPostgresMigrations(): readonly RenderedMigration[] {
  const renderer = new PostgresRenderer();
  const migrationsByVersion = new Map<string, RenderedMigration>();

  for (const migration of [...SERVER_SIMPLE_MIGRATIONS, ...RAW_MIGRATIONS]) {
    const rendered = renderer.renderMigration(migration, { target: 'postgres' });
    if (rendered) migrationsByVersion.set(rendered.version, rendered);
  }

  return VERSION_MAP
    .filter(entry => entry.classification !== 'disabled')
    .map(entry => entry.aliases.postgres)
    .filter((version): version is string => version !== undefined)
    .map(version => {
      const migration = migrationsByVersion.get(version);
      if (!migration) throw new Error(`Missing rendered PostgreSQL DSL migration ${version}`);
      return migration;
    });
}

async function runSqlMigrations(client: Client, migrations: readonly { readonly sql: readonly string[] }[]): Promise<void> {
  for (const migration of migrations) {
    for (const sql of migration.sql) {
      await client.query(sql);
    }
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
  const columns = await client.query<ColumnRow>(`
    SELECT
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name <> 'schema_migrations'
    ORDER BY table_name, ordinal_position
  `);

  const constraints = await client.query<ConstraintRow>(`
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
      AND rel.relname <> 'schema_migrations'
    GROUP BY rel.relname, con.conname, con.contype, con.oid
    ORDER BY rel.relname, con.conname
  `);

  const indexes = await client.query<IndexRow>(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename <> 'schema_migrations'
    ORDER BY tablename, indexname
  `);

  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  };
}

describe('schema-dsl PostgreSQL migration parity', () => {
  let container: StartedPostgreSqlContainer;
  const startedAt = Date.now();

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

  it('renders executable PostgreSQL SQL equivalent to the legacy migration schema', async () => {
    const renderedDslMigrations = renderDslPostgresMigrations();
    assert.deepEqual(
      renderedDslMigrations.map(migration => migration.version),
      LEGACY_POSTGRES_MIGRATIONS.map(migration => migration.version),
    );

    await withClient(container.getConnectionUri(), async adminClient => {
      await createDatabase(adminClient, 'schema_old');
      await createDatabase(adminClient, 'schema_new');
    });

    const oldDump = await withClient(connectionUriForDatabase(container, 'schema_old'), async client => {
      await runSqlMigrations(client, LEGACY_POSTGRES_MIGRATIONS);
      return dumpPgSchema(client);
    });

    const newDump = await withClient(connectionUriForDatabase(container, 'schema_new'), async client => {
      await runSqlMigrations(client, renderedDslMigrations);
      return dumpPgSchema(client);
    });

    assert.deepEqual(newDump, oldDump);
    assert.ok(Date.now() - startedAt < 60_000, 'PG parity test exceeded 60s startup/execution budget');
  });
});
