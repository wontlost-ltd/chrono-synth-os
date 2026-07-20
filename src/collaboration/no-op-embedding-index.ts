/** 空实现 EmbeddingIndex：search 恒空、indexMemory 恒 false，无任何 LLM/embedding 调用。
 * 用于 autonomous 决策路径（永不查询 embedding，decision-engine.ts:140 getContext 只在 growth 用），
 * 让 DecisionEngine 构造链完全不含 LLMProvider——零-LLM 是结构性保证（约束 1）。 */
import type { EmbeddingIndex, EmbeddingMatch } from '../intelligence/embedding-index.js';

export class NoOpEmbeddingIndex implements EmbeddingIndex {
  /** 恒 false：不接受任何 embedding 写入（无 LLM 产向量）。 */
  async indexMemory(_memoryId: string, _text: string): Promise<boolean> {
    return false;
  }

  /** 恒空：不做近邻检索（autonomous 路径本就不查询它）。 */
  search(_queryEmbedding: readonly number[], _topK: number): EmbeddingMatch[] {
    return [];
  }

  /** 无缓存向量。 */
  readonly cacheSize = 0;

  /** 无 IVF 分区。 */
  readonly partitionCount = 0;
}
