/**
 * 资源分配器 — 纯领域逻辑
 * 管理活跃人格版本的计算资源配额
 * 零 node:* 依赖
 */

import type { KernelClock } from '../../ports/host-adapters.js';

/** 资源分配策略 */
export type AllocationStrategy = 'equal' | 'fitness_weighted' | 'priority_based';

/** 资源分配记录 */
export interface ResourceAllocation {
  readonly versionId: string;
  readonly quota: number;
  readonly strategy: AllocationStrategy;
  readonly allocatedAt: number;
}

/** 人格版本的最小接口（仅包含分配所需字段） */
export interface AllocatablePersona {
  readonly id: string;
  readonly status: 'active' | 'paused' | 'completed' | 'failed';
  readonly createdAt: number;
  readonly results: readonly { fitnessScore: number }[];
}

/** 等额分配 */
function allocateEqual(personas: readonly AllocatablePersona[], now: number): ResourceAllocation[] {
  const quota = 1.0 / personas.length;
  return personas.map(p => ({
    versionId: p.id,
    quota,
    strategy: 'equal' as const,
    allocatedAt: now,
  }));
}

/** 按适应度加权分配 */
function allocateFitnessWeighted(personas: readonly AllocatablePersona[], now: number): ResourceAllocation[] {
  const scores = personas.map(p => {
    const results = p.results;
    if (results.length === 0) return { persona: p, avgFitness: 0.5 };
    const raw = results.reduce((s, r) => s + r.fitnessScore, 0) / results.length;
    const avg = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
    return { persona: p, avgFitness: avg };
  });

  const totalFitness = scores.reduce((s, e) => s + e.avgFitness, 0);
  if (totalFitness === 0) return allocateEqual(personas, now);

  return scores.map(({ persona, avgFitness }) => ({
    versionId: persona.id,
    quota: Math.max(0, Math.min(1, avgFitness / totalFitness)),
    strategy: 'fitness_weighted' as const,
    allocatedAt: now,
  }));
}

/** 按创建时间优先分配（较早创建的获得更多资源） */
function allocatePriorityBased(personas: readonly AllocatablePersona[], now: number): ResourceAllocation[] {
  const sorted = [...personas].sort((a, b) => a.createdAt - b.createdAt);
  const total = sorted.length;
  const weights = sorted.map((_, i) => total - i);
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  return sorted.map((p, i) => ({
    versionId: p.id,
    quota: weights[i] / totalWeight,
    strategy: 'priority_based' as const,
    allocatedAt: now,
  }));
}

/**
 * 按策略分配资源（纯函数）
 * 仅处理 active 状态的人格版本
 */
export function allocateResources(
  clock: KernelClock,
  personas: readonly AllocatablePersona[],
  strategy: AllocationStrategy = 'equal',
): ResourceAllocation[] {
  const actives = personas.filter(p => p.status === 'active');
  if (actives.length === 0) return [];

  const now = clock.now();
  switch (strategy) {
    case 'equal':
      return allocateEqual(actives, now);
    case 'fitness_weighted':
      return allocateFitnessWeighted(actives, now);
    case 'priority_based':
      return allocatePriorityBased(actives, now);
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`未知的分配策略: ${_exhaustive}`);
    }
  }
}
