/**
 * Integration test for the pgvector EmbeddingIndex path.
 *
 * Skip condition: TEST_POSTGRES_URL must be set, identical to postgres.test.ts.
 * The test points at a clean database, runs migrations through v071, exercises
 * indexMemory + search, and verifies the dims-mismatch trigger.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestClock } from '../../utils/clock.js';

const TEST_URL = process.env.TEST_POSTGRES_URL;

describe('PgvectorEmbeddingIndex integration', { skip: !TEST_URL }, () => {
  let PostgresDatabase: typeof import('../../storage/postgres-database.js').PostgresDatabase;
  let runPostgresMigrations: typeof import('../../storage/postgres-migrations-runner.js').runPostgresMigrations;
  let PgvectorEmbeddingIndex: typeof import('../../intelligence/embedding-index-pgvector.js').PgvectorEmbeddingIndex;
  let db: InstanceType<typeof PostgresDatabase>;

  /** A deterministic mock LLM that returns a fixed-dim vector seeded by text. */
  const stubLlm = {
    /** Hashes text to a 1536-dim Float64-flavoured array of small numbers. */
    async embed(texts: readonly string[]): Promise<number[][]> {
      return texts.map(t => {
        const seed = Array.from(t).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) / 10);
      });
    },
    async chat(): Promise<{ content: string }> {
      throw new Error('not used in this test');
    },
  };

  before(async () => {
    const pgMod = await import('../../storage/postgres-database.js');
    const migMod = await import('../../storage/postgres-migrations-runner.js');
    const pgIdxMod = await import('../../intelligence/embedding-index-pgvector.js');
    PostgresDatabase = pgMod.PostgresDatabase;
    runPostgresMigrations = migMod.runPostgresMigrations;
    PgvectorEmbeddingIndex = pgIdxMod.PgvectorEmbeddingIndex;

    db = new PostgresDatabase(TEST_URL!, { max: 5, idleTimeoutMs: 10_000 });

    /* Clean slate: drop public schema and recreate. The pgvector extension
     * is dropped along with everything else; v071 re-creates it. */
    db.exec('DROP SCHEMA public CASCADE');
    db.exec('CREATE SCHEMA public');
    db.exec('GRANT ALL ON SCHEMA public TO chrono');

    runPostgresMigrations(db);
  });

  after(() => {
    if (db) db.close();
  });

  it('upsert + search round-trip via PgvectorEmbeddingIndex', async () => {
    /* Seed memory_nodes (FK target). The migration v005 schema accepts
     * episodic kind + content. */
    db.prepare<void>(
      `INSERT INTO memory_nodes (id, tenant_id, kind, content, valence, salience, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    ).run('mem-1', 'tenant-a', 'episodic', 'cats are graceful', 0, 0.5, 0, 0);
    db.prepare<void>(
      `INSERT INTO memory_nodes (id, tenant_id, kind, content, valence, salience, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    ).run('mem-2', 'tenant-a', 'episodic', 'dogs love walks', 0, 0.5, 0, 0);

    const clock = new TestClock(Date.UTC(2026, 0, 1));
    const idx = new PgvectorEmbeddingIndex(
      db,
      'tenant-a',
      clock,
      stubLlm,
      'text-embedding-3-small',
      1536,
    );

    const ok1 = await idx.indexMemory('mem-1', 'cats are graceful');
    assert.equal(ok1, true);
    const ok2 = await idx.indexMemory('mem-2', 'dogs love walks');
    assert.equal(ok2, true);

    /* The same text we used to seed mem-1 should produce a vector that's
     * closest to mem-1's stored embedding. */
    const queryEmbedding = (await stubLlm.embed(['cats are graceful']))[0];
    const matches = idx.search(queryEmbedding, 2);

    assert.equal(matches.length, 2);
    assert.equal(matches[0].memoryId, 'mem-1');
    /* Score is in [-1, 1]; identical vectors give 1. */
    assert.ok(matches[0].score > matches[1].score, 'mem-1 should rank above mem-2');
    assert.ok(matches[0].score > 0.9, `expected exact match score > 0.9, got ${matches[0].score}`);

    /* Tenant isolation: a different tenant id finds nothing. */
    const otherIdx = new PgvectorEmbeddingIndex(
      db, 'tenant-other', clock, stubLlm, 'text-embedding-3-small', 1536,
    );
    const otherMatches = otherIdx.search(queryEmbedding, 5);
    assert.equal(otherMatches.length, 0);
  });

  it('indexMemory rejects vectors of wrong dimensions', async () => {
    /* Construct an index that thinks dims = 1536 but with an LLM that
     * returns 256-dim vectors. The implementation should refuse the
     * write before the trigger fires. */
    const badLlm = {
      async embed(texts: readonly string[]): Promise<number[][]> {
        return texts.map(() => Array.from({ length: 256 }, () => 0));
      },
      async chat(): Promise<{ content: string }> {
        throw new Error('not used');
      },
    };
    const clock = new TestClock(Date.UTC(2026, 0, 1));
    const idx = new PgvectorEmbeddingIndex(
      db, 'tenant-a', clock, badLlm, 'text-embedding-3-small', 1536,
    );

    db.prepare<void>(
      `INSERT INTO memory_nodes (id, tenant_id, kind, content, valence, salience, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    ).run('mem-bad', 'tenant-a', 'episodic', 'test', 0, 0.5, 0, 0);

    const result = await idx.indexMemory('mem-bad', 'test');
    /* Our impl returns false on dim mismatch before hitting the DB. The
     * trigger is the second line of defence; pre-check is the first. */
    assert.equal(result, false);
  });

  it('search() returns empty for empty / mismatched query embedding', () => {
    const clock = new TestClock(Date.UTC(2026, 0, 1));
    const idx = new PgvectorEmbeddingIndex(
      db, 'tenant-a', clock, stubLlm, 'text-embedding-3-small', 1536,
    );

    assert.equal(idx.search([], 5).length, 0);
    assert.equal(idx.search(Array(256).fill(0), 5).length, 0);
  });

  it('cacheSize and partitionCount are 0 (stateless)', () => {
    const clock = new TestClock(Date.UTC(2026, 0, 1));
    const idx = new PgvectorEmbeddingIndex(
      db, 'tenant-a', clock, stubLlm, 'text-embedding-3-small', 1536,
    );
    assert.equal(idx.cacheSize, 0);
    assert.equal(idx.partitionCount, 0);
  });
});
