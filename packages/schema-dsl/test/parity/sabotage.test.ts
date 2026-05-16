import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineMigration, type Migration } from '../../src/index.js';
import { renderToPostgres } from '../../src/renderers/postgres.js';
import { renderToSqlite } from '../../src/renderers/sqlite-sql.js';
import { checkParity } from './harness.js';

describe('AST parity sabotage self-checks', () => {
  it('fails when a column type changes', async () => {
    const migration = defineMigration({
      kind: 'schema',
      id: 'sabotage-type',
      aliases: { postgres: 'v999' },
      description: 'sabotage type mismatch',
      operations: [
        { kind: 'create-table', table: { name: 'sabotage_type', ifNotExists: true, columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'amount', type: 'integer' },
        ] } },
      ],
    });

    const result = await checkParity({
      oldSql: ['CREATE TABLE IF NOT EXISTS sabotage_type (id TEXT PRIMARY KEY, amount BIGINT)'],
      newSql: renderToPostgres(migration),
      dialect: 'postgres',
      dslMigration: migration,
    });

    assert.equal(result.pass, false);
    assert.equal(result.diffs.length, 1);
  });

  it('fails when a CHECK expression changes', async () => {
    const migration = defineMigration({
      kind: 'schema',
      id: 'sabotage-check',
      aliases: { postgres: 'v999' },
      description: 'sabotage check mismatch',
      operations: [
        { kind: 'create-table', table: { name: 'sabotage_check', ifNotExists: true, columns: [
          { name: 'score', type: 'integer', check: 'score > 0' },
        ] } },
      ],
    });

    const result = await checkParity({
      oldSql: ['CREATE TABLE IF NOT EXISTS sabotage_check (score INTEGER CHECK(score >= 0))'],
      newSql: renderToPostgres(migration),
      dialect: 'postgres',
      dslMigration: migration,
    });

    assert.equal(result.pass, false);
    assert.equal(result.diffs.length, 1);
  });

  it('fails when column order changes', async () => {
    const migration = defineMigration({
      kind: 'schema',
      id: 'sabotage-order',
      aliases: { postgres: 'v999' },
      description: 'sabotage column order mismatch',
      operations: [
        { kind: 'create-table', table: { name: 'sabotage_order', ifNotExists: true, columns: [
          { name: 'b', type: 'text' },
          { name: 'a', type: 'text' },
        ] } },
      ],
    });

    const result = await checkParity({
      oldSql: ['CREATE TABLE IF NOT EXISTS sabotage_order (a TEXT, b TEXT)'],
      newSql: renderToPostgres(migration),
      dialect: 'postgres',
      dslMigration: migration,
    });

    assert.equal(result.pass, false);
    assert.equal(result.diffs.length, 1);
  });

  it('fails when nullable semantics change', async () => {
    const migration = defineMigration({
      kind: 'schema',
      id: 'sabotage-nullable',
      aliases: { postgres: 'v999' },
      description: 'sabotage nullable mismatch',
      operations: [
        { kind: 'create-table', table: { name: 'sabotage_nullable', ifNotExists: true, columns: [
          { name: 'amount', type: 'bigint', nullable: false },
        ] } },
      ],
    });

    const result = await checkParity({
      oldSql: ['CREATE TABLE IF NOT EXISTS sabotage_nullable (amount BIGINT)'],
      newSql: renderToPostgres(migration),
      dialect: 'postgres',
      dslMigration: migration,
    });

    assert.equal(result.pass, false);
    assert.equal(result.diffs.length, 1);
  });

  it('normalizes CHECK whitespace but fails changed CHECK semantics', async () => {
    const sameMigration = checkMigration('a > b');
    const sameResult = await checkParity({
      oldSql: ['CREATE TABLE IF NOT EXISTS sabotage_check_space (a INTEGER, b INTEGER, CHECK (a > b))'],
      newSql: renderToPostgres(sameMigration),
      dialect: 'postgres',
      dslMigration: sameMigration,
    });

    assert.equal(sameResult.pass, true);
    assert.deepEqual(sameResult.diffs, []);

    const changedMigration = checkMigration('b > a');
    const changedResult = await checkParity({
      oldSql: ['CREATE TABLE IF NOT EXISTS sabotage_check_space (a INTEGER, b INTEGER, CHECK ( a > b ))'],
      newSql: renderToPostgres(changedMigration),
      dialect: 'postgres',
      dslMigration: changedMigration,
    });

    assert.equal(changedResult.pass, false);
    assert.equal(changedResult.diffs.length, 1);
  });
});

function checkMigration(expression: string): Migration {
  return defineMigration({
    kind: 'schema',
    id: 'sabotage-check-space',
    aliases: { postgres: 'v999' },
    description: 'sabotage check whitespace',
    operations: [
      { kind: 'create-table', table: { name: 'sabotage_check_space', ifNotExists: true, columns: [
        { name: 'a', type: 'integer' },
        { name: 'b', type: 'integer' },
      ], constraints: [{ kind: 'check', expression }] } },
    ],
  });
}

describe('SQLite hint cross-validation (regression: PR2.5 hint-priority bug)', () => {
  it('SQLite normalize fails when DSL hint contradicts parser-observed type', async () => {
    // PR2.5 bug: SQLite normalize blindly used hint, ignoring parser output.
    // This meant declaring a TEXT column as bigint in DSL would silently pass.
    // PR2.7 fix: normalize cross-validates and throws UnnormalizableDiff on mismatch.
    const migration = defineMigration({
      kind: 'schema',
      id: 'sqlite-hint-mismatch',
      aliases: { 'sqlite-sql': 'v999' },
      description: 'declare TEXT column as bigint',
      operations: [
        { kind: 'create-table', table: { name: 'sabotage_sqlite_hint', ifNotExists: true, columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'misdeclared', type: 'bigint', nullable: false },
        ] } },
      ],
    });

    const result = await checkParity({
      oldSql: ['CREATE TABLE IF NOT EXISTS sabotage_sqlite_hint (id TEXT PRIMARY KEY, misdeclared TEXT NOT NULL)'],
      newSql: renderToSqlite(migration),
      dialect: 'sqlite',
      dslMigration: migration,
    });

    assert.equal(result.pass, false, 'SQLite parity must catch DSL declaring TEXT column as bigint');
    assert.ok(result.diffs.length >= 1);
  });

  it('SQLite INTEGER ↔ bigint hint remains compatible (decision #14)', async () => {
    // Historical SQLite migrations store BIGINT-shaped data as INTEGER. DSL
    // declares those columns as `bigint` and normalize must accept the pair.
    const migration = defineMigration({
      kind: 'schema',
      id: 'sqlite-integer-bigint-ok',
      aliases: { 'sqlite-sql': 'v999' },
      description: 'INTEGER column declared as bigint passes',
      operations: [
        { kind: 'create-table', table: { name: 'sabotage_sqlite_bigint_ok', ifNotExists: true, columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'timestamp_ms', type: 'bigint', nullable: false },
        ] } },
      ],
    });

    const result = await checkParity({
      oldSql: ['CREATE TABLE IF NOT EXISTS sabotage_sqlite_bigint_ok (id TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL)'],
      newSql: renderToSqlite(migration),
      dialect: 'sqlite',
      dslMigration: migration,
    });

    assert.equal(result.pass, true, `expected pass, got ${result.diffs.length} diffs: ${JSON.stringify(result.diffs)}`);
    assert.deepEqual(result.diffs, []);
  });
});
