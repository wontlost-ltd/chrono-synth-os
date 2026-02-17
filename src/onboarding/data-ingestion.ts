/**
 * 外部数据导入
 * 将日记条目和决策记录导入为记忆和决策案例
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { EmbeddingIndex } from '../intelligence/embedding-index.js';

export interface JournalEntry {
  readonly content: string;
  readonly valence?: number;
  readonly salience?: number;
}

export interface DecisionRecord {
  readonly title: string;
  readonly description: string;
  readonly outcome?: string;
}

export class DataIngestion {
  constructor(
    private readonly core: CoreRhythmLayer,
    private readonly embeddingIndex: EmbeddingIndex,
  ) {}

  /** 导入日记条目为情景记忆（嵌入索引 best-effort） */
  async importJournalEntries(entries: readonly JournalEntry[]): Promise<{ imported: number; memoryIds: string[] }> {
    const memoryIds: string[] = [];
    for (const entry of entries) {
      const memory = this.core.addMemory(
        'episodic',
        entry.content,
        entry.valence ?? 0,
        entry.salience ?? 0.5,
      );
      try {
        await this.embeddingIndex.indexMemory(memory.id, entry.content);
      } catch { /* 嵌入索引失败不阻塞导入 */ }
      memoryIds.push(memory.id);
    }
    return { imported: memoryIds.length, memoryIds };
  }

  /** 导入决策记录为语义记忆（嵌入索引 best-effort） */
  async importDecisionRecords(records: readonly DecisionRecord[]): Promise<{ imported: number; caseIds: string[] }> {
    const caseIds: string[] = [];
    for (const record of records) {
      const content = record.outcome
        ? `决策: ${record.title}\n描述: ${record.description}\n结果: ${record.outcome}`
        : `决策: ${record.title}\n描述: ${record.description}`;
      const memory = this.core.addMemory('semantic', content, 0, 0.6);
      try {
        await this.embeddingIndex.indexMemory(memory.id, content);
      } catch { /* 嵌入索引失败不阻塞导入 */ }
      caseIds.push(memory.id);
    }
    return { imported: caseIds.length, caseIds };
  }
}
