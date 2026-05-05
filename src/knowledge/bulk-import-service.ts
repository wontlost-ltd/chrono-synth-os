/**
 * 知识批量导入服务（P1-B）
 *
 * - ≤20 条 source：在调用线程内同步处理（HTTP 请求阻塞，p95 < 3s）
 * - >20 条：投递到 task_queue，由 BulkKnowledgeImportWorker 异步处理
 * - 去重：默认按 fingerprint 跳过；overwrite 模式删除现有同 fingerprint 行后再写
 * - 失败：单条失败计入 failures（最多 50 条详情），不中断 batch
 */

import { createHash } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { TaskQueue } from '../queue/task-queue.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import type { PersonaTemplateService } from '../enterprise/persona-template-service.js';
import type { Logger } from '../utils/logger.js';
import type { UsageTracker } from '../billing/usage-tracker.js';
import type { BillingOutbox } from '../billing/billing-outbox.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import {
  BulkImportStore,
  type BulkImportDeduplicateStrategy,
  type BulkImportJobMetadata,
  type BulkImportJobRecord,
} from './bulk-import-store.js';
import { bimpQueryFindByFingerprint, bimpCmdDeleteByFingerprint } from '@chrono/kernel';
import { UrlContentFetcher } from './url-content-fetcher.js';

export type BulkImportSourceKind = 'text' | 'url' | 'file';

export interface BulkImportSource {
  kind: BulkImportSourceKind;
  content: string;
  title?: string;
  category?: string;
  fingerprint?: string;
}

export interface BulkImportSubmitInput {
  tenantId: string;
  personaId: string;
  ownerUserId: string;
  sources: BulkImportSource[];
  deduplicateStrategy: BulkImportDeduplicateStrategy;
  /** 关联的岗位人格模板 ID。提供后 service 会校验 source.category 是否在
   *  template.requiredKnowledgeCategories 列表内，仅累计统计不阻断。 */
  expectedTemplateId?: string;
}

export interface BulkImportSubmitResult {
  jobId: string;
  mode: 'sync' | 'async';
  totalItems: number;
  state: BulkImportJobRecord['state'];
}

export interface BulkImportProcessInput {
  jobId: string;
  tenantId: string;
  personaId: string;
  ownerUserId: string;
  sources: BulkImportSource[];
  deduplicateStrategy: BulkImportDeduplicateStrategy;
  expectedTemplateId?: string;
}

export const BULK_IMPORT_TASK_TYPE = 'bulk_knowledge_import';
export const SYNC_THRESHOLD_ITEMS = 20;

/** 异步路径不可用：超过同步阈值但 task queue 未启用 */
export class BulkImportQueueDisabledError extends Error {
  constructor(itemCount: number) {
    super(`bulk knowledge import: ${itemCount} items exceeds sync threshold ${SYNC_THRESHOLD_ITEMS} but task queue is disabled`);
    this.name = 'BulkImportQueueDisabledError';
  }
}

export class BulkImportService {
  private readonly store: BulkImportStore;

  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly personaCoreService: PersonaCoreService,
    private readonly taskQueue: TaskQueue | undefined,
    private readonly fetcher: UrlContentFetcher,
    private readonly logger: Logger,
    private readonly templateService?: PersonaTemplateService,
    /** P1-D 计费上报 */
    private readonly usageTracker?: UsageTracker,
    private readonly billingOutbox?: BillingOutbox,
    private readonly stripeCustomerLookup?: (tenantId: string) => string | null,
  ) {
    this.store = new BulkImportStore(tx);
  }

  getStore(): BulkImportStore {
    return this.store;
  }

  async submit(input: BulkImportSubmitInput): Promise<BulkImportSubmitResult> {
    const jobId = generatePrefixedId('bki');
    this.store.create({
      id: jobId,
      tenantId: input.tenantId,
      personaId: input.personaId,
      ownerUserId: input.ownerUserId,
      totalItems: input.sources.length,
      deduplicateStrategy: input.deduplicateStrategy,
    });

    if (input.sources.length <= SYNC_THRESHOLD_ITEMS) {
      this.store.markRunning(jobId);
      await this.processBatch({
        jobId,
        tenantId: input.tenantId,
        personaId: input.personaId,
        ownerUserId: input.ownerUserId,
        sources: input.sources,
        deduplicateStrategy: input.deduplicateStrategy,
        expectedTemplateId: input.expectedTemplateId,
      });
      const final = this.store.get(input.tenantId, jobId);
      return {
        jobId,
        mode: 'sync',
        totalItems: input.sources.length,
        state: final?.state ?? 'completed',
      };
    }

    /* 异步：入队，worker 会调用 processBatch */
    if (!this.taskQueue) {
      this.store.markFailed(
        jobId,
        `异步路径不可用：超过 ${SYNC_THRESHOLD_ITEMS} 条且 task queue 未启用（请设置 queue.enabled=true）`,
      );
      throw new BulkImportQueueDisabledError(input.sources.length);
    }
    this.taskQueue.enqueue(input.tenantId, BULK_IMPORT_TASK_TYPE, {
      jobId,
      tenantId: input.tenantId,
      personaId: input.personaId,
      ownerUserId: input.ownerUserId,
      sources: input.sources,
      deduplicateStrategy: input.deduplicateStrategy,
      expectedTemplateId: input.expectedTemplateId,
    } satisfies BulkImportProcessInput, /* maxRetries */ 1, /* priority */ 0);

    return {
      jobId,
      mode: 'async',
      totalItems: input.sources.length,
      state: 'queued',
    };
  }

  async processBatch(input: BulkImportProcessInput): Promise<void> {
    try {
      this.store.markRunning(input.jobId);

      /* 模板联动：解析 requiredKnowledgeCategories（缺失或加载失败 → 跳过校验） */
      const requiredCategories = this.resolveRequiredCategories(input);
      let matchedCategoryCount = 0;
      let unmatchedCategoryCount = 0;
      const unexpectedCategorySet = new Set<string>();

      for (let i = 0; i < input.sources.length; i++) {
        const source = input.sources[i];

        /* 仅当模板提供了非空白名单时进行校验；source.category 缺失视为未分类不计入两侧 */
        if (requiredCategories && source.category) {
          if (requiredCategories.has(source.category)) {
            matchedCategoryCount += 1;
          } else {
            unmatchedCategoryCount += 1;
            unexpectedCategorySet.add(source.category);
          }
        }

        try {
          await this.processSingle(input, source, i);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.store.incrementCounter(input.jobId, 'failed_count', 1);
          this.store.appendFailure(input.jobId, { index: i, reason });
        }
      }

      if (input.expectedTemplateId) {
        const metadata: BulkImportJobMetadata = {
          expectedTemplateId: input.expectedTemplateId,
          matchedCategoryCount,
          unmatchedCategoryCount,
          unexpectedCategories: [...unexpectedCategorySet].sort(),
        };
        this.store.setMetadata(input.jobId, metadata);
      }

      /* P1-D 计费上报：以最终 imported_count 作为 quantity */
      const finalJob = this.store.get(input.tenantId, input.jobId);
      const importedCount = finalJob?.importedCount ?? 0;
      if (importedCount > 0) {
        this.recordBillableUsage(input.tenantId, importedCount);
      }

      this.store.markCompleted(input.jobId);
    } catch (err) {
      this.logger.error(
        'BulkImportService',
        `processBatch fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.store.markFailed(input.jobId, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 解析模板的 requiredKnowledgeCategories；返回 Set 用于 O(1) 查询。
   * 模板不存在 / 服务未注入 / 列表为空 → 返回 undefined（视为不校验）。
   */
  private resolveRequiredCategories(input: BulkImportProcessInput): Set<string> | undefined {
    if (!input.expectedTemplateId || !this.templateService) return undefined;
    const template = this.templateService.get(input.tenantId, input.expectedTemplateId);
    if (!template) {
      this.logger.warn(
        'BulkImportService',
        `expectedTemplateId=${input.expectedTemplateId} not found for tenant ${input.tenantId}; skipping category validation`,
      );
      return undefined;
    }
    if (template.requiredKnowledgeCategories.length === 0) return undefined;
    return new Set(template.requiredKnowledgeCategories);
  }

  private async processSingle(
    input: BulkImportProcessInput,
    source: BulkImportSource,
    index: number,
  ): Promise<void> {
    const content = await this.resolveContent(source);
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error('content is empty after resolution');
    }
    const title = source.title?.trim() || `Item ${index + 1}`;
    const fingerprint = source.fingerprint ?? autoFingerprint(content, title);

    const existing = this.findExistingByFingerprint(input.tenantId, input.personaId, fingerprint);

    if (existing) {
      if (input.deduplicateStrategy === 'skip') {
        this.store.incrementCounter(input.jobId, 'skipped_count', 1);
        return;
      }
      /* overwrite：删除现有再写 */
      this.deleteByFingerprint(input.tenantId, input.personaId, fingerprint);
    }

    const detail = this.personaCoreService.addKnowledge({
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      personaId: input.personaId,
      title,
      content,
      source: sourceLabel(source.kind),
      tags: source.category ? [source.category] : [],
      confidence: 0.7,
      fingerprint,
    });

    if (!detail) {
      throw new Error(`persona ${input.personaId} not found or terminal`);
    }
    this.store.incrementCounter(input.jobId, 'imported_count', 1);
  }

  private async resolveContent(source: BulkImportSource): Promise<string> {
    switch (source.kind) {
      case 'text':
      case 'file':
        /* file 由调用方提交解码后的文本（base64 解码 / OCR / PDF→text 由前端处理） */
        return source.content;
      case 'url':
        return (await this.fetcher.fetch(source.content)).content;
      default: {
        const _exhaustive: never = source.kind;
        throw new Error(`unknown source kind: ${String(_exhaustive)}`);
      }
    }
  }

  private findExistingByFingerprint(
    tenantId: string,
    personaId: string,
    fingerprint: string,
  ): { id: string } | null {
    return this.tx.queryOne(bimpQueryFindByFingerprint({ tenantId, personaId, fingerprint }));
  }

  private deleteByFingerprint(tenantId: string, personaId: string, fingerprint: string): void {
    this.tx.execute(bimpCmdDeleteByFingerprint({ tenantId, personaId, fingerprint }));
  }

  private recordBillableUsage(tenantId: string, quantity: number): void {
    try {
      this.usageTracker?.record(tenantId, 'bulk_knowledge_import_item', quantity);
    } catch (err) {
      this.logger.warn('BulkImportService', `usage tracker record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.billingOutbox && this.stripeCustomerLookup) {
      try {
        const customerId = this.stripeCustomerLookup(tenantId);
        if (customerId) {
          this.billingOutbox.enqueue(tenantId, customerId, 'chrono_bulk_knowledge_import_item', quantity);
        }
      } catch (err) {
        this.logger.warn('BulkImportService', `billing outbox enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function sourceLabel(kind: BulkImportSourceKind): string {
  switch (kind) {
    case 'text': return 'bulk_text';
    case 'url':  return 'bulk_url';
    case 'file': return 'bulk_file';
  }
}

export function autoFingerprint(content: string, title: string): string {
  const seed = `${title} ${content.slice(0, 4096)}`;
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}
