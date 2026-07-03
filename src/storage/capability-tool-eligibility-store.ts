/**
 * 能力→工具授权资格投影存储（ADR-0060 T4）——capability_tool_eligibility 表读写适配器。
 *
 * 一条 eligibility = 「某 persona 学会某 capability 后，对某已过工具考试的 tool，*建议*可授权」——
 * **只建议，不 grant**（红线 2/12：capability≠permission，eligibility≠allow）。ToolEligibilityProjector
 * 订阅 capability-learned 事件，据活跃 tool_action_rule 的溯源产出/替换建议；执行门/授权服务**绝不**读本表当
 * allow 条件（只驱动建议 / 待审批请求）。含 tenant_id → TenantDatabase 自动隔离。
 *
 * ⚠️ bigint 列（recommended_at/expires_at）：SQLite 返回 number，Postgres node-pg 返回 string——统一 Number()
 * 强转 + null 守卫（PG bigint string coercion 陷阱，见既有 store 同纪律）。
 */

import type { IDatabase } from './database.js';

/** 风险类（红线 11 溯源 + 失效判定）；红线 13：非授权依据。 */
export type EligibilityRiskClass = 'high' | 'low';

interface CapabilityToolEligibilityRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly capability: string;
  readonly tool_id: string;
  readonly schema_version: string;
  readonly source_rule_version: string;
  readonly exam_spec_version: string;
  readonly risk_class: string;
  readonly constraints_hash: string;
  readonly recommended_at: number | string;
  readonly expires_at: number | string | null;
  readonly active: number;
}

/** 一条 eligibility 建议（领域对象）。 */
export interface CapabilityToolEligibility {
  readonly id: string;
  readonly personaId: string;
  readonly capability: string;
  readonly toolId: string;
  readonly schemaVersion: string;
  readonly sourceRuleVersion: string;
  readonly examSpecVersion: string;
  readonly riskClass: EligibilityRiskClass;
  readonly constraintsHash: string;
  readonly recommendedAt: number;
  readonly expiresAt: number | null;
  readonly active: boolean;
}

/** upsert 输入（红线 11 元数据齐全）。 */
export interface UpsertCapabilityToolEligibilityInput {
  readonly id: string;
  readonly personaId: string;
  readonly capability: string;
  readonly toolId: string;
  readonly schemaVersion: string;
  readonly sourceRuleVersion: string;
  readonly examSpecVersion: string;
  readonly riskClass: EligibilityRiskClass;
  readonly constraintsHash: string;
  readonly recommendedAt: number;
  readonly expiresAt: number | null;
}

export class CapabilityToolEligibilityStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
  ) {}

  /**
   * upsert 一条建议：同 (tenant, persona, capability, tool_id) 的 active 建议至多一条——先停旧 active 再插新，
   * 保证部分唯一索引 WHERE active=1 恒单条（新建议替换旧，历史留档 active=0 供审计）。
   * 红线 11 元数据强制齐全（fail-closed 兜底：绕过 projector 直调也拒无溯源建议）。
   */
  upsert(input: UpsertCapabilityToolEligibilityInput): void {
    if (typeof input.examSpecVersion !== 'string' || input.examSpecVersion.length === 0) {
      throw new Error('capability_tool_eligibility.exam_spec_version 不得为空（红线 11 溯源）');
    }
    if (input.riskClass !== 'high' && input.riskClass !== 'low') {
      throw new Error(`capability_tool_eligibility.risk_class 必须为 'high'|'low'，得到「${String(input.riskClass)}」`);
    }
    this.db.transaction(() => {
      this.db.prepare<void>(
        `UPDATE capability_tool_eligibility SET active = 0
         WHERE tenant_id = ? AND persona_id = ? AND capability = ? AND tool_id = ? AND active = 1`,
      ).run(this.tenantId, input.personaId, input.capability, input.toolId);
      this.db.prepare<void>(
        `INSERT INTO capability_tool_eligibility
          (id, tenant_id, persona_id, capability, tool_id, schema_version, source_rule_version,
           exam_spec_version, risk_class, constraints_hash, recommended_at, expires_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        input.id, this.tenantId, input.personaId, input.capability, input.toolId, input.schemaVersion,
        input.sourceRuleVersion, input.examSpecVersion, input.riskClass, input.constraintsHash,
        input.recommendedAt, input.expiresAt,
      );
    });
  }

  /**
   * 取某 persona 全部 active 建议（**审计用**：返回 active=1 全量，不过滤过期，用于查看历史/巡检）。
   * ⚠️ 授权/自动授权桥（T5）**禁**直接消费本方法——active≠currently-valid（可能已过期或工具已变）。
   * 消费建议须用 listValidForAuthorization（读时 fail-closed 校验陈旧）。
   */
  listActive(personaId: string): CapabilityToolEligibility[] {
    const rows = this.db.prepare<CapabilityToolEligibilityRow>(
      `SELECT * FROM capability_tool_eligibility
       WHERE tenant_id = ? AND persona_id = ? AND active = 1`,
    ).all(this.tenantId, personaId);
    return rows.map((r) => this.toEntry(r));
  }

  /**
   * 取「当前仍有效」的建议（红线 11 陈旧即失效**消费侧闭环**）——授权/白名单桥（T5）唯一合法消费入口。
   * 读时对每条 active 建议做 fail-closed 校验，任一不符即排除（不返回给授权侧）：
   *   - **无有效期 / 过期**：expiresAt 为 null 或 now ≥ expiresAt → 失效（授权侧不接受永不过期建议，Codex T4 复审补）；
   *   - **tool schema 变化**：建议记录的 schemaVersion ≠ 该 tool 当前 schemaVersion → 失效（防陈旧建议授权已变工具）；
   *   - **riskClass 变化**：建议记录的 riskClass ≠ 该 tool 当前 riskClass → 失效（防低险建议在工具升为高险后仍被用）。
   * currentToolState 由消费方从 tool registry 当前状态提供（key=toolId）；registry 无此 tool（已下线）→ 一并 fail-closed 排除。
   * 「变化即失效」用**读时校验**落地（不依赖 registry 变更事件源，见 ADR 实现规格备注：检测触发点=消费时比对当前状态）。
   */
  listValidForAuthorization(
    personaId: string,
    now: number,
    currentToolState: ReadonlyMap<string, { readonly schemaVersion: string; readonly riskClass: EligibilityRiskClass }>,
  ): CapabilityToolEligibility[] {
    return this.listActive(personaId).filter((e) => {
      if (e.expiresAt === null || now >= e.expiresAt) return false;   /* 无有效期 / 已过期 → fail-closed（授权侧不接受永不过期建议） */
      const cur = currentToolState.get(e.toolId);
      if (cur === undefined) return false;                            /* 工具已下线 fail-closed */
      if (cur.schemaVersion !== e.schemaVersion) return false;        /* schema 变化失效 */
      if (cur.riskClass !== e.riskClass) return false;                /* riskClass 变化失效 */
      return true;
    });
  }

  private toEntry(r: CapabilityToolEligibilityRow): CapabilityToolEligibility {
    return {
      id: r.id,
      personaId: r.persona_id,
      capability: r.capability,
      toolId: r.tool_id,
      schemaVersion: r.schema_version,
      sourceRuleVersion: r.source_rule_version,
      examSpecVersion: r.exam_spec_version,
      riskClass: r.risk_class === 'high' ? 'high' : 'low',
      constraintsHash: r.constraints_hash,
      recommendedAt: Number(r.recommended_at),
      expiresAt: r.expires_at === null ? null : Number(r.expires_at),
      active: r.active === 1,
    };
  }
}
