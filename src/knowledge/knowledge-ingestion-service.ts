/**
 * 知识摄入服务
 * 从知识源抓取条目 → 创建记忆节点 → 嵌入索引 → 发射事件
 */

import type { CognitiveMemoryGraph } from '../core/memory-graph.js';
import type { EmbeddingIndex } from '../intelligence/embedding-index.js';
import type { Logger } from '../utils/logger.js';
import type { EventBus } from '../events/event-bus.js';
import type { KnowledgeSourceStore } from '../storage/knowledge-source-store.js';
import type { KnowledgeSourceRegistry } from './knowledge-source-registry.js';

export interface IngestionResult {
  readonly imported: number;
  readonly skipped: number;
  readonly memoryIds: string[];
}

export class KnowledgeIngestionService {
  constructor(
    private readonly registry: KnowledgeSourceRegistry,
    private readonly store: KnowledgeSourceStore,
    private readonly memoryGraph: CognitiveMemoryGraph,
    private readonly embeddingIndex: EmbeddingIndex | undefined,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly maxItemsPerRun: number = 100,
  ) {}

  /**
   * 摄入知识源条目。
   * @param memoryGraph 可选：覆盖默认 memoryGraph，用于多租户隔离
   */
  async ingest(
    tenantId: string,
    sourceIds: string[],
    signal: AbortSignal,
    memoryGraph: CognitiveMemoryGraph = this.memoryGraph,
  ): Promise<IngestionResult> {
    const sources = this.store.listEnabledByIds(tenantId, sourceIds);
    let imported = 0;
    let skipped = 0;
    const memoryIds: string[] = [];
    const seenFingerprints = new Set<string>();

    for (const source of sources) {
      if (signal.aborted) break;

      try {
        if (!this.registry.has(source.type)) {
          this.logger.warn('KnowledgeIngestion', `跳过未注册的知识源类型: ${source.type}`);
          skipped++;
          continue;
        }

        const impl = this.registry.get(source.type);
        const config = JSON.parse(source.configJson) as Record<string, unknown>;
        const state = source.stateJson ? JSON.parse(source.stateJson) as Record<string, unknown> : null;

        const { items, nextState } = await impl.fetch(config, state, signal);

        /* 限制单次摄入数量 */
        const remaining = this.maxItemsPerRun - imported;
        const batch = remaining > 0 ? items.slice(0, remaining) : [];
        const truncated = items.length > batch.length;
        const sourceMemoryIds: string[] = [];

        for (const item of batch) {
          if (signal.aborted) break;
          if (imported >= this.maxItemsPerRun) break;

          /* 去重：对短内容做精确匹配，避免重复插入 */
          if (item.fingerprint && seenFingerprints.has(item.fingerprint)) {
            skipped++;
            continue;
          }
          if (item.fingerprint) seenFingerprints.add(item.fingerprint);

          /* 创建记忆节点（使用调用方指定的 memoryGraph，支持多租户隔离） */
          const memory = memoryGraph.addMemory(
            item.kind ?? 'episodic',
            item.content,
            item.valence ?? 0,
            item.salience ?? 0.5,
          );
          sourceMemoryIds.push(memory.id);

          /* 异步嵌入索引（不阻塞） */
          if (this.embeddingIndex) {
            this.embeddingIndex.indexMemory(memory.id, item.content).catch((err) => {
              this.logger.warn('KnowledgeIngestion', `嵌入索引失败: ${err instanceof Error ? err.message : String(err)}`);
            });
          }

          imported++;
        }

        memoryIds.push(...sourceMemoryIds);
        skipped += Math.max(0, items.length - batch.length);

        /* 仅在未截断时推进游标，避免跳过未处理的条目 */
        if (!truncated) {
          this.store.updateState(
            source.id,
            nextState ? JSON.stringify(nextState) : source.stateJson,
            Date.now(),
          );
        }

        /* 发射摄入事件 */
        if (sourceMemoryIds.length > 0) {
          this.bus.emit('knowledge:ingested', {
            tenantId,
            sourceId: source.id,
            itemCount: sourceMemoryIds.length,
            memoryIds: sourceMemoryIds,
          });
        }
      } catch (err) {
        this.logger.warn('KnowledgeIngestion', `知识源 ${source.id} (${source.type}) 摄入失败: ${err instanceof Error ? err.message : String(err)}`);
        skipped++;
      }
    }

    return { imported, skipped, memoryIds };
  }
}
