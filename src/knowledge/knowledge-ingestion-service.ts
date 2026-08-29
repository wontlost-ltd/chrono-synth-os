/**
 * 知识摄入服务
 * 从知识源抓取条目 → 创建记忆节点 → 嵌入索引 → 发射事件
 */

import type { CognitiveMemoryGraph } from '../core/memory-graph.js';
import type { EmbeddingIndex } from '../intelligence/embedding-index.js';
import type { Logger } from '../utils/logger.js';
import type { EventBus } from '../events/event-bus.js';
import type { KnowledgeItem } from '../types/avatar-autorun.js';
import type { KnowledgeSourceStore } from '../storage/knowledge-source-store.js';
import type { KnowledgeSourceRegistry } from './knowledge-source-registry.js';
import { realClock, type Clock } from '../utils/clock.js';

export interface IngestionResult {
  readonly imported: number;
  readonly skipped: number;
  readonly memoryIds: string[];
  /**
   * 游标推进失败的 source id。这些 source 的记忆**已经落库**，但游标停在旧位置，
   * 下一轮会重新拉同一批内容重复摄入（fingerprint 去重只在单次运行内有效）。
   * 调用方据此告警/人工介入；空数组表示本轮游标全部正常推进。
   */
  readonly cursorAdvanceFailures: string[];
}

/**
 * 截断时的**部分游标**（审计 #423）：按本批**实际导入**到的位置推进，
 * 使下一轮从它之后继续 —— 既不重复也不跳过。
 *
 * 为什么不能直接用 source 返回的 `nextState`：它是对**全部拉取项**算的
 * （rss-source.ts:97 的 newestTs 覆盖所有 item），截断时用它会**跳过**
 * 尚未处理的条目。而完全不推进又会让超量 feed **永远卡在前 N 条**
 * （实测 3 轮写入 30 个节点 / 25 条 feed）。
 *
 * @returns 新的 stateJson；若本批没有可用时间戳（源不提供 publishedAt）
 *   则返回 null 表示**不推进** —— 保守方向，宁可重复也不跳过。
 */
function partialCursor(batch: readonly KnowledgeItem[], currentStateJson: string | null): string | null {
  let maxTs = 0;
  for (const item of batch) {
    if (typeof item.publishedAt === 'number' && item.publishedAt > maxTs) maxTs = item.publishedAt;
  }
  if (maxTs <= 0) return null;

  /* 保留既有 state 的其它字段，只推进时间游标。 */
  let base: Record<string, unknown> = {};
  if (currentStateJson) {
    try { base = JSON.parse(currentStateJson) as Record<string, unknown>; } catch { base = {}; }
  }
  /* 游标只进不退：并发/乱序下不得把已推进的游标拉回去（否则又会重复摄入）。 */
  const prev = typeof base.lastBuildTs === 'number' ? base.lastBuildTs : 0;
  if (maxTs <= prev) return null;
  return JSON.stringify({ ...base, lastBuildTs: maxTs });
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
    /* 时钟抽象（确定性）：摄入时间戳须可注入以便 golden replay 复现。默认 realClock。 */
    private readonly clock: Clock = realClock,
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
    const cursorAdvanceFailures: string[] = [];
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

        /* 游标推进失败是**静默重复摄入**的根因（审计 Warning B4-12）：记忆已写入，
         * 但游标停在旧位置 → 下一轮重新拉同一批内容。而 fingerprint 去重只是本次
         * 运行内的内存 Set，跨运行完全不设防，于是同一内容被重复灌进记忆图。
         * 记忆节点没有持久化 fingerprint 列，真正的跨运行去重需要加表 + 迁移，
         * 超出本次范围；此处至少把该失败**显式暴露**，不让它混在通用 warn 里被忽略。
         *
         * ⚠️ 审计 #423：此前**只有 `!truncated` 才推进游标**，于是当 feed 条数
         * 长期超过 `maxItemsPerRun` 时，游标**永不推进** —— 每轮都重新拉同一批、
         * 只处理前 N 条，**超出部分永远读不到**（实测 3 轮写入 30 个节点 / 25 条 feed）。
         *
         * 不能简单地在截断时也用 `nextState`：它是对**全部拉取项**算的
         * （见 rss-source.ts:97 的 newestTs 覆盖所有 item），直接用会**跳过**
         * 未处理的条目 —— 那正是原来那道守卫要防的事，方向相反但同样丢数据。
         *
         * 正解是**按实际处理到的位置**推进：截断时用**本批最后一条已导入项**的
         * publishedAt 作为游标，使下一轮从它之后继续。既不重复也不跳过。
         * 拿不到 publishedAt（源不提供时间戳）时保持原样不推进 —— 保守方向。 */
        const advanceState = truncated
          ? partialCursor(batch, source.stateJson)
          : (nextState ? JSON.stringify(nextState) : source.stateJson);

        if (advanceState !== null) {
          try {
            this.store.updateState(
              source.id,
              tenantId,
              advanceState,
              this.clock.now(),
            );
          } catch (err) {
            this.logger.error(
              'KnowledgeIngestion',
              `游标推进失败——已写入 ${sourceMemoryIds.length} 条记忆但游标未前移，` +
              `下一轮将重复摄入这批内容（source=${source.id} tenant=${tenantId}）：` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
            /* 不 rethrow：throw 会被本函数 per-source 的 catch 接住，进而**跳过**下方的
             * knowledge:ingested 事件发射——已落库的记忆从此对下游不可见，并让 skipped
             * 计数把一批成功摄入的条目误计为跳过。游标失败的正确处理是「记录并继续」，
             * 而不是把一个已完成的摄入伪装成失败。 */
            cursorAdvanceFailures.push(source.id);
          }
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

    return { imported, skipped, memoryIds, cursorAdvanceFailures };
  }
}
