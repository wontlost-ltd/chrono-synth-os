/**
 * 记忆模式提取器 — 薄适配器，委托 kernel 领域服务
 * must-think 第六节：Memory -> Pattern -> Value Shift -> Parameter Update
 */

import type { CoreValue, MemoryNode } from '../types/core-self.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import type { KernelClock, KernelLogger } from '@chrono/kernel';
import {
  DEFAULT_PATTERN_EXTRACTION_CONFIG,
  extractPatterns, patternsToProposals, extractEmotionalEvents,
} from '@chrono/kernel';
import type {
  PatternExtractionConfig, MemoryPattern, ValueUpdateProposal,
} from '@chrono/kernel';

export type { PatternExtractionConfig, MemoryPattern, ValueUpdateProposal };

/** Logger 适配：src Logger(layer, message) → KernelLogger(event) */
function toKernelLogger(logger?: Logger): KernelLogger | undefined {
  if (!logger) return undefined;
  return {
    info: (event: string) => logger.info('PatternExtractor', event),
    warn: (event: string) => logger.warn('PatternExtractor', event),
    audit: (event: string, fields: Record<string, unknown>) => logger.info('PatternExtractor', `${event} ${JSON.stringify(fields)}`),
  };
}

export class MemoryPatternExtractor {
  private readonly config: PatternExtractionConfig;
  private readonly kernelClock: KernelClock;
  private readonly kernelLogger?: KernelLogger;

  constructor(
    clock: Clock,
    logger?: Logger,
    config?: Partial<PatternExtractionConfig>,
  ) {
    this.config = { ...DEFAULT_PATTERN_EXTRACTION_CONFIG, ...config };
    this.kernelClock = { now: () => clock.now() };
    this.kernelLogger = toKernelLogger(logger);
  }

  extractPatterns(
    memories: ReadonlyMap<string, MemoryNode>,
    values: ReadonlyMap<string, CoreValue>,
  ): MemoryPattern[] {
    return extractPatterns(this.kernelClock, this.config, memories, values, this.kernelLogger);
  }

  patternsToProposals(
    patterns: readonly MemoryPattern[],
    values: ReadonlyMap<string, CoreValue>,
  ): ValueUpdateProposal[] {
    return patternsToProposals(patterns, values);
  }

  extractEmotionalEvents(
    memories: ReadonlyMap<string, MemoryNode>,
    values: ReadonlyMap<string, CoreValue>,
  ): ValueUpdateProposal[] {
    return extractEmotionalEvents(this.config, memories, values, this.kernelLogger);
  }
}
