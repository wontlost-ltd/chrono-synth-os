/**
 * 学习请求账本存储（ADR-0057 L2）——learning_requests 表的确定性 CRUD。
 *
 * 与 OrgWorkforceStore 同纪律：显式写 tenant_id + 查询显式过滤 (tenant_id, ...)（不依赖 TenantDatabase 注入，
 * 与既有 workforce store 一致）。per-persona 隔离：所有按 (tenant_id, persona_id, capability) 查（红线 8/15）。
 */

import type { IDatabase } from './database.js';
import type { LearningRequest, LearningRequestStatus } from '../workforce/types.js';
import { ACTIVE_LEARNING_STATUSES } from '../workforce/types.js';

interface LearningRequestRow {
  id: string;
  org_id: string;
  persona_id: string;
  capability: string;
  is_unknown: number;
  evidence: string;
  priority: string;
  triggered_by_task_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

function toRequest(row: LearningRequestRow, tenantId: string): LearningRequest {
  return {
    id: row.id,
    tenantId,
    orgId: row.org_id,
    personaId: row.persona_id,
    capability: row.capability,
    isUnknown: row.is_unknown !== 0,
    evidence: row.evidence,
    priority: row.priority as LearningRequest['priority'],
    triggeredByTaskId: row.triggered_by_task_id,
    status: row.status as LearningRequestStatus,
    /* bigint 列：node-pg 返回 string，必须 Number() 强转（PG bigint string coercion 坑）。 */
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class LearningRequestStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
  ) {}

  insert(r: Omit<LearningRequest, 'tenantId'>): void {
    this.db.prepare<void>(
      `INSERT INTO learning_requests (id, tenant_id, org_id, persona_id, capability, is_unknown, evidence, priority, triggered_by_task_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id, this.tenantId, r.orgId, r.personaId, r.capability, r.isUnknown ? 1 : 0,
      r.evidence, r.priority, r.triggeredByTaskId, r.status, r.createdAt, r.updatedAt,
    );
  }

  /**
   * 该 (persona, capability) 是否已有 **active**（pending/learning）学习请求。**persona-global**（不按 org——
   * 能力属于 persona，与哪个 org 任务暴露它无关；与 DB 部分唯一索引口径一致，Codex L2 复审）。
   * 幂等去重用：active 已存在 → 不重复登记（多个挂起任务共享一次学习，防请教风暴，红线 9）。
   */
  findActive(personaId: string, capability: string): LearningRequest | undefined {
    const placeholders = ACTIVE_LEARNING_STATUSES.map(() => '?').join(', ');
    const row = this.db.prepare<LearningRequestRow>(
      `SELECT id, org_id, persona_id, capability, is_unknown, evidence, priority, triggered_by_task_id, status, created_at, updated_at
       FROM learning_requests
       WHERE tenant_id = ? AND persona_id = ? AND capability = ? AND status IN (${placeholders})
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(this.tenantId, personaId, capability, ...ACTIVE_LEARNING_STATUSES);
    return row ? toRequest(row, this.tenantId) : undefined;
  }

  /**
   * 该 persona 已**学会**（passed）的能力集合——L2 时代的「已学能力」来源（L7 会正式化 CapabilityIndex）。
   * **persona-global**（不按 org——一旦学会就是 persona 自己的能力，跨 org 复用，不重学）。
   */
  listPassedCapabilities(personaId: string): string[] {
    const rows = this.db.prepare<{ capability: string }>(
      `SELECT DISTINCT capability FROM learning_requests
       WHERE tenant_id = ? AND persona_id = ? AND status = 'passed'
       ORDER BY capability ASC`,
    ).all(this.tenantId, personaId);
    return rows.map((r) => r.capability);
  }

  /** 按 id 取（审计/状态推进用）。 */
  getById(id: string): LearningRequest | undefined {
    const row = this.db.prepare<LearningRequestRow>(
      `SELECT id, org_id, persona_id, capability, is_unknown, evidence, priority, triggered_by_task_id, status, created_at, updated_at
       FROM learning_requests WHERE tenant_id = ? AND id = ?`,
    ).get(this.tenantId, id);
    return row ? toRequest(row, this.tenantId) : undefined;
  }

  /** 列出某 org 的学习请求（治理/审计）；可选按状态过滤。确定性排序。 */
  listByOrg(orgId: string, status?: LearningRequestStatus): LearningRequest[] {
    const rows = status
      ? this.db.prepare<LearningRequestRow>(
          `SELECT id, org_id, persona_id, capability, is_unknown, evidence, priority, triggered_by_task_id, status, created_at, updated_at
           FROM learning_requests WHERE tenant_id = ? AND org_id = ? AND status = ?
           ORDER BY created_at ASC, id ASC`,
        ).all(this.tenantId, orgId, status)
      : this.db.prepare<LearningRequestRow>(
          `SELECT id, org_id, persona_id, capability, is_unknown, evidence, priority, triggered_by_task_id, status, created_at, updated_at
           FROM learning_requests WHERE tenant_id = ? AND org_id = ?
           ORDER BY created_at ASC, id ASC`,
        ).all(this.tenantId, orgId);
    return rows.map((r) => toRequest(r, this.tenantId));
  }

  /** 推进状态（pending→learning→passed/failed/cancelled）。返回是否命中（条件 = 同 id + 当前状态匹配，防并发覆盖）。 */
  transitionStatus(id: string, fromStatus: LearningRequestStatus, toStatus: LearningRequestStatus, updatedAt: number): boolean {
    const res = this.db.prepare<void>(
      `UPDATE learning_requests SET status = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = ?`,
    ).run(toStatus, updatedAt, this.tenantId, id, fromStatus);
    return res.changes > 0;
  }
}
