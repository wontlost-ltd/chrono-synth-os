/**
 * 数字人当前心情 store（ADR-0056 类人化）。
 *
 * per (tenant_id, persona_id) 存当前心情（valence/arousal/updated_at）。心情随对话确定性漂移，
 * 持久化（重启后心情还在）。无 row → DEFAULT_MOOD（中性）。
 *
 * 直接走 IDatabase.prepare（与 companion-identity-store 同款轻量），含 tenant_id → TenantDatabase
 * 自动隔离；GDPR A 类。
 */

import type { IDatabase } from './database.js';
import { DEFAULT_MOOD, type Mood } from '../conversation/mood.js';

export class CompanionMoodStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
    private readonly personaId: string = 'default',
  ) {}

  /** 取当前心情 + 上次更新时间；无 row → DEFAULT_MOOD（updatedAt=null 表示从未更新）。 */
  get(): { mood: Mood; updatedAt: number | null } {
    const row = this.db.prepare<{ valence: number; arousal: number; updated_at: number }>(
      'SELECT valence, arousal, updated_at FROM companion_mood WHERE tenant_id = ? AND persona_id = ?',
    ).get(this.tenantId, this.personaId);
    if (!row) return { mood: DEFAULT_MOOD, updatedAt: null };
    return {
      mood: {
        valence: clampRange(row.valence, -1, 1),
        arousal: clampRange(row.arousal, 0, 1),
      },
      updatedAt: typeof row.updated_at === 'number' ? row.updated_at : null,
    };
  }

  /** upsert 当前心情。 */
  set(mood: Mood, now: number): void {
    this.db.prepare<void>(
      `INSERT INTO companion_mood (tenant_id, persona_id, valence, arousal, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, persona_id) DO UPDATE SET
         valence = excluded.valence, arousal = excluded.arousal, updated_at = excluded.updated_at`,
    ).run(this.tenantId, this.personaId, clampRange(mood.valence, -1, 1), clampRange(mood.arousal, 0, 1), now);
  }
}

/** 落库/读出时再夹一次范围（防脏数据）。 */
function clampRange(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : (lo + hi) / 2;
}
