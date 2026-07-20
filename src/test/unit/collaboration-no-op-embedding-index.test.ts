import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoOpEmbeddingIndex } from '../../collaboration/no-op-embedding-index.js';

test('NoOpEmbeddingIndex：search 恒空、indexMemory 恒 false、无 LLM 依赖', async () => {
  const idx = new NoOpEmbeddingIndex();
  assert.deepEqual(idx.search([0.1, 0.2], 5), []);
  assert.equal(await idx.indexMemory('m', 'x'), false);
  assert.equal(idx.cacheSize, 0);
  assert.equal(idx.partitionCount, 0);
});

test('NoOpEmbeddingIndex：不同参数 search 仍恒空（确定性、零副作用）', () => {
  const idx = new NoOpEmbeddingIndex();
  assert.deepEqual(idx.search([], 0), []);
  assert.deepEqual(idx.search([0.9, -0.5, 0.3], 100), []);
});
