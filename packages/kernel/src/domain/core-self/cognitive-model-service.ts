/**
 * 认知模型领域服务 — 纯业务逻辑
 */

import type { KernelClock } from '../../ports/host-adapters.js';
import type { SyncReadUnitOfWork, SyncWriteUnitOfWork } from '../../ports/sync-unit-of-work.js';
import type { CognitiveModel } from './cognitive-model-types.js';
import { cognitiveModelGet, cognitiveModelSetCmd } from './cognitive-model-queries.js';
import type { CognitiveModelRow } from './cognitive-model-queries.js';

/* ── Map ↔ JSON 纯工具（无 node:* 依赖） ── */

function mapToJson<V>(map: ReadonlyMap<string, V>): string {
  return JSON.stringify(Object.fromEntries(map));
}

function jsonToMap<V>(json: string): Map<string, V> {
  try {
    return new Map(Object.entries(JSON.parse(json) as Record<string, V>));
  } catch {
    return new Map<string, V>();
  }
}

/* ── 验证 ── */

export function validateCognitiveModel(model: CognitiveModel): void {
  const checks: Array<[string, number]> = [
    ['attributionStyle', model.attributionStyle],
    ['growthMindset', model.growthMindset],
    ['ambiguityTolerance', model.ambiguityTolerance],
    ['analyticalIntuitive', model.analyticalIntuitive],
  ];
  for (const [name, val] of checks) {
    if (!Number.isFinite(val) || val < 0 || val > 1) {
      throw new RangeError(`${name} 必须在 0-1 之间，收到 ${val}`);
    }
  }
}

function buildDefault(): CognitiveModel {
  return {
    beliefs: new Map<string, number>(),
    biasWeights: new Map<string, number>(),
    attributionStyle: 0.5,
    growthMindset: 0.5,
    ambiguityTolerance: 0.5,
    analyticalIntuitive: 0.5,
    updatedAt: 0,
  };
}

interface CognitiveModelPayload {
  beliefs: string;
  biasWeights: string;
  attributionStyle: number;
  growthMindset: number;
  ambiguityTolerance: number;
  analyticalIntuitive: number;
}

/* ── 领域服务函数 ── */

export function getCognitiveModel(tx: SyncReadUnitOfWork, tenantId: string): CognitiveModel {
  const row = tx.queryOne(cognitiveModelGet(tenantId)) as CognitiveModelRow | null;
  if (!row || !row.modelJson) return buildDefault();
  const payload = JSON.parse(row.modelJson) as Partial<CognitiveModelPayload>;
  const defaults = buildDefault();
  return {
    beliefs: payload.beliefs ? jsonToMap<number>(payload.beliefs) : defaults.beliefs,
    biasWeights: payload.biasWeights ? jsonToMap<number>(payload.biasWeights) : defaults.biasWeights,
    attributionStyle: payload.attributionStyle ?? defaults.attributionStyle,
    growthMindset: payload.growthMindset ?? defaults.growthMindset,
    /* 旧 row 无新字段 → 回退默认 0.5（向后兼容，已落库的认知模型不需迁移）。 */
    ambiguityTolerance: payload.ambiguityTolerance ?? defaults.ambiguityTolerance,
    analyticalIntuitive: payload.analyticalIntuitive ?? defaults.analyticalIntuitive,
    updatedAt: row.updatedAt,
  };
}

export function setCognitiveModel(
  tx: SyncWriteUnitOfWork,
  clock: KernelClock,
  tenantId: string,
  patch: Partial<CognitiveModel>,
): CognitiveModel {
  const current = getCognitiveModel(tx, tenantId);
  const now = clock.now();
  const next: CognitiveModel = {
    beliefs: patch.beliefs ?? current.beliefs,
    biasWeights: patch.biasWeights ?? current.biasWeights,
    attributionStyle: patch.attributionStyle ?? current.attributionStyle,
    growthMindset: patch.growthMindset ?? current.growthMindset,
    ambiguityTolerance: patch.ambiguityTolerance ?? current.ambiguityTolerance,
    analyticalIntuitive: patch.analyticalIntuitive ?? current.analyticalIntuitive,
    updatedAt: now,
  };
  validateCognitiveModel(next);
  const payload: CognitiveModelPayload = {
    beliefs: mapToJson(next.beliefs),
    biasWeights: mapToJson(next.biasWeights),
    attributionStyle: next.attributionStyle,
    growthMindset: next.growthMindset,
    ambiguityTolerance: next.ambiguityTolerance,
    analyticalIntuitive: next.analyticalIntuitive,
  };
  tx.execute(cognitiveModelSetCmd({ tenantId, modelJson: JSON.stringify(payload), updatedAt: now }));
  return next;
}
