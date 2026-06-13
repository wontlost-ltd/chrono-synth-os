/**
 * 确定性环境信号提取器（ADR-0052 Edge-P1）。
 *
 * 纯确定性 DSP，**零 LLM / 零硬件 / 零外部依赖**：输入一窗传感器时间序列样本，输出离散环境
 * 状态。同输入 → 同输出（golden 可验证，为未来 WASM/MCU 确定性回放打基础）。
 *
 * 算法：
 *   ① 窗口聚合：rolling average / peak / trough。
 *   ② 阈值分级：把聚合均值映射到离散级（如 light: dark/dim/normal/bright）。
 *   ③ 去抖滞回（hysteresis）：在阈值边界设一个滞回带——若上一次的级与当前候选级相邻且均值
 *      仍落在滞回带内，则**保持上一次的级**，防止读数在阈值附近抖动导致状态反复翻转。
 *   ④ 置信度：样本量越足、窗口内波动越小（peak-trough 越窄）→ 置信度越高。
 *
 * 不持有可变状态以外的东西：唯一可变状态是「各通道上一次的级」（供滞回）。extract 是确定性
 * 函数 of (上次级, 新样本窗)。
 */

import type {
  EnvironmentChannel, EnvironmentSample, EnvironmentState, ChannelState,
  LightLevel, SoundLevel, MotionLevel,
} from './environment-signal.js';

/** 一个分级阈值表：升序的 (上界, 级名)；最后一级上界为 +∞。 */
interface Tier<L extends string> {
  readonly upTo: number;   // 均值 < upTo 即归此级（最后一档用 Infinity）
  readonly level: L;
}

/** 各通道的阈值表 + 滞回带宽（滞回带 = 阈值 ± hysteresis）。 */
interface ChannelSpec<L extends string> {
  readonly tiers: readonly Tier<L>[];
  readonly hysteresis: number;
}

/**
 * 默认阈值（可注入覆盖）。数值是合理缺省，真实部署应按设备/场景标定。
 *   light(lux)：dark<10, dim<50, normal<300, bright≥300
 *   sound(0..1 相对声压)：silent<0.05, quiet<0.2, moderate<0.5, noisy≥0.5
 *   motion(0..1 强度)：still<0.1, slight<0.4, active≥0.4
 */
const DEFAULT_LIGHT: ChannelSpec<LightLevel> = {
  tiers: [{ upTo: 10, level: 'dark' }, { upTo: 50, level: 'dim' }, { upTo: 300, level: 'normal' }, { upTo: Infinity, level: 'bright' }],
  hysteresis: 5,
};
const DEFAULT_SOUND: ChannelSpec<SoundLevel> = {
  tiers: [{ upTo: 0.05, level: 'silent' }, { upTo: 0.2, level: 'quiet' }, { upTo: 0.5, level: 'moderate' }, { upTo: Infinity, level: 'noisy' }],
  hysteresis: 0.03,
};
const DEFAULT_MOTION: ChannelSpec<MotionLevel> = {
  tiers: [{ upTo: 0.1, level: 'still' }, { upTo: 0.4, level: 'slight' }, { upTo: Infinity, level: 'active' }],
  hysteresis: 0.05,
};

export interface EnvironmentExtractorConfig {
  readonly light?: ChannelSpec<LightLevel>;
  readonly sound?: ChannelSpec<SoundLevel>;
  readonly motion?: ChannelSpec<MotionLevel>;
}

export class EnvironmentSignalExtractor {
  private readonly light: ChannelSpec<LightLevel>;
  private readonly sound: ChannelSpec<SoundLevel>;
  private readonly motion: ChannelSpec<MotionLevel>;
  /** 各通道上一次输出的级（滞回用）。 */
  private lastLevel: Partial<Record<EnvironmentChannel, string>> = {};

  constructor(config: EnvironmentExtractorConfig = {}) {
    this.light = config.light ?? DEFAULT_LIGHT;
    this.sound = config.sound ?? DEFAULT_SOUND;
    this.motion = config.motion ?? DEFAULT_MOTION;
  }

  /**
   * 提取一窗样本的环境状态。样本可混合多通道；按通道分组后各自聚合分级。
   * 空窗返回仅含时间窗的空状态。
   */
  extract(samples: readonly EnvironmentSample[]): EnvironmentState {
    const byChannel = groupByChannel(samples);
    const windowStart = samples.length ? Math.min(...samples.map((s) => s.at)) : 0;
    const windowEnd = samples.length ? Math.max(...samples.map((s) => s.at)) : 0;

    return {
      light: this.channelState('light', byChannel.light, this.light),
      sound: this.channelState('sound', byChannel.sound, this.sound),
      motion: this.channelState('motion', byChannel.motion, this.motion),
      windowStart,
      windowEnd,
    } as EnvironmentState;
  }

  /** 重置滞回记忆（新会话/设备重启）。 */
  reset(): void {
    this.lastLevel = {};
  }

  private channelState<L extends string>(
    channel: EnvironmentChannel,
    values: readonly number[] | undefined,
    spec: ChannelSpec<L>,
  ): ChannelState<L> | undefined {
    if (!values || values.length === 0) return undefined;

    const average = mean(values);
    const peak = Math.max(...values);
    const trough = Math.min(...values);

    const candidate = classify(average, spec.tiers);
    const prior = this.lastLevel[channel] as L | undefined;
    const level = applyHysteresis(average, candidate, prior, spec);
    this.lastLevel[channel] = level;

    return {
      channel,
      level,
      average,
      peak,
      trough,
      confidence: confidenceOf(values, peak, trough),
      sampleCount: values.length,
    };
  }
}

/** 按通道分组取值数组。 */
function groupByChannel(samples: readonly EnvironmentSample[]): Partial<Record<EnvironmentChannel, number[]>> {
  const out: Partial<Record<EnvironmentChannel, number[]>> = {};
  for (const s of samples) {
    if (!Number.isFinite(s.value)) continue;   // 丢弃畸形读数
    (out[s.channel] ??= []).push(s.value);
  }
  return out;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 把均值映射到离散级（第一个 upTo 大于均值的档）。 */
function classify<L extends string>(average: number, tiers: readonly Tier<L>[]): L {
  for (const t of tiers) {
    if (average < t.upTo) return t.level;
  }
  return tiers[tiers.length - 1].level;   // 兜底（最后一档 Infinity）
}

/**
 * 去抖滞回：若候选级与上一级**相邻**，且均值离「分隔两级的阈值」不足 hysteresis，则保持上一级。
 * 防止读数在阈值附近抖动导致状态反复翻转。非相邻跳变（信号显著变化）不抑制——立即切换。
 */
function applyHysteresis<L extends string>(
  average: number,
  candidate: L,
  prior: L | undefined,
  spec: ChannelSpec<L>,
): L {
  if (prior === undefined || prior === candidate) return candidate;

  const priorIdx = spec.tiers.findIndex((t) => t.level === prior);
  const candIdx = spec.tiers.findIndex((t) => t.level === candidate);
  if (priorIdx < 0 || candIdx < 0) return candidate;

  /* 仅对相邻档做滞回（差一档）；跨多档说明信号显著变化，不抑制。 */
  if (Math.abs(priorIdx - candIdx) !== 1) return candidate;

  /* 分隔 prior 与 candidate 的阈值 = 较低档的 upTo。 */
  const boundary = spec.tiers[Math.min(priorIdx, candIdx)].upTo;
  if (Math.abs(average - boundary) < spec.hysteresis) return prior;   // 落在滞回带 → 保持
  return candidate;
}

/**
 * 置信度：样本量与窗口波动的函数。
 *   - 样本越多越可信（饱和到 1）：min(sampleCount/8, 1)。
 *   - 窗口波动越小越可信：1 - 归一化波动（peak-trough 相对 |peak|+ε）。
 * 取两者乘积，clamp [0,1]。
 */
function confidenceOf(values: readonly number[], peak: number, trough: number): number {
  const sampleFactor = Math.min(values.length / 8, 1);
  const span = peak - trough;
  const scale = Math.abs(peak) + Math.abs(trough) + 1e-6;
  const stability = Math.max(0, 1 - span / scale);
  return clamp01(sampleFactor * stability);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
