/**
 * 决策风格存储：维护 L2 决策风格（单例）
 */

import type { IDatabase } from '../storage/database.js';
import type { DecisionStyle } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';

interface StyleRow {
  tenant_id: string;
  style_json: string;
  updated_at: number;
}

/** 决策风格默认值 */
export const DEFAULT_DECISION_STYLE: Omit<DecisionStyle, 'updatedAt'> = {
  riskAppetite: 0.5,
  timeHorizon: 0.5,
  explorationBias: 0.3,
  lossAversion: 2.0,
  deliberationDepth: 3,
  regretSensitivity: 0.5,
};

function validate(style: DecisionStyle): void {
  const checks: Array<[string, number, number, number]> = [
    ['riskAppetite', style.riskAppetite, 0, 1],
    ['timeHorizon', style.timeHorizon, 0, 1],
    ['explorationBias', style.explorationBias, 0, 1],
    ['regretSensitivity', style.regretSensitivity, 0, 1],
  ];
  for (const [name, val, min, max] of checks) {
    if (!Number.isFinite(val) || val < min || val > max) {
      throw new RangeError(`${name} 必须在 ${min}-${max} 之间，收到 ${val}`);
    }
  }
  if (!Number.isFinite(style.lossAversion) || style.lossAversion < 1) {
    throw new RangeError(`lossAversion 必须 >= 1，收到 ${style.lossAversion}`);
  }
  if (!Number.isInteger(style.deliberationDepth) || style.deliberationDepth < 1 || style.deliberationDepth > 5) {
    throw new RangeError(`deliberationDepth 必须为 1-5 的整数，收到 ${style.deliberationDepth}`);
  }
}

export class DecisionStyleStore {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
  ) {}

  /** 获取决策风格（未设置时返回默认值） */
  get(): DecisionStyle {
    const row = this.db.prepare<StyleRow>(
      `SELECT style_json, updated_at FROM decision_style WHERE tenant_id = 'default'`,
    ).get();
    if (!row) return { ...DEFAULT_DECISION_STYLE, updatedAt: 0 };
    const parsed = JSON.parse(row.style_json) as Partial<Omit<DecisionStyle, 'updatedAt'>>;
    return { ...DEFAULT_DECISION_STYLE, ...parsed, updatedAt: row.updated_at };
  }

  /** 设置决策风格（合并更新） */
  set(patch: Partial<DecisionStyle>): DecisionStyle {
    const current = this.get();
    const now = this.clock.now();
    const next: DecisionStyle = {
      riskAppetite: patch.riskAppetite ?? current.riskAppetite,
      timeHorizon: patch.timeHorizon ?? current.timeHorizon,
      explorationBias: patch.explorationBias ?? current.explorationBias,
      lossAversion: patch.lossAversion ?? current.lossAversion,
      deliberationDepth: patch.deliberationDepth ?? current.deliberationDepth,
      regretSensitivity: patch.regretSensitivity ?? current.regretSensitivity,
      updatedAt: now,
    };
    validate(next);
    const { updatedAt: _, ...payload } = next;
    this.db.prepare<void>(
      `INSERT INTO decision_style (tenant_id, style_json, updated_at) VALUES ('default', ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET style_json = excluded.style_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(payload), now);
    return next;
  }
}
