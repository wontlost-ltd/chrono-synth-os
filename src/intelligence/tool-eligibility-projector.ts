/**
 * 工具授权资格投影器 ToolEligibilityProjector（ADR-0060 T4，R2 capability→tool eligibility 桥）。
 *
 * 订阅 capability-learned 事件（L6 真落核后才发）→ 据该 (persona, capability) 下**活跃 tool_action_rule**
 * 的溯源，为每个已过工具考试的 tool 产出/替换一条 **eligibility 建议**（capability_tool_eligibility）。
 *
 * 铁律（守 ADR-0060 红线）：
 *   - **只建议，不 grant**（红线 2/12）：本投影器**绝不**写 ToolPermission / AgencyAuthorization，只产建议；
 *     执行门/授权服务绝不把本表当 allow 条件读。
 *   - **零-LLM 确定性**（红线 1）：建议全由规则溯源确定性派生（constraintsHash=FNV-1a 纯函数，无网络/时间源
 *     参与哈希，无随机）；不调 LLM。
 *   - **红线 11 陈旧即失效**：建议带 schemaVersion/sourceRuleVersion/examSpecVersion/riskClass/constraintsHash
 *     + expiresAt——tool schema 变化（schemaVersion 不符）/ riskClass 变化 / 规则版本变化 → 旧建议被新建议替换
 *     （同 key 唯一 active），过期建议 expiresAt 到点失效，均不得用于自动授权（T5 白名单桥消费时校验）。
 *   - **per-persona 隔离**（红线 7）：事件**缺 tenantId 直接 drop**（不默认 default）；每事件按其 tenantId 派生
 *     per-tenant store（投影器本身不绑单一租户，与 CapabilityIndexProjector 同款）。
 *   - **失败隔离**（对齐 CapabilityIndexProjector）：回调**绝不抛进 bus.emit**——投影异常只记 error 不污染上游。
 *
 * 无活跃规则（capability 学会但尚无工具动作规则）时：不产建议（正常，非错误）——eligibility 桥只桥「已会正确
 * 安全调工具」的 capability，纯知识 capability 不解锁工具（研究确认的 capability↔tool 解耦，本桥只在有规则时接）。
 */

import type { EventBus } from '../events/event-bus.js';
import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';
import { ToolActionRuleStore } from '../storage/tool-action-rule-store.js';
import { CapabilityToolEligibilityStore } from '../storage/capability-tool-eligibility-store.js';
import { generatePrefixedId } from '../utils/id-generator.js';

const LAYER = 'ToolEligibilityProjector';

/** eligibility 建议默认有效期（90 天）；到期失效不得再用于自动授权（红线 11）。 */
const DEFAULT_ELIGIBILITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** capability-learned 事件载荷（与 SystemEventMap 同形；TenantTagged 携带 tenantId）。 */
interface CapabilityLearnedPayload {
  readonly tenantId?: string;
  readonly personaId?: string;
  readonly capability?: string;
  readonly learningRequestId?: string;
  readonly examScore?: number;
  readonly learnedAt?: number;
}

export interface ToolEligibilityProjectorDeps {
  readonly bus: EventBus;
  /** 宿主 DB（按事件 tenantId 派生 per-tenant store）。 */
  readonly db: IDatabase;
  readonly logger: Logger;
  /** epoch ms 时钟（recommended_at / expiresAt 基准；测试注入）。 */
  readonly now: () => number;
  /** eligibility 建议有效期 ms（默认 90 天；红线 11 过期失效）。 */
  readonly ttlMs?: number;
}

export class ToolEligibilityProjector {
  private listener: ((payload: CapabilityLearnedPayload) => void) | null = null;

  constructor(private readonly deps: ToolEligibilityProjectorDeps) {}

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

  /** 同步投影：校验 → 据活跃规则溯源 upsert eligibility 建议。失败隔离（绝不抛进 bus.emit）。 */
  private onLearned(payload: CapabilityLearnedPayload): void {
    /* 红线 7：缺 tenantId 直接 drop（不默认归 default，防跨租户写建议）。 */
    if (typeof payload.tenantId !== 'string'
      || typeof payload.personaId !== 'string'
      || typeof payload.capability !== 'string') {
      this.deps.logger.warn(LAYER, 'capability-learned 事件字段不全，drop（不投影 eligibility）');
      return;
    }
    const tenantId = payload.tenantId;
    const personaId = payload.personaId;
    const capability = payload.capability;
    try {
      const ruleStore = new ToolActionRuleStore(this.deps.db, tenantId);
      const eligibilityStore = new CapabilityToolEligibilityStore(this.deps.db, tenantId);
      const provenances = ruleStore.listActiveEligibilityProvenance(personaId, capability);
      if (provenances.length === 0) {
        /* capability 学会但无工具动作规则：不产建议（capability↔tool 解耦，纯知识 capability 不解锁工具）。 */
        return;
      }
      const now = this.deps.now();
      const ttlMs = typeof this.deps.ttlMs === 'number' && this.deps.ttlMs > 0 ? this.deps.ttlMs : DEFAULT_ELIGIBILITY_TTL_MS;
      for (const p of provenances) {
        /* constraintsHash：本建议内容的确定性指纹（红线 11 陈旧判定依据；纯 FNV-1a，无时间/随机参与）。
         * T4 无实际 constraints（T5 白名单桥才附）——指纹覆盖溯源维度含 contentHash（防同 ruleVersion 内容被替换的
         * 治理事故，Codex T4 复审补），任一维度变即哈希变，可检测陈旧。 */
        const constraintsHash = fnv1aHex(`${p.toolId}|${p.schemaVersion}|${p.ruleVersion}|${p.contentHash}|${p.examSpecVersion}|${p.riskClass}`);
        eligibilityStore.upsert({
          id: generatePrefixedId('elig'),
          personaId,
          capability,
          toolId: p.toolId,
          schemaVersion: p.schemaVersion,
          sourceRuleVersion: p.ruleVersion,
          examSpecVersion: p.examSpecVersion,
          riskClass: p.riskClass,
          constraintsHash,
          recommendedAt: now,
          expiresAt: now + ttlMs,
        });
      }
      this.deps.logger.info(LAYER, `工具 eligibility 建议投影 persona=${personaId} cap=${capability} tools=${provenances.length}（建议非授权）`);
    } catch (err) {
      /* 投影失败已隔离：上游已落核，不回滚；建议缺失只是「暂无自动授权建议」（安全方向，授权本就人工/治理）。 */
      this.deps.logger.error(LAYER, `工具 eligibility 投影失败（已隔离，不影响已习得）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 确定性 FNV-1a 32-bit 十六进制哈希（纯函数，无网络/时间/随机——守零-LLM 红线 1）。 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
