/**
 * 环境观察者（ADR-0052 Edge-P1）— 把环境状态变化沉淀为事实记忆。
 *
 * 复用 ADR-0051 Phase 1 安全范式：**只 append 事实记忆（episodic），绝不自动改身份核**
 * （value/narrative/L0-L3/规则）。环境感知是确定性旁路——不调 LLM、不过蒸馏门（事实记忆
 * 直接 append，与 KnowledgeIngestionService 同），更不碰 CoreRhythmLayer 身份写方法。
 *
 * 只在**状态变化**时记一条（如 normal→dim 记「光线变暗了」），避免每窗都写造成记忆泛滥；
 * 状态不变则不记。节律/注意力集成（环境状态影响打扰阈值等）是后续 Phase，不在本切片。
 */

import type { CognitiveMemoryGraph } from '../../core/memory-graph.js';
import type { Logger } from '../../utils/logger.js';
import type { EnvironmentState, EnvironmentChannel } from './environment-signal.js';

/** 一次观察的记忆沉淀结果。 */
export interface EnvironmentObserveResult {
  /** 因状态变化写入的事实记忆 id（无变化则空）。 */
  readonly memoryIds: readonly string[];
  /** 本次各通道是否发生变化。 */
  readonly changed: readonly EnvironmentChannel[];
}

/** 各通道级别变化时的第一人称记忆模板（人格视角，非冷标签）。 */
const TRANSITION_PHRASES: Record<EnvironmentChannel, string> = {
  light: '光线',
  sound: '周围的声音',
  motion: '周围的动静',
};

export class EnvironmentObserver {
  /** 各通道上一次记入记忆的级（变化检测用）。 */
  private lastObserved: Partial<Record<EnvironmentChannel, string>> = {};

  constructor(
    private readonly memoryGraph: CognitiveMemoryGraph,
    private readonly logger?: Logger,
  ) {}

  /**
   * 观察一次环境状态：仅对发生变化的通道 append 一条事实记忆。
   * salience 取该通道置信度（低置信变化不强记）。valence 中性（环境观察不带情感判断）。
   */
  observe(state: EnvironmentState): EnvironmentObserveResult {
    const memoryIds: string[] = [];
    const changed: EnvironmentChannel[] = [];

    for (const channel of ['light', 'sound', 'motion'] as const) {
      const cs = state[channel];
      if (!cs) continue;
      const prev = this.lastObserved[channel];
      if (prev === cs.level) continue;          // 无变化 → 不记
      this.lastObserved[channel] = cs.level;
      changed.push(channel);

      /* 首次观察（prev undefined）也记一条「我注意到…」，作为环境基线。 */
      const content = prev === undefined
        ? `我注意到${TRANSITION_PHRASES[channel]}现在是「${cs.level}」`
        : `我注意到${TRANSITION_PHRASES[channel]}从「${prev}」变成了「${cs.level}」`;

      const node = this.memoryGraph.addMemory('episodic', content, 0, clamp01(cs.confidence));
      memoryIds.push(node.id);
    }

    if (memoryIds.length > 0) {
      this.logger?.info('EnvironmentObserver', `环境变化沉淀 ${memoryIds.length} 条事实记忆（${changed.join(',')}）`);
    }
    return { memoryIds, changed };
  }

  /** 重置观察基线（新会话/设备重启）。 */
  reset(): void {
    this.lastObserved = {};
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
