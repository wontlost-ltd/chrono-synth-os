/**
 * 感知节律派生（ADR-0051 Phase 4 节律集成 / ADR-0052 Edge-P1 后续）。
 *
 * 把确定性环境状态（光/声/动）映射为人格的「节律提示」——一个低维 energy/tempo 信号，供节律敏感的
 * 人格（如音乐人格：吵闹+活跃环境 → 高能量/快节拍；安静+静止 → 平静/慢节拍）读取来调自己的表达节奏。
 *
 * **纯确定性、无 LLM、无身份写**：这是确定性旁路的延伸，和 EnvironmentObserver 同范式——只**派生**
 * 一个只读信号，绝不调 CoreRhythmLayer 身份写方法、绝不过蒸馏门。consumer（route / 人格）按需读，
 * 不读就零成本。置信度低（环境数据不足）时退回中性节律，不瞎猜。
 */

import type { EnvironmentState, SoundLevel, MotionLevel } from './environment-signal.js';

/** 节律分级（人格表达节奏的离散提示）。 */
export type RhythmTempo = 'calm' | 'steady' | 'lively';

export interface RhythmState {
  /** 能量 [0,1]：环境唤起度（吵闹+活跃高，安静+静止低）。 */
  readonly energy: number;
  /** 离散节律：由 energy 分级（<0.34 calm / <0.67 steady / 否则 lively）。 */
  readonly tempo: RhythmTempo;
  /** 主导来源：哪个通道加权能量最大（数据不足/能量全 0 为 null）。 */
  readonly dominantChannel: 'sound' | 'motion' | null;
  /** 派生可信度 [0,1]：参与派生的通道置信度均值。tempo **不**受此门控（直接由 energy 决定）；
   * consumer 按需用 confidence 降权/忽略低质派生。 */
  readonly confidence: number;
}

/** 声级 → 能量贡献 [0,1]。 */
const SOUND_ENERGY: Record<SoundLevel, number> = {
  silent: 0, quiet: 0.25, moderate: 0.6, noisy: 1,
};

/** 动级 → 能量贡献 [0,1]。 */
const MOTION_ENERGY: Record<MotionLevel, number> = {
  still: 0, slight: 0.4, active: 1,
};

const NEUTRAL: RhythmState = { energy: 0.5, tempo: 'steady', dominantChannel: null, confidence: 0 };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function tempoFor(energy: number): RhythmTempo {
  if (energy < 0.34) return 'calm';
  if (energy < 0.67) return 'steady';
  return 'lively';
}

/**
 * 从环境状态派生节律提示。
 *
 * energy = 声/动两通道能量的**置信度加权平均**（高置信通道主导，缺通道不参与）。两通道都缺或总置信
 * 为 0 → 退回中性（steady, confidence 0），绝不用 0 能量装成「平静」误导音乐人格。
 * dominantChannel = 加权能量更大的那个通道。
 */
export function deriveRhythmState(env: EnvironmentState): RhythmState {
  const contributions: Array<{ channel: 'sound' | 'motion'; energy: number; confidence: number }> = [];
  if (env.sound) contributions.push({ channel: 'sound', energy: SOUND_ENERGY[env.sound.level], confidence: clamp01(env.sound.confidence) });
  if (env.motion) contributions.push({ channel: 'motion', energy: MOTION_ENERGY[env.motion.level], confidence: clamp01(env.motion.confidence) });

  const totalConfidence = contributions.reduce((s, c) => s + c.confidence, 0);
  if (totalConfidence === 0) return NEUTRAL;

  const energy = clamp01(
    contributions.reduce((s, c) => s + c.energy * c.confidence, 0) / totalConfidence,
  );
  const meanConfidence = clamp01(totalConfidence / contributions.length);

  /* 主导通道：加权能量（energy*confidence）最大者。能量全 0（安静+静止）时无主导，返 null
   * （否则任意落到 sound，语义误导）。 */
  const dominant = contributions
    .slice()
    .sort((a, b) => b.energy * b.confidence - a.energy * a.confidence)[0];
  const dominantChannel = dominant && dominant.energy * dominant.confidence > 0 ? dominant.channel : null;

  /* tempo 直接跟随 energy（energy 本身就是可靠信号）；confidence 单独如实报出，由 consumer 自行
   * 权衡（不在此处用 confidence 把低能量误盖成 steady——那会让真正安静的环境永远到不了 calm，因为
   * 近零读数在 extractor 的相对方差置信公式下天然低置信）。 */
  return {
    energy,
    tempo: tempoFor(energy),
    dominantChannel,
    confidence: meanConfidence,
  };
}
