/**
 * 分身投影引擎 — 纯领域逻辑
 * 将 L0-L4 核心状态与行为覆盖参数合并，产出场景化投影
 * 零 node:* 依赖
 */

import type { PersonaOSState } from '../core-self/persona-os-types.js';
import type { CoreValue } from '../core-self/value-types.js';
import type { Avatar, BehaviorOverrides } from './types.js';
import { clamp, clamp01 } from '../math.js';

const MAX_WEIGHT_OFFSET = 0.3;

/** 将 L0-L4 + Avatar overrides 合并为投影状态 */
export function computeProjection(base: PersonaOSState, avatar: Avatar): PersonaOSState {
  const overrides = avatar.behaviorOverrides;
  if (!overrides) return base;

  return {
    L0: base.L0,
    L1: applyValueOverrides(base.L1, overrides.valueWeightAdjustments),
    L2: applyDecisionStyleOverrides(base.L2, overrides.decisionStyleOverrides),
    L3: applyContextBeliefs(base.L3, overrides.contextBeliefs),
    L4: applyMemoryFilter(base.L4, overrides.memoryFilter),
  };
}

function applyValueOverrides(
  values: PersonaOSState['L1'],
  adjustments?: Record<string, number>,
): PersonaOSState['L1'] {
  if (!adjustments || Object.keys(adjustments).length === 0) return values;

  const result = new Map(values);
  for (const [id, offset] of Object.entries(adjustments)) {
    const existing = result.get(id);
    if (!existing) continue;
    const clampedOffset = clamp(offset, -MAX_WEIGHT_OFFSET, MAX_WEIGHT_OFFSET);
    const adjusted: CoreValue = {
      ...existing,
      weight: clamp01(existing.weight + clampedOffset),
    };
    result.set(id, adjusted);
  }
  return result;
}

function applyDecisionStyleOverrides(
  style: PersonaOSState['L2'],
  overrides?: BehaviorOverrides['decisionStyleOverrides'],
): PersonaOSState['L2'] {
  if (!overrides) return style;
  return {
    ...style,
    ...(overrides.riskAppetite !== undefined ? { riskAppetite: clamp01(overrides.riskAppetite) } : {}),
    ...(overrides.timeHorizon !== undefined ? { timeHorizon: clamp01(overrides.timeHorizon) } : {}),
    ...(overrides.explorationBias !== undefined ? { explorationBias: clamp01(overrides.explorationBias) } : {}),
  };
}

function applyContextBeliefs(
  model: PersonaOSState['L3'],
  beliefs?: Record<string, number>,
): PersonaOSState['L3'] {
  if (!beliefs || Object.keys(beliefs).length === 0) return model;

  const merged = new Map(model.beliefs);
  for (const [key, value] of Object.entries(beliefs)) {
    merged.set(key, clamp01(value));
  }
  return { ...model, beliefs: merged };
}

function applyMemoryFilter(
  l4: PersonaOSState['L4'],
  filter?: BehaviorOverrides['memoryFilter'],
): PersonaOSState['L4'] {
  if (!filter) return l4;

  const allowedKinds = filter.kinds ? new Set<string>(filter.kinds) : null;
  const minSalience = filter.minSalience ?? 0;

  if (!allowedKinds && minSalience <= 0) return l4;

  const filtered = new Map<string, typeof l4.memories extends ReadonlyMap<string, infer V> ? V : never>();
  for (const [id, mem] of l4.memories) {
    if (allowedKinds && !allowedKinds.has(mem.kind)) continue;
    if (mem.salience < minSalience) continue;
    filtered.set(id, mem);
  }

  return { ...l4, memories: filtered };
}
