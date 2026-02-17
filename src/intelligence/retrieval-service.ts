/**
 * 语义检索服务
 * 融合三种检索策略：工作记忆 + 图扩散激活 + 向量余弦相似度
 */

import type { CognitiveMemoryGraph } from '../core/memory-graph.js';
import type { MemoryKind } from '../types/core-self.js';
import type { EmbeddingIndex } from './embedding-index.js';

export interface ContextMemory {
  readonly memoryId: string;
  readonly content: string;
  readonly score: number;
  readonly kind: MemoryKind;
  readonly salience: number;
  readonly sources: readonly string[];
}

const WORKING_WEIGHT = 1.2;
const ACTIVATION_WEIGHT = 0.8;
const EMBEDDING_WEIGHT = 1.0;

export class RetrievalService {
  constructor(
    private readonly memories: CognitiveMemoryGraph,
    private readonly embeddingIndex: EmbeddingIndex,
  ) {}

  /** 混合检索上下文记忆 */
  getContext(_query: string, queryEmbedding: readonly number[], topK: number): ContextMemory[] {
    const accumulator = new Map<string, { score: number; sources: Set<string> }>();

    const addScore = (memoryId: string, score: number, source: string): void => {
      if (!Number.isFinite(score) || score <= 0) return;
      const existing = accumulator.get(memoryId);
      if (existing) {
        existing.score += score;
        existing.sources.add(source);
      } else {
        accumulator.set(memoryId, { score, sources: new Set([source]) });
      }
    };

    /* 工作记忆 */
    for (const slot of this.memories.getWorkingMemorySlots()) {
      addScore(slot.memoryId, slot.score * WORKING_WEIGHT, 'working');
    }

    /* 图激活：只读遍历相关记忆（不修改 salience） */
    const highSalience = [...this.memories.getAllMemories().values()]
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 3);
    for (const mem of highSalience) {
      addScore(mem.id, mem.salience * ACTIVATION_WEIGHT, 'activation');
      const related = this.memories.getRelatedMemories(mem.id, 2);
      for (const rel of related) {
        addScore(rel.id, rel.salience * ACTIVATION_WEIGHT, 'activation');
      }
    }

    /* 向量检索 */
    const matches = this.embeddingIndex.search(queryEmbedding, topK);
    for (const match of matches) {
      addScore(match.memoryId, match.score * EMBEDDING_WEIGHT, 'embedding');
    }

    const results: ContextMemory[] = [];
    for (const [memoryId, acc] of accumulator) {
      const mem = this.memories.getMemory(memoryId);
      if (!mem) continue;
      results.push({
        memoryId,
        content: mem.content,
        score: acc.score,
        kind: mem.kind,
        salience: mem.salience,
        sources: [...acc.sources],
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, topK));
  }
}
