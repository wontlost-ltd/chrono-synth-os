/**
 * 认知模型存储：维护 L3 认知结构（单例）
 */

import type { IDatabase } from '../storage/database.js';
import { mapToJson, jsonToMap } from '../storage/serialization.js';
import type { CognitiveModel } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';

interface ModelRow {
  id: number;
  model_json: string;
  updated_at: number;
}

interface ModelPayload {
  beliefs: string;
  biasWeights: string;
  attributionStyle: number;
  growthMindset: number;
}

function buildDefault(): CognitiveModel {
  return {
    beliefs: new Map<string, number>(),
    biasWeights: new Map<string, number>(),
    attributionStyle: 0.5,
    growthMindset: 0.5,
    updatedAt: 0,
  };
}

function validate(model: CognitiveModel): void {
  const checks: Array<[string, number]> = [
    ['attributionStyle', model.attributionStyle],
    ['growthMindset', model.growthMindset],
  ];
  for (const [name, val] of checks) {
    if (!Number.isFinite(val) || val < 0 || val > 1) {
      throw new RangeError(`${name} 必须在 0-1 之间，收到 ${val}`);
    }
  }
}

export class CognitiveModelStore {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
  ) {}

  /** 获取认知模型（未设置时返回默认值） */
  get(): CognitiveModel {
    const row = this.db.prepare<ModelRow>(
      'SELECT model_json, updated_at FROM cognitive_model WHERE id = 1',
    ).get();
    if (!row) return buildDefault();
    const payload = JSON.parse(row.model_json) as Partial<ModelPayload>;
    const defaults = buildDefault();
    return {
      beliefs: payload.beliefs ? jsonToMap<number>(payload.beliefs) : defaults.beliefs,
      biasWeights: payload.biasWeights ? jsonToMap<number>(payload.biasWeights) : defaults.biasWeights,
      attributionStyle: payload.attributionStyle ?? defaults.attributionStyle,
      growthMindset: payload.growthMindset ?? defaults.growthMindset,
      updatedAt: row.updated_at,
    };
  }

  /** 设置认知模型（合并更新） */
  set(patch: Partial<CognitiveModel>): CognitiveModel {
    const current = this.get();
    const now = this.clock.now();
    const next: CognitiveModel = {
      beliefs: patch.beliefs ?? current.beliefs,
      biasWeights: patch.biasWeights ?? current.biasWeights,
      attributionStyle: patch.attributionStyle ?? current.attributionStyle,
      growthMindset: patch.growthMindset ?? current.growthMindset,
      updatedAt: now,
    };
    validate(next);
    const payload: ModelPayload = {
      beliefs: mapToJson(next.beliefs),
      biasWeights: mapToJson(next.biasWeights),
      attributionStyle: next.attributionStyle,
      growthMindset: next.growthMindset,
    };
    this.db.prepare<void>(
      `INSERT INTO cognitive_model (id, model_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET model_json = excluded.model_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(payload), now);
    return next;
  }
}
