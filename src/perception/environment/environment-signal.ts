/**
 * 确定性环境感知 — 信号与状态类型（ADR-0052 Edge-P1）。
 *
 * 这是「确定性旁路」：与 ADR-0051 的多模态「感官老师」不同，环境感知**不调任何模型**——
 * 纯确定性 DSP 把低维传感器时间序列（光强/声压/运动）提取为离散环境状态。Edge/机器人
 * 断网时仍能感知环境，是端侧自治闭环的入口。输入是采集层（client/edge）给的信号样本，
 * 本层不碰硬件。
 */

/** 环境信号通道。第一阶段：光（lux）/ 声（声压相对值）/ 运动（强度）。 */
export type EnvironmentChannel = 'light' | 'sound' | 'motion';

/** 一个时间序列样本（采集层提供；value 为该通道的原始读数）。 */
export interface EnvironmentSample {
  readonly channel: EnvironmentChannel;
  /** 原始读数（light=lux；sound=相对声压 0..1 或 dB；motion=强度 0..1）。 */
  readonly value: number;
  /** 采样时刻（epoch ms，ADR-0029）。 */
  readonly at: number;
}

/** 某通道的离散分级（低维状态，供人格使用）。 */
export type LightLevel = 'dark' | 'dim' | 'normal' | 'bright';
export type SoundLevel = 'silent' | 'quiet' | 'moderate' | 'noisy';
export type MotionLevel = 'still' | 'slight' | 'active';

/** 单通道提取结果（聚合数值 + 离散分级 + 置信度）。 */
export interface ChannelState<L extends string = string> {
  readonly channel: EnvironmentChannel;
  /** 离散分级。 */
  readonly level: L;
  /** 窗口聚合数值（rolling average）。 */
  readonly average: number;
  /** 窗口峰值。 */
  readonly peak: number;
  /** 窗口谷值。 */
  readonly trough: number;
  /** 置信度 [0,1]：样本量越足、波动越小越高。 */
  readonly confidence: number;
  /** 参与聚合的样本数。 */
  readonly sampleCount: number;
}

/** 整体环境状态（各通道分级 + 时间窗）。 */
export interface EnvironmentState {
  readonly light?: ChannelState<LightLevel>;
  readonly sound?: ChannelState<SoundLevel>;
  readonly motion?: ChannelState<MotionLevel>;
  /** 本窗最早/最晚样本时刻。 */
  readonly windowStart: number;
  readonly windowEnd: number;
}
