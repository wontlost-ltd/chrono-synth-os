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
    // Atlas 在「无差异」时打印 "Schemas are synced, no changes to be made."。社区版镜像还会输出一段
    // 多行 "Notice: ..." 版权/升级提示——且该提示可能出现在 synced 标记**之后**，其续行（如
    // "triggers, and stored procedures are not supported. ..."）不以 Notice:/tab/To/Or,/curl/https 开头，
    // 会逃过行过滤。故**不能**用「最后一条有意义行 === synced」判定（会误取 Notice 续行）；改为断言
    // synced 标记**存在于输出中**——它只在零 schema drift 时打印，真有差异则不会出现（diff 会列出 DDL）。
    const SYNCED = 'Schemas are synced, no changes to be made.';
    const lines = diff.split('\n').map(line => line.trim());
    assert.ok(
      lines.includes(SYNCED),
      `Atlas diff 未报告 schema 同步（疑有真实结构差异）:\n${diff}`,
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
