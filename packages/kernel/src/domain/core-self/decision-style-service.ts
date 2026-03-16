/**
 * 决策风格领域服务 — 纯业务逻辑
 */

import type { KernelClock } from '../../ports/host-adapters.js';
import type { SyncReadUnitOfWork, SyncWriteUnitOfWork } from '../../ports/sync-unit-of-work.js';
import type { DecisionStyle } from './decision-style-types.js';
import { DEFAULT_DECISION_STYLE } from './decision-style-types.js';
import { decisionStyleGet, decisionStyleSetCmd } from './decision-style-queries.js';
import type { DecisionStyleRow } from './decision-style-queries.js';

/* ── 验证 ── */

export function validateDecisionStyle(style: DecisionStyle): void {
  const rangeChecks: Array<[string, number, number, number]> = [
    ['riskAppetite', style.riskAppetite, 0, 1],
    ['timeHorizon', style.timeHorizon, 0, 1],
    ['explorationBias', style.explorationBias, 0, 1],
    ['regretSensitivity', style.regretSensitivity, 0, 1],
  ];
  for (const [name, val, min, max] of rangeChecks) {
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

/* ── 领域服务函数 ── */

export function getDecisionStyle(tx: SyncReadUnitOfWork, tenantId: string): DecisionStyle {
  const row = tx.queryOne(decisionStyleGet(tenantId)) as DecisionStyleRow | null;
  if (!row || !row.styleJson) return { ...DEFAULT_DECISION_STYLE, updatedAt: 0 };
  const parsed = JSON.parse(row.styleJson) as Partial<Omit<DecisionStyle, 'updatedAt'>>;
  return { ...DEFAULT_DECISION_STYLE, ...parsed, updatedAt: row.updatedAt };
}

export function setDecisionStyle(
  tx: SyncWriteUnitOfWork,
  clock: KernelClock,
  tenantId: string,
  patch: Partial<DecisionStyle>,
): DecisionStyle {
  const current = getDecisionStyle(tx, tenantId);
  const now = clock.now();
  const next: DecisionStyle = {
    riskAppetite: patch.riskAppetite ?? current.riskAppetite,
    timeHorizon: patch.timeHorizon ?? current.timeHorizon,
    explorationBias: patch.explorationBias ?? current.explorationBias,
    lossAversion: patch.lossAversion ?? current.lossAversion,
    deliberationDepth: patch.deliberationDepth ?? current.deliberationDepth,
    regretSensitivity: patch.regretSensitivity ?? current.regretSensitivity,
    updatedAt: now,
  };
  validateDecisionStyle(next);
  const { updatedAt: _, ...payload } = next;
  tx.execute(decisionStyleSetCmd({ tenantId, styleJson: JSON.stringify(payload), updatedAt: now }));
  return next;
}
