/**
 * 能力索引 store（ADR-0057 L7）——capability_index 表的确定性 CRUD。
 *
 * 「该 persona 学会了哪些能力」的**正式来源**（替换 L2 的 learning_requests status='passed' 扫描）：
 *   - listLearnedCapabilities：GapDetector 算缺口差集的「已学」来源（per-persona，跨 org 复用）。
 *   - upsert：由 capability-learned 事件投影写入（CapabilityIndexProjector）；同 (persona, capability) 重学
 *     = 更新分数/时间，不新增（DB 唯一索引兜底，O(索引) 幂等）。
 *   - listByPersona / getByCapability：审计 + 覆盖查询（带 examScore/learnedAt）。
 *
 * 与 LearningRequestStore 同纪律：显式写 tenant_id + 查询显式过滤 (tenant_id, persona_id, ...)（per-persona
 * 隔离，红线 8/15）。bigint 列读出统一 Number() 强转（PG node-pg 返回 string 的坑）。
 */

import type { IDatabase } from './database.js';

/** 一条能力索引（已学能力 + 审计元数据）。 */
export interface CapabilityIndexEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly capability: string;
  readonly examScore: number;
  readonly learningRequestId: string;
  readonly capabilityVersion: number;
  readonly learnedAt: number;
  readonly updatedAt: number;
}

/** upsert 入参（id 由投影方生成）。 */
export interface CapabilityIndexUpsert {
  readonly id: string;
  readonly personaId: string;
  readonly capability: string;
  readonly examScore: number;
  readonly learningRequestId: string;
  readonly capabilityVersion: number;
  readonly learnedAt: number;
  readonly updatedAt: number;
}

interface CapabilityIndexRow {
  id: string;
  persona_id: string;
  capability: string;
  exam_score: number;
  learning_request_id: string;
  capability_version: number;
  learned_at: number;
  updated_at: number;
}

function toEntry(row: CapabilityIndexRow, tenantId: string): CapabilityIndexEntry {
  return {
    id: row.id,
    tenantId,
    personaId: row.persona_id,
    capability: row.capability,
    examScore: row.exam_score,
    learningRequestId: row.learning_request_id,
    capabilityVersion: row.capability_version,
    /* bigint 列：node-pg 返回 string，必须 Number() 强转（PG bigint string coercion 坑）。 */
    learnedAt: Number(row.learned_at),
    updatedAt: Number(row.updated_at),
  };
}

export class CapabilityIndexStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
  ) {}

  /**
   * 投影写入：同 (tenant, persona, capability) 已存在则**更新**（重学=刷新分数/时间，不新增）。
   * id 仅首次插入用（ON CONFLICT 时 excluded.id 不覆盖既有 id，保持审计稳定）。
   */
  upsert(u: CapabilityIndexUpsert): void {
    this.db.prepare<void>(
      `INSERT INTO capability_index
         (id, tenant_id, persona_id, capability, exam_score, learning_request_id, capability_version, learned_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, persona_id, capability) DO UPDATE SET
         exam_score = excluded.exam_score,
         learning_request_id = excluded.learning_request_id,
         capability_version = excluded.capability_version,
         learned_at = excluded.learned_at,
         updated_at = excluded.updated_at`,
    ).run(
      u.id, this.tenantId, u.personaId, u.capability, u.examScore,
      u.learningRequestId, u.capabilityVersion, u.learnedAt, u.updatedAt,
    );
  }

  /**
   * 该 persona 已学会的能力集合——GapDetector「已学」正式来源（替换 L2 listPassedCapabilities）。
   * **persona-global**（不按 org——学会即 persona 自己的能力，跨 org 复用）。确定性排序（字典序）。
   */
  listLearnedCapabilities(personaId: string): string[] {
    const rows = this.db.prepare<{ capability: string }>(
      `SELECT capability FROM capability_index
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY capability ASC`,
    ).all(this.tenantId, personaId);
    return rows.map((r) => r.capability);
  }

  /** 列出该 persona 全部已学能力（审计/覆盖，含分数+时间）。按 learned_at 降序 + capability 稳定排序。 */
  listByPersona(personaId: string): CapabilityIndexEntry[] {
    const rows = this.db.prepare<CapabilityIndexRow>(
      `SELECT id, persona_id, capability, exam_score, learning_request_id, capability_version, learned_at, updated_at
       FROM capability_index
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY learned_at DESC, capability ASC`,
    ).all(this.tenantId, personaId);
    return rows.map((r) => toEntry(r, this.tenantId));
  }

  /** 查单项能力是否已学（覆盖查询）；未学 → undefined。 */
  getByCapability(personaId: string, capability: string): CapabilityIndexEntry | undefined {
    const row = this.db.prepare<CapabilityIndexRow>(
      `SELECT id, persona_id, capability, exam_score, learning_request_id, capability_version, learned_at, updated_at
       FROM capability_index
       WHERE tenant_id = ? AND persona_id = ? AND capability = ?`,
    ).get(this.tenantId, personaId, capability);
    return row ? toEntry(row, this.tenantId) : undefined;
  }
}
