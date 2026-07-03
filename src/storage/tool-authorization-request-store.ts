/**
 * 工具授权待审批请求存储（ADR-0060 T5）——tool_authorization_requests 表读写适配器。
 *
 * T5 自动授权桥对**不在治理白名单 / 高风险**的有效 eligibility 建议，不自动授权，只创建一条待审批请求
 * （红线 3：高风险/外部副作用工具自动授权一律禁止，只能自动创建待审批请求，由人工/治理决定）。含 tenant_id
 * → TenantDatabase 自动隔离。同 (tenant, persona, capability, tool_id) 只一个 pending（部分唯一索引防堆积）。
 *
 * ⚠️ bigint 列（requested_at/decided_at）：SQLite 返回 number，Postgres node-pg 返回 string——统一 Number()
 * 强转 + null 守卫（PG bigint string coercion 陷阱，见既有 store 同纪律）。
 */

import type { IDatabase } from './database.js';

export type ToolAuthorizationRequestStatus = 'pending' | 'approved' | 'rejected';

interface ToolAuthorizationRequestRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly capability: string;
  readonly tool_id: string;
  readonly source_rule_version: string;
  readonly risk_class: string;
  readonly reason: string;
  readonly status: string;
  readonly requested_at: number | string;
  readonly decided_at: number | string | null;
  readonly decided_by: string | null;
}

export interface ToolAuthorizationRequest {
  readonly id: string;
  readonly personaId: string;
  readonly capability: string;
  readonly toolId: string;
  readonly sourceRuleVersion: string;
  readonly riskClass: string;
  readonly reason: string;
  readonly status: ToolAuthorizationRequestStatus;
  readonly requestedAt: number;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
}

export interface CreateToolAuthorizationRequestInput {
  readonly id: string;
  readonly personaId: string;
  readonly capability: string;
  readonly toolId: string;
  readonly sourceRuleVersion: string;
  readonly riskClass: string;
  readonly reason: string;
  readonly requestedAt: number;
}

export class ToolAuthorizationRequestStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
  ) {}

  /**
   * 创建待审批请求（幂等）：若同 (persona, capability, tool_id) 已有 pending 请求，不重复创建（返回 false）。
   * 靠部分唯一索引 + 先查后插；插入撞索引（并发）也吞掉当作幂等。返回是否新建。
   */
  createIfAbsent(input: CreateToolAuthorizationRequestInput): boolean {
    const existing = this.db.prepare<{ id: string }>(
      `SELECT id FROM tool_authorization_requests
       WHERE tenant_id = ? AND persona_id = ? AND capability = ? AND tool_id = ? AND status = 'pending'`,
    ).get(this.tenantId, input.personaId, input.capability, input.toolId);
    if (existing) return false;
    try {
      this.db.prepare<void>(
        `INSERT INTO tool_authorization_requests
          (id, tenant_id, persona_id, capability, tool_id, source_rule_version, risk_class, reason, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(
        input.id, this.tenantId, input.personaId, input.capability, input.toolId,
        input.sourceRuleVersion, input.riskClass, input.reason, input.requestedAt,
      );
      return true;
    } catch (err) {
      /* 并发：两个调用同时过了「先查」再插，第二个撞 pending 部分唯一索引。吞掉当幂等（已有等价 pending）。 */
      if (err instanceof Error && /UNIQUE|unique|constraint/i.test(err.message)) return false;
      throw err;
    }
  }

  /** 取某 persona 全部 pending 请求（审批人消费）。 */
  listPending(personaId: string): ToolAuthorizationRequest[] {
    const rows = this.db.prepare<ToolAuthorizationRequestRow>(
      `SELECT * FROM tool_authorization_requests
       WHERE tenant_id = ? AND persona_id = ? AND status = 'pending'`,
    ).all(this.tenantId, personaId);
    return rows.map((r) => this.toEntry(r));
  }

  /** 决议一条 pending 请求（approved/rejected）；仅 pending → 目标状态（防重复决议）。返回是否改动。 */
  decide(id: string, status: 'approved' | 'rejected', decidedBy: string, decidedAt: number): boolean {
    const r = this.db.prepare<void>(
      `UPDATE tool_authorization_requests SET status = ?, decided_at = ?, decided_by = ?
       WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
    ).run(status, decidedAt, decidedBy, this.tenantId, id);
    return r.changes > 0;
  }

  private toEntry(r: ToolAuthorizationRequestRow): ToolAuthorizationRequest {
    return {
      id: r.id,
      personaId: r.persona_id,
      capability: r.capability,
      toolId: r.tool_id,
      sourceRuleVersion: r.source_rule_version,
      riskClass: r.risk_class,
      reason: r.reason,
      status: r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending',
      requestedAt: Number(r.requested_at),
      decidedAt: r.decided_at === null ? null : Number(r.decided_at),
      decidedBy: r.decided_by,
    };
  }
}
