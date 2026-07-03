/**
 * 工具自动授权桥 ToolAutoAuthorizationBridge（ADR-0060 T5，R5 低风险白名单自动授权）。
 *
 * 消费 T4 产出的**有效** eligibility 建议（capability→tool），据**治理白名单**决定：
 *   - **白名单 + 低风险** → 自动授予 ToolPermission（scope/constraints/expiresAt 由白名单策略定，expiresAt 强制非空）；
 *   - **不在白名单 / 高风险** → **不自动授权**，只创建一条待审批请求（红线 3），由人工/治理决议。
 *
 * 铁律（守 ADR-0060 红线）：
 *   - **eligibility≠allow / capability≠permission**（红线 2/12）：桥是**唯一**把 eligibility 转成授权动作的地方，
 *     且只经既有 ToolPermissionService.grant（不旁路 pipeline 7 门）；执行门仍各自校验。
 *   - **红线 13 低风险治理化**：「可自动授权」**只**看治理白名单（resolvePersonaToolAutoAuthWhitelist），
 *     **绝不**用 tool.metadata.highRisk 自证放行——highRisk 只作 currentToolState 的 riskClass 输入信号。
 *   - **红线 3 最小权限**：高风险 / 非白名单一律不自动授权，只自动创建待审批请求。
 *   - **红线 11 陈旧即失效**：只消费 listValidForAuthorization（读时校验过期/schema变/risk变/工具下线 fail-closed）。
 *   - **自动授权禁永久**：expiresAt = now + min(whitelist.maxExpiryMs, 建议 expiresAt 余量) 且必非空。
 *   - **零-LLM 确定性**：全程规则/白名单确定性判定，不调 LLM。
 *
 * 触发：非事件驱动（授权是敏感动作，不随 capability-learned 自动 grant）——由治理/管理侧显式对某 persona 运行
 * （如 owner 在控制台点「据资格自动授权」）。桥本身不订阅 EventBus。
 */

import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';
import { CapabilityToolEligibilityStore, type EligibilityRiskClass } from '../storage/capability-tool-eligibility-store.js';
import { ToolAuthorizationRequestStore } from '../storage/tool-authorization-request-store.js';
import { resolvePersonaToolAutoAuthWhitelist, type ToolAutoAuthPolicy } from '../storage/persona-governance-store.js';
import type { ToolPermissionService } from '../agent/tool-permission-service.js';
import type { ToolRegistry } from '../agent/tool-registry.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export interface ToolAutoAuthorizationBridgeDeps {
  /** 宿主 DB（IDatabase 亦是 SyncWriteUnitOfWork——governance/permissions 与 eligibility/request 共库同源）。 */
  readonly db: IDatabase;
  readonly permissions: ToolPermissionService;
  readonly registry: ToolRegistry;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly now: () => number;
}

/** 单次桥运行结果（可审计）。 */
export interface ToolAutoAuthorizationResult {
  /** 白名单低风险 → 自动授予的 ToolPermission。 */
  readonly granted: ReadonlyArray<{ readonly toolId: string; readonly capability: string; readonly permissionId: string; readonly expiresAt: number }>;
  /** 非白名单/高风险 → 新建的待审批请求。 */
  readonly requested: ReadonlyArray<{ readonly toolId: string; readonly capability: string; readonly reason: string }>;
  /** 已有 pending 请求，本次跳过（幂等）。 */
  readonly skipped: ReadonlyArray<{ readonly toolId: string; readonly capability: string }>;
}

export class ToolAutoAuthorizationBridge {
  constructor(private readonly deps: ToolAutoAuthorizationBridgeDeps) {}

  /**
   * 据某 persona 的有效 eligibility 建议自动处理授权：白名单低风险 grant，其余建待审批。
   * @param grantedBy 授权发起者（审计 grantedBy；如 owner userId / 'governance'）
   */
  run(personaId: string, grantedBy: string): ToolAutoAuthorizationResult {
    const now = this.deps.now();
    const whitelist = resolvePersonaToolAutoAuthWhitelist(this.deps.db, this.deps.tenantId, personaId);
    const currentToolState = this.buildCurrentToolState();
    const eligibilityStore = new CapabilityToolEligibilityStore(this.deps.db, this.deps.tenantId);
    const requestStore = new ToolAuthorizationRequestStore(this.deps.db, this.deps.tenantId);
    const valid = eligibilityStore.listValidForAuthorization(personaId, now, currentToolState);

    const granted: Array<{ toolId: string; capability: string; permissionId: string; expiresAt: number }> = [];
    const requested: Array<{ toolId: string; capability: string; reason: string }> = [];
    const skipped: Array<{ toolId: string; capability: string }> = [];

    for (const e of valid) {
      const policy = whitelist[e.toolId];
      const autoGrantable = policy !== undefined && e.riskClass === 'low';
      if (autoGrantable) {
        /* 白名单 + 低风险 → 自动授予。expiresAt 取「白名单上限」与「建议剩余有效期」较小者，且必非空。 */
        const expiresAt = this.computeGrantExpiry(now, policy, e.expiresAt);
        this.deps.permissions.grant({
          tenantId: this.deps.tenantId,
          personaId,
          toolId: e.toolId,
          scope: policy.scope,
          constraints: { requireConfirmation: policy.requireConfirmation !== false },
          grantedBy,
          expiresAt,
        });
        /* grant 是 (tenant,persona,tool) upsert——冲突更新保留原 row id，grant() 返回的新 id 非落库 id。
         * 取回真实持久化 id 供审计（重复 run 同工具返回同一 permissionId，不误导）。 */
        const permissionId = this.deps.permissions.getByPersonaTool(this.deps.tenantId, personaId, e.toolId)?.id ?? '';
        granted.push({ toolId: e.toolId, capability: e.capability, permissionId, expiresAt });
      } else {
        /* 非白名单 / 高风险 → 不自动授权，建待审批请求（红线 3）。幂等：同 pending 不重复建。 */
        const reason = e.riskClass === 'high' ? 'high_risk' : 'not_whitelisted';
        const created = requestStore.createIfAbsent({
          id: generatePrefixedId('tauthreq'),
          personaId,
          capability: e.capability,
          toolId: e.toolId,
          sourceRuleVersion: e.sourceRuleVersion,
          riskClass: e.riskClass,
          reason,
          requestedAt: now,
        });
        if (created) requested.push({ toolId: e.toolId, capability: e.capability, reason });
        else skipped.push({ toolId: e.toolId, capability: e.capability });
      }
    }
    this.deps.logger.info('ToolAutoAuthorizationBridge', `persona=${personaId} 自动授予=${granted.length} 待审批=${requested.length} 跳过=${skipped.length}`);
    return { granted, requested, skipped };
  }

  /** 从工具注册表构造 currentToolState（红线 11 陈旧校验依据）：toolId → 当前 schemaVersion + riskClass。 */
  private buildCurrentToolState(): ReadonlyMap<string, { schemaVersion: string; riskClass: EligibilityRiskClass }> {
    const map = new Map<string, { schemaVersion: string; riskClass: EligibilityRiskClass }>();
    for (const adapter of this.deps.registry.list()) {
      const m = adapter.metadata;
      map.set(m.id, {
        schemaVersion: m.schemaVersion ?? 'v1',
        riskClass: m.highRisk ? 'high' : 'low',
      });
    }
    return map;
  }

  /** 计算自动授予有效期：now + min(白名单上限, 建议剩余)，保证非空且不超白名单上限（红线：自动授权禁永久）。 */
  private computeGrantExpiry(now: number, policy: ToolAutoAuthPolicy, eligibilityExpiresAt: number | null): number {
    const whitelistCap = now + policy.maxExpiryMs;
    if (eligibilityExpiresAt === null) return whitelistCap;
    return Math.min(whitelistCap, eligibilityExpiresAt);
  }
}
