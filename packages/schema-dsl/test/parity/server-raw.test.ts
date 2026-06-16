import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DISABLED_MIGRATIONS, RAW_MIGRATIONS } from '../../src/migrations/server-raw/index.js';
import { PostgresRenderer, renderToPostgres } from '../../src/renderers/postgres.js';
import { renderToSqlite, SqliteSqlRenderer } from '../../src/renderers/sqlite-sql.js';
import type { RawMigration } from '../../src/types.js';

const BOTH_DIALECT_RAW = ['v007', 'v027', 'v030', 'v034', 'v040', 'v041', 'v047', 'v052'] as const;

describe('server-raw coverage', () => {
  it('covers PR3 raw migrations', () => {
    const rawVersions = RAW_MIGRATIONS
      .map(migration => migration.aliases.postgres ?? migration.aliases['sqlite-sql'])
      .sort();

    /* v090 = v088_distilled_artifacts_perception_source（pg-aliased v090，SQLite CHECK rebuild / PG alter
     * constraint，PR #119 加入但当时漏更新本覆盖列表——此处补齐，与 RAW_MIGRATIONS 实际一致）。 */
    assert.deepEqual(rawVersions, ['v007', 'v027', 'v030', 'v034', 'v040', 'v041', 'v047', 'v052', 'v071', 'v090']);
  });

  it('covers disabled raw migrations', () => {
    assert.deepEqual(DISABLED_MIGRATIONS.map(migration => migration.aliases.postgres), ['v072']);
    assert.equal(DISABLED_MIGRATIONS[0]?.disabled, true);
  });
});

describe('server-raw renderer behavior', () => {
  for (const version of BOTH_DIALECT_RAW) {
    it(`${version} renders postgres SQL`, () => {
      const migration = findRawByPostgresVersion(version);
      assert.ok(renderToPostgres(migration).length > 0);
    });

    it(`${version} renders sqlite SQL`, () => {
      const migration = findRawBySqliteVersion(version);
      assert.ok(renderToSqlite(migration).length > 0);
    });
  }

  it('v071_pg renders postgres SQL', () => {
    const migration = findRawByPostgresVersion('v071');
    assert.ok(renderToPostgres(migration).length > 0);
  });

  it('v071_pg is a sqlite no-op', () => {
    const migration = findRawByPostgresVersion('v071');
    assert.deepEqual(renderToSqlite(migration), []);
    assert.equal(new SqliteSqlRenderer().renderMigration(migration), null);
  });

  it('v072_pg disabled is omitted by default', () => {
    const migration = DISABLED_MIGRATIONS[0];
    assert.ok(migration);
    assert.deepEqual(renderToPostgres(migration), []);
    assert.equal(new PostgresRenderer().renderMigration(migration), null);
  });

  it('v072_pg disabled can render when explicitly included', () => {
    const migration = DISABLED_MIGRATIONS[0];
    assert.ok(migration);
    assert.ok(renderToPostgres(migration, { includeDisabled: true }).length > 0);
    const rendered = new PostgresRenderer().renderMigration(migration, {
      target: 'postgres',
      includeDisabled: true,
    });
    assert.equal(rendered?.disabled, true);
  });
});

function findRawByPostgresVersion(version: string): RawMigration {
  const migration = RAW_MIGRATIONS.find(item => item.aliases.postgres === version);
  assert.ok(migration, `missing raw postgres migration ${version}`);
  return migration;
}

function findRawBySqliteVersion(version: string): RawMigration {
  const migration = RAW_MIGRATIONS.find(item => item.aliases['sqlite-sql'] === version);
  assert.ok(migration, `missing raw sqlite migration ${version}`);
  return migration;
}
