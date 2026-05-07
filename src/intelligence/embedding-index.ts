/**
 * Embedding index abstraction.
 *
 * Two implementations live behind this interface:
 * - InMemoryEmbeddingIndex (./embedding-index-memory.ts): the legacy
 *   path. Stores vectors as JSON in memory_embeddings.embedding_json,
 *   refreshes them into a per-process LRU cache, and runs cosine
 *   similarity in JS (with an IVF partition index past 256 vectors).
 *   Used by SQLite deployments and as a fallback when pgvector is off.
 *
 * - PgvectorEmbeddingIndex (./embedding-index-pgvector.ts): the
 *   Postgres path. Stores vectors in memory_embeddings.embedding (a
 *   pgvector(1536) column), pushes search to the database via an HNSW
 *   cosine index, and keeps zero per-process state. Wired in when
 *   driver=postgres and config.intelligence.useVectorExtension is on.
 *
 * Pick an implementation through createEmbeddingIndex (./embedding-index-factory.ts).
 * Direct construction is fine for tests targeting a specific path.
 */

export interface EmbeddingMatch {
  readonly memoryId: string;
  /** Cosine similarity in [-1, 1]; higher = more similar. */
  readonly score: number;
}

export interface EmbeddingIndex {
  /**
   * Compute the embedding for `text` and persist it under `memoryId`.
   * Returns false if the LLM produced an empty/invalid vector.
   */
  indexMemory(memoryId: string, text: string): Promise<boolean>;

  /**
   * Cosine-similarity nearest-neighbour search. Returns up to `topK`
   * matches, ordered by descending score. Empty array if the index has
   * no usable data or the query is degenerate.
   */
  search(queryEmbedding: readonly number[], topK: number): EmbeddingMatch[];

  /**
   * Approximate count of vectors currently held in this index.
   * In-memory implementations return the cache size; remote
   * implementations may return 0 if they don't track this locally.
   */
  readonly cacheSize: number;

  /**
   * Number of IVF partitions in use, when the implementation has them.
   * Always 0 for implementations that delegate ANN search to the
   * database (e.g. pgvector / HNSW).
   */
  readonly partitionCount: number;
}

export { InMemoryEmbeddingIndex } from './embedding-index-memory.js';
