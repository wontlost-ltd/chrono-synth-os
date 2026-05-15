import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { setupPgDatabases, type PgDatabaseSetup } from './_setup-pg-databases.js';

const PG_NETWORK_ALIAS = 'pg';
const ATLAS_IMAGE = 'arigaio/atlas:latest-community-alpine';

describe('schema-dsl Atlas PG diff', () => {
  let network: StartedNetwork;
  let pgContainer: StartedPostgreSqlContainer;
  let databases: PgDatabaseSetup;

  before(async () => {
    network = await new Network().start();
    pgContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('test')
      .withUsername('test')
      .withPassword('test')
      .withNetwork(network)
      .withNetworkAliases(PG_NETWORK_ALIAS)
      .withStartupTimeout(60_000)
      .start();

    databases = await setupPgDatabases(pgContainer, { networkAlias: PG_NETWORK_ALIAS });
  });

  after(async () => {
    await pgContainer?.stop();
    await network?.stop();
  });

  it('reports no Atlas schema diff between legacy and DSL PostgreSQL schemas', async () => {
    assert.deepEqual(databases.dslVersions, databases.legacyVersions);

    const oldInspect = await runAtlas(['schema', 'inspect', '--url', databases.oldUrl]);
    const newInspect = await runAtlas(['schema', 'inspect', '--url', databases.newUrl]);
    assert.match(oldInspect.trim(), /table "memory_nodes"/);
    assert.match(newInspect.trim(), /table "memory_nodes"/);

    const diff = await runAtlas(['schema', 'diff', '--from', databases.oldUrl, '--to', databases.newUrl]);
    // The community-edition image prepends a "Notice: ..." block to stdout before any
    // real output. Filter to the substantive trailing line and assert the synced marker.
    const meaningfulLines = diff
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('Notice:') && !line.startsWith('\t') && !line.startsWith('To ') && !line.startsWith('Or,') && !line.startsWith('curl ') && !line.startsWith('https://'));
    const lastMeaningful = meaningfulLines[meaningfulLines.length - 1] ?? '';
    // Atlas prints "Schemas are synced, no changes to be made." when there is no drift.
    // Any other content means real schema divergence — fail loudly with the full output.
    assert.equal(
      lastMeaningful,
      'Schemas are synced, no changes to be made.',
      `Atlas diff produced unexpected output:\n${diff}`,
    );
  });

  async function runAtlas(command: readonly string[]): Promise<string> {
    let atlas: StartedTestContainer | undefined;
    try {
      atlas = await new GenericContainer(ATLAS_IMAGE)
        .withNetwork(network)
        .withCommand([...command])
        .withWaitStrategy(Wait.forOneShotStartup())
        .withStartupTimeout(60_000)
        .start();

      return await collectLogs(atlas);
    } finally {
      await atlas?.stop();
    }
  }
});

async function collectLogs(container: StartedTestContainer): Promise<string> {
  const stream = await container.logs();
  let output = '';

  await new Promise<void>((resolve, reject) => {
    stream.on('data', chunk => {
      output += chunk.toString();
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return output;
}
