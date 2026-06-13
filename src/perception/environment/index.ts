/**
 * 确定性环境感知（ADR-0052 Edge-P1）— Edge/机器人端侧自治闭环的入口。
 * 纯确定性旁路：低维传感器信号 → 环境状态 → 事实记忆，零 LLM/零硬件。
 */

export type {
  EnvironmentChannel, EnvironmentSample, EnvironmentState, ChannelState,
  LightLevel, SoundLevel, MotionLevel,
} from './environment-signal.js';
export {
  EnvironmentSignalExtractor, type EnvironmentExtractorConfig,
} from './environment-signal-extractor.js';
export {
  EnvironmentObserver, type EnvironmentObserveResult,
} from './environment-observer.js';
