/**
 * 我-你关系记忆 store（ADR-0056 类人化：关系层）。
 *
 * per (tenant, persona) 记录那个用户：名字、互动次数、第一次/最近互动时间。companion 单租户单用户。
 * 直接走 IDatabase.prepare（轻量）。含 tenant_id → TenantDatabase 自动隔离；GDPR A 类。
 */

import type { IDatabase } from './database.js';

/** 关系状态。 */
export interface Relationship {
  /** 用户的名字；undefined=还不知道。 */
  readonly userName?: string;
  /** 互动次数。 */
  readonly interactionCount: number;
  /** 第一次互动时间（epoch ms）；null=尚无。 */
  readonly firstMetAt: number | null;
  /** 最近互动时间（epoch ms）；null=尚无。 */
  readonly lastSeenAt: number | null;
}

const EMPTY: Relationship = { interactionCount: 0, firstMetAt: null, lastSeenAt: null };

export class CompanionRelationshipStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
    private readonly personaId: string = 'default',
  ) {}

  /** 取关系；无 row → 空关系。 */
  get(): Relationship {
    const row = this.db.prepare<{ user_name: string | null; interaction_count: number; first_met_at: number | null; last_seen_at: number | null }>(
      'SELECT user_name, interaction_count, first_met_at, last_seen_at FROM companion_relationship WHERE tenant_id = ? AND persona_id = ?',
    ).get(this.tenantId, this.personaId);
    if (!row) return EMPTY;
    const name = row.user_name?.trim();
    return {
      userName: name && name.length > 0 ? name : undefined,
      interactionCount: Number.isFinite(row.interaction_count) ? row.interaction_count : 0,
      firstMetAt: typeof row.first_met_at === 'number' ? row.first_met_at : null,
      lastSeenAt: typeof row.last_seen_at === 'number' ? row.last_seen_at : null,
    };
  }

  /** 记一次互动：interaction_count++，更新 last_seen_at；首次互动设 first_met_at。 */
  recordInteraction(now: number): void {
    this.db.prepare<void>(
      `INSERT INTO companion_relationship (tenant_id, persona_id, interaction_count, first_met_at, last_seen_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(tenant_id, persona_id) DO UPDATE SET
         interaction_count = companion_relationship.interaction_count + 1,
         last_seen_at = excluded.last_seen_at`,
    ).run(this.tenantId, this.personaId, now, now);
  }

  /** 设置用户名（清洗后非空才写；不动计数/时间）。 */
  setUserName(name: string, now: number): string {
    const clean = cleanName(name);
    if (clean.length === 0) throw new Error('用户名清洗后为空');
    this.db.prepare<void>(
      `INSERT INTO companion_relationship (tenant_id, persona_id, user_name, interaction_count, first_met_at, last_seen_at)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT(tenant_id, persona_id) DO UPDATE SET user_name = excluded.user_name`,
    ).run(this.tenantId, this.personaId, clean, now, now);
    return clean;
  }
}

/** 用户名清洗：去控制字符/尖括号/首尾标点，截断 40。 */
function cleanName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === '<' || ch === '>') continue;
    out += ch;
  }
  return out.replace(/^[\s，。,.!！?？、'"「」]+|[\s，。,.!！?？、'"「」]+$/g, '').trim().slice(0, 40);
}
