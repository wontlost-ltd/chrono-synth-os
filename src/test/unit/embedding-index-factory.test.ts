/**
 * createEmbeddingIndex routing logic — pure config-driven decision tree.
 *
 * The factory has no side effects on its own (it just news up the right
 * impl class), so we can test it cheaply with a mock database + clock + llm.
 * The actual class behavior is covered separately:
 *  - InMemoryEmbeddingIndex: src/test/unit/embedding-index.test.ts
 *  - PgvectorEmbeddingIndex: src/test/integration/embedding-pg.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../../config/schema.js';
import type { IDatabase } from '../../storage/database.js';
import { TestClock } from '../../utils/clock.js';
import { createEmbeddingIndex } from '../../intelligence/embedding-index-factory.js';
import { InMemoryEmbeddingIndex } from '../../intelligence/embedding-index-memory.js';
import { PgvectorEmbeddingIndex } from '../../intelligence/embedding-index-pgvector.js';

const stubLlm = {
  async embed(): Promise<number[][]> { return [[]]; },
  async chat(): Promise<{ content: string }> { return { content: '' }; },
};

const stubDb = {} as IDatabase;
const stubClock = new TestClock(0);

function configWith(overrides: {
  driver?: 'sqlite' | 'postgres';
  useVectorExtension?: boolean;
  vectorExtensionTenants?: string[];
}): AppConfig {
  return {
    db: { driver: overrides.driver ?? 'sqlite' },
    intelligence: {
      embeddingModel: 'text-embedding-3-small',
      embeddingDims: 1536,
      useVectorExtension: overrides.useVectorExtension ?? false,
      vectorExtensionTenants: overrides.vectorExtensionTenants ?? [],
    },
  } as unknown as AppConfig;
}

describe('createEmbeddingIndex routing', () => {
  it('SQLite driver always returns InMemory, even with allowlist', () => {
    const idx = createEmbeddingIndex({
      tenantId: 'tenant-1',
      db: stubDb,
      clock: stubClock,
      llm: stubLlm,
      config: configWith({ driver: 'sqlite', vectorExtensionTenants: ['tenant-1'], useVectorExtension: true }),
    });
    assert.ok(idx instanceof InMemoryEmbeddingIndex);
  });

  it('Postgres + global flag off + tenant not in allowlist → InMemory', () => {
    const idx = createEmbeddingIndex({
      tenantId: 'tenant-not-listed',
      db: stubDb,
      clock: stubClock,
      llm: stubLlm,
      config: configWith({ driver: 'postgres', useVectorExtension: false, vectorExtensionTenants: ['tenant-pilot'] }),
    });
    assert.ok(idx instanceof InMemoryEmbeddingIndex);
  });

  it('Postgres + global flag off + tenant in allowlist → Pgvector', () => {
    const idx = createEmbeddingIndex({
      tenantId: 'tenant-pilot',
      db: stubDb,
      clock: stubClock,
      llm: stubLlm,
      config: configWith({ driver: 'postgres', useVectorExtension: false, vectorExtensionTenants: ['tenant-pilot'] }),
    });
    assert.ok(idx instanceof PgvectorEmbeddingIndex);
  });

  it('Postgres + global flag on + empty allowlist → Pgvector for everyone', () => {
    const idx = createEmbeddingIndex({
      tenantId: 'any-tenant',
      db: stubDb,
      clock: stubClock,
      llm: stubLlm,
      config: configWith({ driver: 'postgres', useVectorExtension: true, vectorExtensionTenants: [] }),
    });
    assert.ok(idx instanceof PgvectorEmbeddingIndex);
  });

  it('Postgres + global flag on + tenant explicitly in allowlist → Pgvector (allowlist is additive, not a denylist)', () => {
    const idx = createEmbeddingIndex({
      tenantId: 'tenant-1',
      db: stubDb,
      clock: stubClock,
      llm: stubLlm,
      config: configWith({ driver: 'postgres', useVectorExtension: true, vectorExtensionTenants: ['tenant-1'] }),
    });
    assert.ok(idx instanceof PgvectorEmbeddingIndex);
  });
});
