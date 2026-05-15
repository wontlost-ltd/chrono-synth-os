import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { renderAllForTarget } from '../../storage/dsl-migrations-runner.js';
import { LEGACY_POSTGRES_MIGRATIONS } from './fixtures/legacy-migrations.js';

interface SqlMigration {
  readonly version: string;
  readonly sql: readonly string[];
}

export interface PgDatabaseSetup {
  readonly oldUrl: string;
  readonly newUrl: string;
  readonly legacyVersions: readonly string[];
  readonly dslVersions: readonly string[];
}

export async function setupPgDatabases(
  pgContainer: StartedPostgreSqlContainer,
  options: { readonly networkAlias?: string } = {},
): Promise<PgDatabaseSetup> {
  const networkAlias = options.networkAlias ?? 'pg';
  const dslMigrations = renderAllForTarget('postgres');

  await withClient(pgContainer.getConnectionUri(), async adminClient => {
    await createDatabase(adminClient, 'schema_old');
    await createDatabase(adminClient, 'schema_new');
  });

  await withClient(connectionUriForDatabase(pgContainer, 'schema_old'), async client => {
    await runSqlMigrations(client, LEGACY_POSTGRES_MIGRATIONS);
  });

  await withClient(connectionUriForDatabase(pgContainer, 'schema_new'), async client => {
    await runSqlMigrations(client, dslMigrations);
  });

  return {
    oldUrl: containerNetworkUriForDatabase(pgContainer, networkAlias, 'schema_old'),
    newUrl: containerNetworkUriForDatabase(pgContainer, networkAlias, 'schema_new'),
    legacyVersions: LEGACY_POSTGRES_MIGRATIONS.map(migration => migration.version),
    dslVersions: dslMigrations.map(migration => migration.version),
  };
}

async function runSqlMigrations(client: Client, migrations: readonly SqlMigration[]): Promise<void> {
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

function containerNetworkUriForDatabase(
  container: StartedPostgreSqlContainer,
  networkAlias: string,
  database: string,
): string {
  const url = new URL(container.getConnectionUri());
  url.hostname = networkAlias;
  url.port = '5432';
  url.pathname = `/${database}`;
  url.searchParams.set('sslmode', 'disable');
  return url.toString();
}
