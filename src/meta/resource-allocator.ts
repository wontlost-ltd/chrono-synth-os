/**
 * 资源分配器：管理活跃人格版本的计算资源配额
 */

import type { AllocationStrategy, ResourceAllocation } from '../types/meta-regulation.js';
import type { PersonaVersion } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';

export class ResourceAllocator {
  constructor(private readonly clock: Clock) {}

  /** 按策略分配资源 */
  allocate(
    personas: readonly PersonaVersion[],
    strategy: AllocationStrategy = 'equal',
  ): ResourceAllocation[] {
    const actives = personas.filter(p => p.status === 'active');
    if (actives.length === 0) return [];

    switch (strategy) {
      case 'equal':
        return this.allocateEqual(actives);
      case 'fitness_weighted':
        return this.allocateFitnessWeighted(actives);
      case 'priority_based':
        return this.allocatePriorityBased(actives);
      default: {
        const _exhaustive: never = strategy;
        throw new Error(`未知的分配策略: ${_exhaustive}`);
      }
    }
  }

  /** 等额分配 */
  private allocateEqual(personas: PersonaVersion[]): ResourceAllocation[] {
    const quota = 1.0 / personas.length;
    const now = this.clock.now();
    return personas.map(p => ({
      versionId: p.id,
      quota,
      strategy: 'equal' as const,
      allocatedAt: now,
    }));
  }

  /** 按适应度加权分配 */
  private allocateFitnessWeighted(personas: PersonaVersion[]): ResourceAllocation[] {
    const now = this.clock.now();
    const scores = personas.map(p => {
      const results = p.results;
      if (results.length === 0) return { persona: p, avgFitness: 0.5 };
      const raw = results.reduce((s, r) => s + r.fitnessScore, 0) / results.length;
      /* 防御性夹紧：防止损坏数据导致越界配额 */
      const avg = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
      return { persona: p, avgFitness: avg };
    });

    const totalFitness = scores.reduce((s, e) => s + e.avgFitness, 0);
    if (totalFitness === 0) return this.allocateEqual(personas);

    return scores.map(({ persona, avgFitness }) => ({
      versionId: persona.id,
      quota: Math.max(0, Math.min(1, avgFitness / totalFitness)),
      strategy: 'fitness_weighted' as const,
      allocatedAt: now,
    }));
  }

  /** 按创建时间优先分配（较早创建的获得更多资源） */
  private allocatePriorityBased(personas: PersonaVersion[]): ResourceAllocation[] {
    const now = this.clock.now();
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
}
