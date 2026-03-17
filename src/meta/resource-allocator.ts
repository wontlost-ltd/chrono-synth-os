/**
 * 资源分配器 — 薄适配器，委托 kernel 领域逻辑
 */

import type { AllocationStrategy, ResourceAllocation } from '../types/meta-regulation.js';
import type { PersonaVersion } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import type { KernelClock } from '@chrono/kernel';
import { allocateResources } from '@chrono/kernel';

export class ResourceAllocator {
  private readonly kernelClock: KernelClock;

  constructor(clock: Clock) {
    this.kernelClock = { now: () => clock.now() };
  }

  /** 按策略分配资源 */
  allocate(
    personas: readonly PersonaVersion[],
    strategy: AllocationStrategy = 'equal',
  ): ResourceAllocation[] {
    return allocateResources(this.kernelClock, personas, strategy);
  }
}
