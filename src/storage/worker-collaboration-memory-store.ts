/**
 * worker 协作记忆 store（C1：解串味）。
 *
 * per (tenant, org, worker, counterpart) 记录一个数字员工对某个**具体对手方**（同事/团队/客户）的协作
 * 历史——每个对手方一行，**互不串味**（区别于 companion_relationship 的「那一个用户」单行语义）。
 *
 * 直接走 IDatabase.prepare（轻量）。含 tenant_id → TenantDatabase 自动隔离；GDPR A 类。
 * 时间戳 bigint 用 Number() 强转（PG node-pg 返回 string）。
 */

import type { IDatabase } from './database.js';
import type { WorkerCollaborationMemory, CounterpartType } from '../workforce/types.js';

/** bigint/计数跨驱动强转：null/undefined → null，NaN → null。 */
function coerceNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class WorkerCollaborationMemoryStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
  ) {}

  /** 取一个 worker 对某 counterpart 的协作记忆；无 → undefined。 */
  get(orgId: string, workerId: string, counterpartType: CounterpartType, counterpartId: string): WorkerCollaborationMemory | undefined {
    const row = this.db.prepare<RawRow>(
      `SELECT worker_id, counterpart_type, counterpart_id, interaction_count, first_collaborated_at, last_collaborated_at, note
       FROM worker_collaboration_memory
       WHERE tenant_id = ? AND org_id = ? AND worker_id = ? AND counterpart_type = ? AND counterpart_id = ?`,
    ).get(this.tenantId, orgId, workerId, counterpartType, counterpartId);
    return row ? this.toMemory(orgId, row) : undefined;
  }

  /** 列出一个 worker 的所有协作记忆（确定性排序）。 */
  listForWorker(orgId: string, workerId: string): WorkerCollaborationMemory[] {
    const rows = this.db.prepare<RawRow>(
      `SELECT worker_id, counterpart_type, counterpart_id, interaction_count, first_collaborated_at, last_collaborated_at, note
       FROM worker_collaboration_memory
       WHERE tenant_id = ? AND org_id = ? AND worker_id = ?
       ORDER BY counterpart_type ASC, counterpart_id ASC`,
    ).all(this.tenantId, orgId, workerId);
    return rows.map((r) => this.toMemory(orgId, r));
  }

  /**
   * 记一次协作：interaction_count++，更新 last_collaborated_at；首次设 first_collaborated_at。
   * per-counterpart upsert——A 同事和 B 同事各自一行，不串味。
   */
  recordCollaboration(orgId: string, workerId: string, counterpartType: CounterpartType, counterpartId: string, now: number): void {
    this.db.prepare<void>(
      `INSERT INTO worker_collaboration_memory (tenant_id, org_id, worker_id, counterpart_type, counterpart_id, interaction_count, first_collaborated_at, last_collaborated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(tenant_id, org_id, worker_id, counterpart_type, counterpart_id) DO UPDATE SET
         interaction_count = worker_collaboration_memory.interaction_count + 1,
         /* 若行是 setNote 先建的（first 还是 null），这次首次真协作补上 first（COALESCE 保留已有）。 */
         first_collaborated_at = COALESCE(worker_collaboration_memory.first_collaborated_at, excluded.first_collaborated_at),
         last_collaborated_at = excluded.last_collaborated_at`,
    ).run(this.tenantId, orgId, workerId, counterpartType, counterpartId, now, now);
  }

  /**
   * 设协作备注（清洗控制字符/markup）。新行只写 note，**不冒充协作时间戳**（Codex 复审：设备注 ≠ 协作，
   * first/last_collaborated_at 保持 null 直到真有 recordCollaboration）。已存在行只更新 note。
   */
  setNote(orgId: string, workerId: string, counterpartType: CounterpartType, counterpartId: string, note: string, _now: number): void {
    const clean = cleanNote(note);
    this.db.prepare<void>(
      `INSERT INTO worker_collaboration_memory (tenant_id, org_id, worker_id, counterpart_type, counterpart_id, interaction_count, note)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(tenant_id, org_id, worker_id, counterpart_type, counterpart_id) DO UPDATE SET note = excluded.note`,
    ).run(this.tenantId, orgId, workerId, counterpartType, counterpartId, clean);
  }

  private toMemory(orgId: string, r: RawRow): WorkerCollaborationMemory {
    const note = r.note?.trim();
    return {
      tenantId: this.tenantId, orgId, workerId: r.worker_id,
      counterpartType: r.counterpart_type as CounterpartType, counterpartId: r.counterpart_id,
      interactionCount: coerceNumber(r.interaction_count) ?? 0,
      firstCollaboratedAt: coerceNumber(r.first_collaborated_at),
      lastCollaboratedAt: coerceNumber(r.last_collaborated_at),
      note: note && note.length > 0 ? note : null,
    };
  }
}

/** 协作备注清洗：去控制字符/尖括号，截断 200。 */
function cleanNote(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === '<' || ch === '>') continue;
    out += ch;
  }
  return out.trim().slice(0, 200);
}

interface RawRow {
  worker_id: string;
  counterpart_type: string;
  counterpart_id: string;
  interaction_count: unknown;
  first_collaborated_at: unknown;
  last_collaborated_at: unknown;
  note: string | null;
}
