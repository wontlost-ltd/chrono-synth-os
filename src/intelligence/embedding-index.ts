/**
 * 向量索引：为记忆节点提供嵌入向量存储和余弦相似度检索
 */

import type { IDatabase } from '../storage/database.js';
import type { Clock } from '../utils/clock.js';
import type { LLMProvider } from './llm-provider.js';

interface EmbeddingRow {
  memory_id: string;
  embedding_json: string;
}

export interface EmbeddingMatch {
  readonly memoryId: string;
  readonly score: number;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class EmbeddingIndex {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
    private readonly llm: LLMProvider,
    private readonly model: string,
  ) {}

  /** 对单条记忆建立向量索引 */
  async indexMemory(memoryId: string, text: string): Promise<boolean> {
    const embeddings = await this.llm.embed([text]);
    const vector = embeddings[0];
    if (!vector || vector.length === 0) return false;

    this.db.prepare<void>(
      `INSERT INTO memory_embeddings (memory_id, embedding_json, model, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET embedding_json=excluded.embedding_json, model=excluded.model, updated_at=excluded.updated_at`,
    ).run(memoryId, JSON.stringify(vector), this.model, this.clock.now());
    return true;
  }

  /** 向量检索（余弦相似度排序，返回 topK 个最相似结果） */
  search(queryEmbedding: readonly number[], topK: number): EmbeddingMatch[] {
    if (queryEmbedding.length === 0) return [];

    const rows = this.db.prepare<EmbeddingRow>(
      'SELECT memory_id, embedding_json FROM memory_embeddings WHERE model = ?',
    ).all(this.model);

    const results: EmbeddingMatch[] = [];
    for (const row of rows) {
      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding_json) as number[];
      } catch {
        continue;
      }
      const score = cosineSimilarity(queryEmbedding, embedding);
      if (Number.isFinite(score)) {
        results.push({ memoryId: row.memory_id, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, topK));
  }
}
