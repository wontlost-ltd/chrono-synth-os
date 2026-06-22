/**
 * 能力索引投影器 CapabilityIndexProjector（ADR-0057 L7）——把 L6 的 capability-learned 事件
 * **确定性投影**进 capability_index 表（已学能力的正式来源）。
 *
 * 职责（零-LLM，纯确定性）：订阅 capability-learned（L6 真落核后才发）→ upsert capability_index 一行。
 * 之后 GapDetector 据此索引算缺口差集（替换 L2 的 status='passed' 扫描）。
 *
 * 投影语义（fail-safe，对齐 v109 迁移注释）：
 *   - index 只在 capability-learned（落核后）写——「index 说学过」必真学过。
 *   - 投影失败/滞后只会让 GapDetector 误判「没学过」而重登记（L2 active 幂等防洪，安全方向）；
 *     L2 passed 行保留作持久审计 + 回填兜底。
 *
 * 失败隔离（对齐 NudgePushBridge 纪律）：订阅回调**绝不抛进 bus.emit**——投影异常只记 error，
 * 不污染触发它的学习主流程（L6 已落核 + 账本 passed，投影是下游派生，失败不回滚上游）。
 *
 * 租户隔离（红线 8/7）：事件**缺 tenantId 直接 drop**（不默认归 default，防跨租户写索引）。
 * 每事件按其 tenantId 新建 per-tenant store（与 NudgePushBridge 同款——投影器本身不绑单一租户）。
 */

import type { EventBus } from '../events/event-bus.js';
import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';
import { CapabilityIndexStore } from '../storage/capability-index-store.js';
import { generatePrefixedId } from '../utils/id-generator.js';

const LAYER = 'CapabilityIndexProjector';

/** capability-learned 事件载荷（与 SystemEventMap 同形；TenantTagged 携带 tenantId）。 */
interface CapabilityLearnedPayload {
  readonly tenantId?: string;
  readonly personaId?: string;
  readonly capability?: string;
  readonly learningRequestId?: string;
  readonly examScore?: number;
  readonly learnedAt?: number;
}

export interface CapabilityIndexProjectorDeps {
  readonly bus: EventBus;
  /** 宿主 DB（按事件 tenantId 派生 per-tenant store）。 */
  readonly db: IDatabase;
  readonly logger: Logger;
  /** epoch ms 时钟（updated_at；测试注入）。 */
  readonly now: () => number;
}

export class CapabilityIndexProjector {
  private listener: ((payload: CapabilityLearnedPayload) => void) | null = null;

  constructor(private readonly deps: CapabilityIndexProjectorDeps) {}

  start(): void {
    if (this.listener) return;
    this.listener = (payload) => this.onLearned(payload);
    this.deps.bus.on('capability-learned', this.listener as never);
  }

  stop(): void {
    if (this.listener) {
      this.deps.bus.off('capability-learned', this.listener as never);
      this.listener = null;
    }
  }

  /** 同步投影：校验 → upsert capability_index。失败隔离（绝不抛进 bus.emit）。 */
  private onLearned(payload: CapabilityLearnedPayload): void {
    /* 红线 7/8：缺 tenantId 直接 drop（不默认归 default，防跨租户写索引）。 */
    if (typeof payload.tenantId !== 'string'
      || typeof payload.personaId !== 'string'
      || typeof payload.capability !== 'string'
      || typeof payload.examScore !== 'number'
      || typeof payload.learnedAt !== 'number') {
      this.deps.logger.warn(LAYER, `capability-learned 事件字段不全，drop（不投影）`);
      return;
    }
    try {
      const store = new CapabilityIndexStore(this.deps.db, payload.tenantId);
      store.upsert({
        id: generatePrefixedId('capidx'),
        personaId: payload.personaId,
        capability: payload.capability,
        examScore: payload.examScore,
        learningRequestId: typeof payload.learningRequestId === 'string' ? payload.learningRequestId : '',
        capabilityVersion: 1,
        learnedAt: payload.learnedAt,
        updatedAt: this.deps.now(),
      });
      this.deps.logger.info(LAYER, `能力索引投影 persona=${payload.personaId} cap=${payload.capability}`);
    } catch (err) {
      /* 投影失败已隔离：上游已落核 + 账本 passed，不回滚；GapDetector 会因 index 缺该能力重登记（安全方向，
       * L2 active 幂等防洪）。记 error 供巡检。 */
      this.deps.logger.error(LAYER, `能力索引投影失败（已隔离，不影响已习得）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
